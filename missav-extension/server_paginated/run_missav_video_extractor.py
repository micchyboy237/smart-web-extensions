import asyncio
import logging
import re
import time
from typing import Any, Dict, List, Optional, Set
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from jet.scrapers.browser.playwright_helpers import (
    auto_solve_cloudflare,
    setup_async_browser_session,
)
from playwright.async_api import Page

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("missav_extractor")

# --- Configuration ---
SERVER_URL = "http://127.0.0.1:9001"
INGEST_ENDPOINT = f"{SERVER_URL}/ingest"
MAX_CONCURRENT_TABS = 20
MAX_RETRIES_PER_VIDEO = 3
INGEST_CHUNK_SIZE = 100
SEARCH_BASE_URL = "https://missav.ws/en/search/{code}-"
VIDEO_BASE_URL = "https://missav.ws"

# Regex patterns from content_search.js and content_single.js
SINGLE_VIDEO_PATH_RE = re.compile(
    r"^/(?:dm\d+/)?en/([a-z0-9]+-\d+(?:-[a-z0-9-]+)?)$", re.IGNORECASE
)
THREE_PART_WITH_SUFFIX = re.compile(
    r"\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE
)
TWO_PART_WITH_SUFFIX = re.compile(r"\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE)
LETTERS_THEN_DIGITS = re.compile(r"\b([a-z]+)(\d{3,6})\b", re.IGNORECASE)
DIGITS_THEN_LETTERS = re.compile(r"\b(\d+[a-z]+)(\d{3,6})\b", re.IGNORECASE)


class VideoItem:
    def __init__(self, data: Dict[str, Any]):
        self.id = data.get("id")
        self.url = data.get("url")
        self.code = data.get("code")
        self.episode = data.get("episode")
        self.video_id = data.get("video_id")
        self.title = data.get("title")
        self.thumbnail = data.get("thumbnail")
        self.preview = data.get("preview")
        self.details = data.get("details")
        self.release_date = data.get("release_date")
        self.genres = data.get("genres", [])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "code": self.code,
            "episode": self.episode,
            "video_id": self.video_id,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "preview": self.preview,
            "details": self.details,
            "release_date": self.release_date,
            "genres": self.genres,
        }

    def is_complete(self) -> bool:
        """Check if item has essential fields filled (similar to isMetadataComplete in JS)"""
        return bool(self.title and self.title.strip() and self.title != "Unknown Title")


def generate_id_from_url(url: str, video_id: str) -> str:
    """Generate consistent ID from URL or video_id"""
    input_str = url or video_id
    if not input_str:
        return f"unknown-{int(time.time())}"

    try:
        u = urlparse(input_str)
        normalized = u.scheme + "://" + u.netloc + u.path
    except Exception:
        normalized = input_str

    hash_val = 0x811C9DC5
    for char in normalized:
        hash_val ^= ord(char)
        hash_val = (hash_val * 0x01000193) & 0xFFFFFFFF
    return f"jav-{hash_val:x}"


def extract_jav_info(url: str, text: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Extract code, episode, and video_id from URL or text"""
    match = None
    # Try URL first
    if url:
        match = (
            THREE_PART_WITH_SUFFIX.search(url)
            or TWO_PART_WITH_SUFFIX.search(url)
            or LETTERS_THEN_DIGITS.search(url)
            or DIGITS_THEN_LETTERS.search(url)
        )

    # Fallback to text if no match in URL
    if not match and text:
        match = (
            THREE_PART_WITH_SUFFIX.search(text)
            or TWO_PART_WITH_SUFFIX.search(text)
            or LETTERS_THEN_DIGITS.search(text)
            or DIGITS_THEN_LETTERS.search(text)
        )

    if match:
        full_match = match.group(0).lower()
        if "-" in full_match:
            return {
                "video_id": full_match,
                "code": match.group(1).lower(),
                "episode": match.group(2),
            }
        else:
            return {
                "video_id": full_match,
                "code": match.group(1).lower() if match.group(1) else None,
                "episode": match.group(2) if match.group(2) else None,
            }
    return {"video_id": None, "code": None, "episode": None}


def generate_preview_url(thumbnail: Optional[str]) -> Optional[str]:
    """Generate preview.mp4 URL from thumbnail"""
    if not thumbnail:
        return None
    if thumbnail.endswith("/preview.mp4"):
        return thumbnail
    last_slash = thumbnail.rfind("/")
    if last_slash == -1:
        return None
    return thumbnail[: last_slash + 1] + "preview.mp4"


def parse_search_page(html: str, base_url: str) -> List[VideoItem]:
    """Parse search page HTML to extract video items (equivalent to content_search.js)"""
    soup = BeautifulSoup(html, "lxml")
    containers = soup.select(".thumbnail.group")
    logger.info(f"Found {len(containers)} video containers in search page")

    items = []
    seen_urls = set()

    for container in containers:
        try:
            # Find media anchor
            media_anchor = None
            for a in container.find_all("a", href=True):
                if a.find("video") or a.find("img"):
                    media_anchor = a
                    break

            if not media_anchor:
                continue

            raw_url = media_anchor.get("href")
            if not raw_url:
                continue

            # Clean URL
            if raw_url.startswith("/"):
                raw_url = urljoin(base_url, raw_url)
            clean_url = raw_url.split("#")[0].split("?")[0]

            if clean_url in seen_urls:
                continue
            seen_urls.add(clean_url)

            # Extract Title
            title = ""
            inner_title_link = container.select_one(
                ".text-sm.truncate a.text-secondary"
            )
            if inner_title_link:
                title = inner_title_link.get_text(strip=True)
            else:
                # Check siblings or parent
                parent = container.parent
                if parent:
                    sibling_link = parent.select_one(".text-sm.truncate a")
                    if not sibling_link:
                        sibling_link = container.find_next_sibling()
                        if sibling_link:
                            sibling_link = sibling_link.find("a")
                    if sibling_link:
                        title = sibling_link.get_text(strip=True)

                if not title:
                    # Check flex container
                    flex_parent = container.find_parent(class_="flex")
                    if flex_parent:
                        side_title = flex_parent.select_one(".overflow-y-hidden a")
                        if side_title:
                            title = side_title.get_text(strip=True)

                if not title:
                    img = container.find("img")
                    if img:
                        title = img.get("alt", "")

            # Extract Media
            img_el = container.find("img")
            video_el = container.find("video")

            thumbnail = None
            if img_el:
                src = img_el.get("src") or img_el.get("data-src")
                if src and src.startswith("http"):
                    thumbnail = src

            preview = None
            if video_el:
                v_src = video_el.get("src") or video_el.get("data-src")
                if v_src and "preview.mp4" in v_src:
                    preview = v_src

            if not preview and thumbnail:
                preview = generate_preview_url(thumbnail)

            # Extract Identifiers
            jav_info = extract_jav_info(clean_url, title)
            if not jav_info["video_id"]:
                continue

            video_id = generate_id_from_url(clean_url, jav_info["video_id"])

            item = VideoItem(
                {
                    "id": video_id,
                    "url": clean_url,
                    "code": jav_info["code"],
                    "episode": jav_info["episode"],
                    "video_id": jav_info["video_id"],
                    "title": title or None,
                    "thumbnail": thumbnail,
                    "preview": preview,
                    "details": None,
                    "release_date": None,
                    "genres": [],
                }
            )
            items.append(item)

        except Exception as e:
            logger.warning(f"Error parsing search container: {e}")

    return items


def parse_video_detail_page(html: str, url: str) -> Optional[VideoItem]:
    """Parse single video page HTML to extract full details (equivalent to content_single.js)"""
    soup = BeautifulSoup(html, "lxml")

    # Check if it's a valid single video page
    path_match = SINGLE_VIDEO_PATH_RE.search(urlparse(url).path)
    if not path_match:
        return None

    raw_segment = path_match.group(1)
    jav_info = extract_jav_info(raw_segment)
    if not jav_info["video_id"]:
        return None

    video_id = generate_id_from_url(url, jav_info["video_id"])

    # Extract Title
    title = None
    title_selectors = [
        "h1.text-base.lg\\:text-lg",
        "h1.lg\\:text-lg",
        "h1.text-base",
        "h1",
        ".text-base.text-secondary",
        "meta[property='og:title']",
    ]
    for sel in title_selectors:
        if sel.startswith("meta"):
            el = soup.select_one(sel)
            if el:
                title = el.get("content", "").strip()
        else:
            el = soup.select_one(sel)
            if el:
                title = el.get_text(strip=True)
        if title:
            break

    # Extract Details
    details = None
    detail_selectors = [
        ".order-first .text-secondary.break-all",
        ".mt-4.text-secondary.break-all",
        ".text-secondary.break-all",
        "meta[name='description']",
        "meta[property='og:description']",
    ]
    for sel in detail_selectors:
        if sel.startswith("meta"):
            el = soup.select_one(sel)
            if el:
                details = el.get("content", "").strip()
        else:
            el = soup.select_one(sel)
            if el:
                details = el.get_text(strip=True)
        if details and len(details) > 10:  # Ignore very short descriptions
            break

    # Extract Release Date
    release_date = None
    time_el = soup.select_one(".order-first time[datetime], time[datetime]")
    if time_el:
        release_date = time_el.get("datetime")
    else:
        # Fallback: look for date pattern in text
        for el in soup.select(".text-secondary, .order-first"):
            text = el.get_text()
            date_match = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
            if date_match:
                release_date = f"{date_match.group(1)}-{date_match.group(2).zfill(2)}-{date_match.group(3).zfill(2)}"
                break

    # Extract Genres
    genres = []
    genre_containers = soup.select(".text-secondary")
    found_genres = False
    for c in genre_containers:
        span = c.find("span")
        if span and "genre" in span.get_text().lower():
            links = c.find_all("a", class_="font-medium")
            genres = [
                link.get_text(strip=True) for link in links if link.get_text(strip=True)
            ]
            if genres:
                found_genres = True
                break

    if not found_genres:
        # Fallback: all font-medium links
        links = soup.find_all("a", class_="font-medium")
        genres = [
            link.get_text(strip=True)
            for link in links
            if link.get_text(strip=True) and len(link.get_text(strip=True)) < 40
        ]

    # Extract Thumbnail/Preview
    thumbnail = None
    player = soup.select_one("video.player")
    if player:
        thumbnail = player.get("data-poster") or player.get("poster")

    if not thumbnail:
        fb_img = soup.select_one(".order-first img, img[src*='cover']")
        if fb_img:
            thumbnail = fb_img.get("src") or fb_img.get("data-src")

    if not thumbnail:
        og_img = soup.select_one("meta[property='og:image']")
        if og_img:
            thumbnail = og_img.get("content")

    preview = generate_preview_url(thumbnail)

    return VideoItem(
        {
            "id": video_id,
            "url": url,
            "code": jav_info["code"],
            "episode": jav_info["episode"],
            "video_id": jav_info["video_id"],
            "title": title,
            "thumbnail": thumbnail,
            "preview": preview,
            "details": details,
            "release_date": release_date,
            "genres": genres,
        }
    )


async def fetch_existing_video_ids(code: str) -> Set[str]:
    """Fetch existing complete video IDs from the database to avoid re-processing"""
    existing_ids = set()
    limit = 5000
    offset = 0
    max_pages = 20

    for page in range(max_pages):
        url = f"{SERVER_URL}/videos?code={code}&completion_filter=complete&fields=id&limit={limit}&offset={offset}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        break
                    data = await resp.json()
                    items = data.get("items", [])
                    if not items:
                        break
                    for item in items:
                        if item.get("id"):
                            existing_ids.add(item["id"])
                    if len(items) < limit:
                        break
                    offset += limit
        except Exception as e:
            logger.warning(f"Error fetching existing IDs: {e}")
            break

    logger.info(f"Found {len(existing_ids)} existing complete IDs for code {code}")
    return existing_ids


async def ingest_batch(items: List[Dict[str, Any]]) -> Dict[str, int]:
    """Send batch of items to ingestion endpoint"""
    if not items:
        return {"inserted": 0, "updated": 0, "skipped": 0}

    payload = {"items": items, "upsert": True}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(INGEST_ENDPOINT, json=payload) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    return result
                else:
                    logger.error(f"Ingest failed with status {resp.status}")
                    return {"inserted": 0, "updated": 0, "skipped": 0}
    except Exception as e:
        logger.error(f"Error during ingestion: {e}")
        return {"inserted": 0, "updated": 0, "skipped": 0}


async def process_search_page(page: Page, code: str, page_num: int) -> List[VideoItem]:
    """Navigate to search page and extract video items"""
    url = SEARCH_BASE_URL.format(code=code)
    if page_num > 1:
        url += f"?page={page_num}"

    logger.info(f"Navigating to search page: {url}")
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)

    # Wait for content to load
    await page.wait_for_selector(".thumbnail.group", timeout=10000)

    # Get HTML content
    html = await page.content()
    return parse_search_page(html, url)


async def process_video_detail(
    page: Page, url: str, retries: int = 0
) -> Optional[VideoItem]:
    """Navigate to video detail page and extract full metadata"""
    try:
        logger.debug(f"Navigating to video: {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Auto-solve Cloudflare if present
        await auto_solve_cloudflare(page)

        # Wait for key elements
        await page.wait_for_selector("h1", timeout=10000)

        # Get HTML content
        html = await page.content()
        item = parse_video_detail_page(html, url)

        if item and item.is_complete():
            return item
        elif retries < MAX_RETRIES_PER_VIDEO:
            logger.warning(
                f"Incomplete extraction for {url}, retrying ({retries + 1}/{MAX_RETRIES_PER_VIDEO})"
            )
            await asyncio.sleep(2)
            return await process_video_detail(page, url, retries + 1)
        else:
            logger.warning(
                f"Failed to extract complete data for {url} after {MAX_RETRIES_PER_VIDEO} retries"
            )
            return item  # Return incomplete item

    except Exception as e:
        logger.error(f"Error processing video {url}: {e}")
        if retries < MAX_RETRIES_PER_VIDEO:
            await asyncio.sleep(2)
            return await process_video_detail(page, url, retries + 1)
        return None


async def run_extraction(codes: List[str]):
    """Main extraction workflow"""
    browser = await setup_async_browser_session(headless=True)
    context = await browser.new_context(
        viewport={"width": 1440, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )

    # Semaphore to limit concurrent tabs
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_TABS)

    # Queues for processing
    incomplete_queue = []
    complete_queue = []
    retry_counts = {}

    async def process_code(code: str):
        logger.info(f"Starting extraction for code: {code}")

        # Fetch existing IDs to skip
        existing_ids = await fetch_existing_video_ids(code)

        # Process search pages
        page_num = 1
        while True:
            async with semaphore:
                page = await context.new_page()
                try:
                    items = await process_search_page(page, code, page_num)
                    logger.info(f"Page {page_num}: Found {len(items)} videos")

                    if not items:
                        break

                    # Filter out existing complete items
                    new_items = [item for item in items if item.id not in existing_ids]
                    logger.info(
                        f"Page {page_num}: {len(new_items)} new items to process"
                    )

                    # Add to incomplete queue
                    for item in new_items:
                        incomplete_queue.append(item)

                    # Check if there are more pages
                    # Note: In a real scenario, you'd parse pagination from the HTML
                    # For now, we'll assume a fixed number of pages or stop when no items found
                    if len(items) < 20:  # Assuming 20 items per page
                        break

                finally:
                    await page.close()

            page_num += 1
            if page_num > 50:  # Safety limit
                break

        # Process incomplete items to get full details
        logger.info(f"Processing {len(incomplete_queue)} incomplete items for {code}")

        async def process_incomplete_item(item: VideoItem):
            async with semaphore:
                page = await context.new_page()
                try:
                    detailed_item = await process_video_detail(page, item.url)
                    if detailed_item:
                        if detailed_item.is_complete():
                            complete_queue.append(detailed_item.to_dict())
                        else:
                            # Keep in incomplete queue for retry
                            retry_count = retry_counts.get(item.id, 0) + 1
                            retry_counts[item.id] = retry_count
                            if retry_count < MAX_RETRIES_PER_VIDEO:
                                incomplete_queue.append(item)
                            else:
                                logger.warning(
                                    f"Giving up on {item.id} after {MAX_RETRIES_PER_VIDEO} retries"
                                )
                finally:
                    await page.close()

        # Process items in batches
        tasks = [process_incomplete_item(item) for item in incomplete_queue]
        await asyncio.gather(*tasks)

        # Ingest complete items
        if complete_queue:
            logger.info(f"Ingesting {len(complete_queue)} complete items for {code}")
            for i in range(0, len(complete_queue), INGEST_CHUNK_SIZE):
                chunk = complete_queue[i : i + INGEST_CHUNK_SIZE]
                result = await ingest_batch(chunk)
                logger.info(f"Ingest result: {result}")

    # Process all codes
    tasks = [process_code(code) for code in codes]
    await asyncio.gather(*tasks)

    # Cleanup
    await context.close()
    await browser.close()


if __name__ == "__main__":
    # Example usage
    codes = ["gvg", "jul", "nacr"]  # Replace with your list of codes
    asyncio.run(run_extraction(codes))

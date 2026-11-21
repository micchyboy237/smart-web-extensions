import asyncio
import logging
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from jet.scrapers.browser.playwright_helpers import (
    auto_solve_cloudflare,
    setup_async_browser_session,
)
from playwright.async_api import BrowserContext, Page, async_playwright

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("missav_extractor")

# Constants
SERVER_URL = "http://127.0.0.1:9001"
INGEST_ENDPOINT = f"{SERVER_URL}/ingest"
MAX_CONCURRENT_TABS = 20
INGEST_CHUNK_SIZE = 100
MAX_RETRIES_PER_VIDEO = 3
BASE_SEARCH_URL = "https://missav.ws/en/search/{}-"

# Regex patterns matching content_search.js and content_single.js
SINGLE_VIDEO_PATH_RE = re.compile(
    r"^/(?:dm\d+/)?en/([a-z0-9]+-\d+(?:-[a-z0-9-]+)?)$", re.IGNORECASE
)
THREE_PART_WITH_SUFFIX = re.compile(
    r"\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE
)
TWO_PART_WITH_SUFFIX = re.compile(r"\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE)
LETTERS_THEN_DIGITS = re.compile(r"\b([a-z]+)(\d{3,6})\b", re.IGNORECASE)
DIGITS_THEN_LETTERS = re.compile(r"\b(\d+[a-z]+)(\d{3,6})\b", re.IGNORECASE)


def generate_id_from_url(url: str, video_id: str) -> str:
    """Generates a deterministic ID based on URL path, matching the JS implementation."""
    input_str = url or video_id
    if not input_str:
        return f"unknown-{int(time.time())}"

    try:
        u = urlparse(input_str)
        normalized = u.scheme + "://" + u.netloc + u.path
    except Exception:
        normalized = input_str

    # FNV-1a hash implementation in Python to match JS
    hash_val = 0x811C9DC5
    for char in normalized:
        hash_val ^= ord(char)
        hash_val = (hash_val * 0x01000193) % (2**32)

    return f"jav-{hash_val:x}"


def extract_jav_info(url: str, text: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Extracts code, episode, and videoId from URL or text."""
    match = None
    for pattern in [
        THREE_PART_WITH_SUFFIX,
        TWO_PART_WITH_SUFFIX,
        LETTERS_THEN_DIGITS,
        DIGITS_THEN_LETTERS,
    ]:
        match = pattern.search(url)
        if not match and text:
            match = pattern.search(text)
        if match:
            break

    if match:
        full_match = match.group(0).lower()
        if "-" in full_match:
            return {
                "videoId": full_match,
                "code": match.group(1).lower(),
                "episode": match.group(2),
            }
        else:
            return {
                "videoId": full_match,
                "code": match.group(1).lower() if match.lastindex >= 1 else None,
                "episode": match.group(2) if match.lastindex >= 2 else None,
            }
    return {"videoId": None, "code": None, "episode": None}


async def fetch_existing_video_ids(code: str) -> set:
    """Fetches existing complete video IDs from the server to avoid re-processing."""
    ids = set()
    limit = 5000
    offset = 0
    max_pages = 20

    logger.info(f"Fetching existing IDs for code: {code}")
    async with httpx.AsyncClient() as client:
        for page in range(max_pages):
            url = f"{SERVER_URL}/videos?code={code}&completion_filter=complete&fields=id&limit={limit}&offset={offset}"
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    logger.warning(
                        f"Failed to fetch existing IDs page {page}: HTTP {resp.status_code}"
                    )
                    break
                data = resp.json()
                items = data.get("items", [])
                if not items:
                    break
                for item in items:
                    if item.get("id"):
                        ids.add(item["id"])
                if len(items) < limit:
                    break
                offset += limit
            except Exception as e:
                logger.error(f"Error fetching existing IDs page {page}: {e}")
                break
    logger.info(f"Found {len(ids)} existing complete IDs for code {code}")
    return ids


def parse_search_page_html(html: str, base_url: str) -> List[Dict[str, Any]]:
    """
    Parses search page HTML to extract video metadata without waiting for full JS execution.
    Mimics extractVideoMetadataFromSearch from content_search.js
    """
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select(".thumbnail.group")
    items = []
    seen_urls = set()

    logger.debug(f"Parsing {len(containers)} containers from search page HTML")

    for container in containers:
        try:
            # 1. Anchor containing media
            media_anchor = None
            for a in container.find_all("a", href=True):
                if a.find("video") or a.find("img"):
                    media_anchor = a
                    break

            if not media_anchor:
                continue

            raw_url = media_anchor["href"]
            if raw_url.startswith("/"):
                raw_url = urljoin(base_url, raw_url)

            clean_url = raw_url.split("#")[0].split("?")[0]
            if clean_url in seen_urls:
                continue
            seen_urls.add(clean_url)

            # 2. Title
            title = ""
            inner_title_link = container.select_one(
                ".text-sm.truncate a.text-secondary"
            )
            if inner_title_link:
                title = inner_title_link.get_text(strip=True)
            else:
                parent = container.parent
                if parent:
                    sibling_title = parent.select_one(".text-sm.truncate a")
                    if sibling_title:
                        title = sibling_title.get_text(strip=True)

                if not title:
                    flex_parent = container.find_parent(class_="flex")
                    if flex_parent:
                        side_title = flex_parent.select_one(".overflow-y-hidden a")
                        if side_title:
                            title = side_title.get_text(strip=True)

                if not title:
                    img = container.find("img")
                    if img:
                        title = img.get("alt", "")

            # 3. Media (Thumbnail/Preview)
            thumbnail = None
            preview = None

            img_el = container.find("img")
            if img_el:
                thumbnail = img_el.get("src") or img_el.get("data-src")

            video_el = container.find("video")
            if video_el:
                v_src = video_el.get("src") or video_el.get("data-src")
                if v_src and "preview.mp4" in v_src:
                    preview = v_src

            if not preview and thumbnail:
                if thumbnail.endswith("/preview.mp4"):
                    preview = thumbnail
                else:
                    idx = thumbnail.rfind("/")
                    if idx != -1:
                        preview = thumbnail[: idx + 1] + "preview.mp4"

            # 4. Identifiers
            jav_info = extract_jav_info(clean_url, title)
            if not jav_info["videoId"]:
                logger.debug(f"Skipping item with no videoId: {clean_url}")
                continue

            video_id = jav_info["videoId"]
            code = jav_info["code"]
            episode = jav_info["episode"]
            id_hash = generate_id_from_url(clean_url, video_id)

            # These are "Incomplete" because they lack details, release_date, genres
            items.append(
                {
                    "id": id_hash,
                    "url": clean_url,
                    "code": code,
                    "episode": episode,
                    "video_id": video_id,
                    "title": title or None,
                    "thumbnail": thumbnail,
                    "preview": preview,
                    "details": None,
                    "release_date": None,
                    "genres": [],
                }
            )
        except Exception as e:
            logger.debug(f"Error parsing container: {e}")

    logger.info(f"Parsed {len(items)} unique items from search page")
    return items


def parse_single_video_page_html(html: str, url: str) -> Optional[Dict[str, Any]]:
    """
    Parses single video page HTML to extract detailed metadata.
    Mimics extractVideoMetadata from content_single.js
    """
    soup = BeautifulSoup(html, "html.parser")

    # Path match check
    path_match = SINGLE_VIDEO_PATH_RE.search(urlparse(url).path)
    if not path_match:
        logger.warning(f"URL does not match single video pattern: {url}")
        return None

    raw_segment = path_match.group(1)
    s = raw_segment.lower()
    m = re.match(r"^([a-z0-9]+)-(\d+)", s)
    if not m:
        logger.warning(f"Could not derive identifiers from segment: {raw_segment}")
        return None

    video_id = s
    code = m.group(1)
    episode = m.group(2)

    # Title
    title = None
    selectors_h1 = [
        "h1.text-base.lg\\:text-lg",
        "h1.lg\\:text-lg",
        "h1.text-base",
        "h1",
        ".text-base.text-secondary",
    ]
    for sel in selectors_h1:
        el = soup.select_one(sel)
        if el:
            title = el.get_text(strip=True)
            if title:
                break
    if not title:
        og_title = soup.find("meta", property="og:title")
        if og_title:
            title = og_title.get("content", "").strip()

    # Details
    details = None
    selectors_details = [
        ".order-first .text-secondary.break-all",
        ".mt-4.text-secondary.break-all",
        ".text-secondary.break-all",
    ]
    for sel in selectors_details:
        el = soup.select_one(sel)
        if el:
            details = el.get_text(strip=True)
            if details and len(details) > 10:
                break
    if not details or len(details) <= 10:
        og_desc = soup.find("meta", attrs={"name": "description"})
        if og_desc:
            details = og_desc.get("content", "").strip()
        elif not details:
            og_desc_prop = soup.find("meta", property="og:description")
            if og_desc_prop:
                details = og_desc_prop.get("content", "").strip()

    # Release Date
    release_date = None
    time_el = soup.select_one(".order-first time[datetime]")
    if not time_el:
        time_el = soup.find("time", datetime=True)

    if time_el:
        release_date = time_el.get("datetime")
    else:
        for el in soup.select(".text-secondary, .order-first"):
            text = el.get_text()
            date_match = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
            if date_match:
                y, mo, d = date_match.groups()
                release_date = f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
                break

    # Genres
    genres = []
    genre_containers = soup.select(".text-secondary")
    found_genres = False
    for c in genre_containers:
        span = c.find("span")
        if span and "genre" in span.get_text().lower():
            links = c.find_all("a", class_="font-medium")
            genres = [a.get_text(strip=True) for a in links if a.get_text(strip=True)]
            if genres:
                found_genres = True
                break

    if not found_genres:
        links = soup.find_all("a", class_="font-medium")
        genres = [
            a.get_text(strip=True)
            for a in links
            if a.get_text(strip=True) and len(a.get_text(strip=True)) < 40
        ]

    # Thumbnail/Preview
    thumbnail = None
    player = soup.find("video", class_="player")
    if player:
        thumbnail = player.get("data-poster") or player.get("poster")

    if not thumbnail:
        fb_img = soup.select_one(".order-first img") or soup.find(
            "img", src=lambda x: x and "cover" in x
        )
        if fb_img:
            thumbnail = fb_img.get("src") or fb_img.get("data-src")

    if not thumbnail:
        og_image = soup.find("meta", property="og:image")
        if og_image:
            thumbnail = og_image.get("content")

    preview = None
    if thumbnail:
        if thumbnail.endswith("/preview.mp4"):
            preview = thumbnail
        else:
            idx = thumbnail.rfind("/")
            if idx != -1:
                preview = thumbnail[: idx + 1] + "preview.mp4"

    id_hash = generate_id_from_url(url, video_id)

    result = {
        "id": id_hash,
        "url": url.split("#")[0],
        "code": code,
        "episode": episode,
        "video_id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "preview": preview,
        "details": details,
        "release_date": release_date,
        "genres": genres,
    }

    logger.debug(
        f"Parsed metadata for {video_id}: Title='{title}', Details='{details[:50] if details else None}...'"
    )
    return result


class MissAVExtractor:
    def __init__(self, codes: List[str], headless: bool = False):
        self.codes = codes
        self.headless = headless
        # Two separate queues as per extension logic
        self.incomplete_queue: List[Dict] = []
        self.complete_queue: List[Dict] = []
        self.existing_ids: Dict[str, set] = {}
        self.total_ingested = 0

    async def initialize(self):
        """Fetch existing IDs for all codes."""
        tasks = [fetch_existing_video_ids(code) for code in self.codes]
        results = await asyncio.gather(*tasks)
        for code, ids in zip(self.codes, results):
            self.existing_ids[code] = ids

    async def ingest_batch(self, items: List[Dict], queue_type: str):
        """Send batch to server."""
        if not items:
            return

        payload = {"items": items, "upsert": True}
        logger.info(f"Ingesting {len(items)} items to {queue_type} queue...")
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(INGEST_ENDPOINT, json=payload, timeout=30.0)
                if resp.status_code == 200:
                    result = resp.json()
                    inserted = result.get("inserted", 0)
                    updated = result.get("updated", 0)
                    self.total_ingested += inserted + updated
                    logger.info(
                        f"✅ Ingested {queue_type}: {inserted} new, {updated} updated"
                    )
                else:
                    logger.error(
                        f"❌ Ingest failed for {queue_type}: {resp.status_code} - {resp.text}"
                    )
                    # Re-add to queue on failure
                    if queue_type == "incomplete":
                        self.incomplete_queue.extend(items)
                    else:
                        self.complete_queue.extend(items)
        except Exception as e:
            logger.error(f"❌ Network error during ingest: {e}")
            if queue_type == "incomplete":
                self.incomplete_queue.extend(items)
            else:
                self.complete_queue.extend(items)

    async def maybe_auto_ingest(self):
        """Check thresholds and ingest if necessary."""
        if len(self.incomplete_queue) >= INGEST_CHUNK_SIZE:
            batch = self.incomplete_queue[:INGEST_CHUNK_SIZE]
            self.incomplete_queue = self.incomplete_queue[INGEST_CHUNK_SIZE:]
            await self.ingest_batch(batch, "incomplete")

        if len(self.complete_queue) >= INGEST_CHUNK_SIZE:
            batch = self.complete_queue[:INGEST_CHUNK_SIZE]
            self.complete_queue = self.complete_queue[INGEST_CHUNK_SIZE:]
            await self.ingest_batch(batch, "complete")

    async def flush_queues(self):
        """Final flush of all queues."""
        logger.info("Flushing remaining queues...")
        if self.incomplete_queue:
            await self.ingest_batch(self.incomplete_queue, "incomplete")
            self.incomplete_queue = []
        if self.complete_queue:
            await self.ingest_batch(self.complete_queue, "complete")
            self.complete_queue = []

    async def process_search_page(self, page: Page, code: str, url: str) -> List[Dict]:
        """Process a search page, extract items, and return video URLs to open."""
        logger.info(f"🔍 Processing search page: {url}")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
            html = await page.content()
            items = parse_search_page_html(html, url)

            # Filter out existing IDs
            existing = self.existing_ids.get(code, set())
            new_items = [item for item in items if item["id"] not in existing]

            logger.info(f"Found {len(items)} items, {len(new_items)} new on page {url}")

            # Add to incomplete queue
            if new_items:
                self.incomplete_queue.extend(new_items)
                await self.maybe_auto_ingest()

            # Return URLs for detailed extraction
            return [item["url"] for item in new_items]

        except Exception as e:
            logger.error(f"❌ Error processing search page {url}: {e}")
            return []

    async def process_video_page(self, page: Page, url: str) -> Optional[Dict]:
        """Process a single video page for detailed metadata."""
        logger.debug(f"📺 Opening video page: {url}")
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await auto_solve_cloudflare(page)

            # Wait for dynamic content to settle
            await page.wait_for_timeout(2000)

            html = await page.content()
            metadata = parse_single_video_page_html(html, url)

            if metadata:
                # If we have title and details, it's considered "Complete"
                if metadata["title"] and metadata["details"]:
                    logger.debug(f"✅ Complete metadata for {metadata['video_id']}")
                    return metadata
                else:
                    logger.debug(f"⚠️ Incomplete metadata for {metadata['video_id']}")
                    # Otherwise it remains incomplete
                    return metadata
            else:
                logger.warning(f"❌ No metadata parsed for {url}")
                return None
        except Exception as e:
            logger.error(f"❌ Error processing video page {url}: {e}")
            return None

    async def run(self):
        """Main execution loop."""
        await self.initialize()

        logger.info("🚀 Starting Playwright session...")
        playwright = await async_playwright().start()

        # setup_async_browser_session returns a BrowserContext
        logger.info("🛡️ Setting up browser context with stealth...")
        context: BrowserContext = await setup_async_browser_session(
            headless=self.headless
        )

        try:
            for code in self.codes:
                logger.info(f"📦 Starting extraction for code: {code}")
                search_url = BASE_SEARCH_URL.format(code)

                # Open search page
                logger.info(f"🌐 Navigating to search page: {search_url}")
                page = await context.new_page()
                await page.goto(search_url, wait_until="domcontentloaded")
                await auto_solve_cloudflare(page)

                # Extract pagination links
                page_urls = [search_url]
                try:
                    paginator = await page.query_selector(".hidden.md\\:flex")
                    if paginator:
                        links = await paginator.query_selector_all('a[href*="page="]')
                        for link in links:
                            href = await link.get_attribute("href")
                            if href:
                                full_url = urljoin(search_url, href)
                                if full_url not in page_urls:
                                    page_urls.append(full_url)
                except Exception as e:
                    logger.warning(f"Could not parse pagination: {e}")

                logger.info(f"📄 Found {len(page_urls)} search pages for {code}")

                # Process search pages
                all_video_urls = []

                for p_url in page_urls:
                    if p_url != search_url:
                        logger.info(f"🔄 Navigating to next page: {p_url}")
                        await page.goto(p_url, wait_until="domcontentloaded")
                        await auto_solve_cloudflare(page)

                    urls = await self.process_search_page(page, code, p_url)
                    all_video_urls.extend(urls)

                await page.close()

                logger.info(f"📋 Collected {len(all_video_urls)} video URLs for {code}")

                if not all_video_urls:
                    logger.info("No new videos to process for this code.")
                    continue

                # Process video pages in parallel batches
                semaphore = asyncio.Semaphore(MAX_CONCURRENT_TABS)

                async def process_video_with_semaphore(url):
                    async with semaphore:
                        video_page = await context.new_page()
                        try:
                            metadata = await self.process_video_page(video_page, url)
                            if metadata:
                                # Check if it's complete
                                if metadata["title"] and metadata["details"]:
                                    self.complete_queue.append(metadata)
                                else:
                                    # Retry logic could go here, for now add to incomplete
                                    self.incomplete_queue.append(metadata)

                                await self.maybe_auto_ingest()
                        except Exception as e:
                            logger.error(f"❌ Failed to process video {url}: {e}")
                        finally:
                            await video_page.close()

                # Process in batches to avoid overwhelming memory
                batch_size = 50
                for i in range(0, len(all_video_urls), batch_size):
                    batch = all_video_urls[i : i + batch_size]
                    logger.info(
                        f"🚀 Processing batch {i // batch_size + 1} ({len(batch)} videos)..."
                    )
                    tasks = [process_video_with_semaphore(url) for url in batch]
                    await asyncio.gather(*tasks)
                    logger.info(f"✅ Finished batch {i // batch_size + 1}")

            # Final flush
            await self.flush_queues()

        except Exception as e:
            logger.error(f"❌ Critical error during extraction: {e}", exc_info=True)
        finally:
            logger.info("🛑 Closing browser context...")
            await context.close()
            await playwright.stop()

        logger.info(f"🏁 Extraction complete. Total ingested: {self.total_ingested}")


async def run_missav_video_extractor(codes: List[str], headless: bool = False):
    """
    Entry point for running the MissAV video extractor.

    Args:
        codes: List of JAV codes to search for (e.g., ["gvg", "jul"]).
        headless: Whether to run browser in headless mode.
    """
    extractor = MissAVExtractor(codes=codes, headless=headless)
    await extractor.run()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Run extraction for one or more codes."
    )
    parser.add_argument(
        "codes",
        nargs="+",  # one or more positional args
        metavar="CODE",
        help="One or more codes to extract (e.g. gvg jul nacr)",
    )
    parser.add_argument(
        "-H",
        "--headless",
        action=argparse.BooleanOptionalAction,  # gives --headless / --no-headless
        default=False,
        help="Run browser in headless mode (default: enabled)",
    )
    args = parser.parse_args()

    asyncio.run(run_missav_video_extractor(args.codes, headless=args.headless))

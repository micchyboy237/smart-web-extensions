import asyncio
import logging
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from jet.scrapers.browser.playwright_helpers import (
    ascrape_urls,
    setup_async_browser_session,
)
from playwright.async_api import BrowserContext, Page, async_playwright

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("missav_extractor")

SERVER_URL = "http://127.0.0.1:9001"
INGEST_ENDPOINT = f"{SERVER_URL}/ingest"
MAX_CONCURRENT_TABS = 15
INGEST_CHUNK_SIZE = 120
BASE_SEARCH_URL = "https://missav.ws/en/search/{}-"
MAX_SEARCH_PAGES = 500
EMPTY_PAGE_STREAK_LIMIT = 1
MAX_INFLIGHT_INGESTS = 8

SINGLE_VIDEO_PATH_RE = re.compile(
    r"^/(?:dm\d+/)?en/([a-z0-9]+-\d+(?:-[a-z0-9-]+)?)$", re.IGNORECASE
)
THREE_PART_WITH_SUFFIX = re.compile(
    r"\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE
)
TWO_PART_WITH_SUFFIX = re.compile(r"\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b", re.IGNORECASE)
LETTERS_THEN_DIGITS = re.compile(r"\b([a-z]+)(\d{3,6})\b", re.IGNORECASE)
DIGITS_THEN_LETTERS = re.compile(r"\b(\d+[a-z]+)(\d{3,6})\b", re.IGNORECASE)


def _to_base36(n: int) -> str:
    """Converts a non-negative int to a lowercase base36 string.
    Mirrors JS Number.prototype.toString(36).
    """
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return "".join(reversed(out))


def generate_id_from_url(url: str, video_id: str) -> str:
    """Generates a deterministic ID based on URL path.
    Must stay byte-for-byte identical to generateIdFromUrl() in
    content_search.js / content_single.js:
      - FNV-1a 32-bit over scheme://netloc + path
      - output encoded as base36 with prefix "jav-"
      - bare identifiers (no scheme) are NOT normalized (JS new URL throws)
      - empty input → "unknown-" + epoch milliseconds
    """
    input_str = url or video_id
    if not input_str:
        return f"unknown-{int(time.time() * 1000)}"
    normalized = input_str
    try:
        u = urlparse(input_str)
        if u.scheme and u.netloc:
            normalized = u.scheme + "://" + u.netloc + u.path
    except Exception:
        normalized = input_str
    hash_val = 0x811C9DC5
    for char in normalized:
        hash_val ^= ord(char)
        hash_val = (hash_val * 0x01000193) % (2**32)
    return f"jav-{_to_base36(hash_val)}"


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
    """Fetches existing complete video IDs from the server."""
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
                logger.error(f"Error fetching existing IDs: {e}")
                break
    logger.info(f"Found {len(ids)} existing complete IDs for code {code}")
    return ids


def parse_search_page_html(html: str, base_url: str) -> List[Dict[str, Any]]:
    """Parses search page HTML to extract video metadata."""
    soup = BeautifulSoup(html, "html.parser")
    containers = soup.select(".thumbnail.group")
    items = []
    seen_urls = set()
    for container in containers:
        try:
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
            jav_info = extract_jav_info(clean_url, title)
            if not jav_info["videoId"]:
                continue
            video_id = jav_info["videoId"]
            code = jav_info["code"]
            episode = jav_info["episode"]
            id_hash = generate_id_from_url(clean_url, video_id)
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
    return items


def parse_single_video_page_html(html: str, url: str) -> Optional[Dict[str, Any]]:
    """Parses single video page HTML to extract detailed metadata."""
    soup = BeautifulSoup(html, "html.parser")
    path_match = SINGLE_VIDEO_PATH_RE.search(urlparse(url).path)
    if not path_match:
        return None
    raw_segment = path_match.group(1)
    s = raw_segment.lower()
    m = re.match(r"^([a-z0-9]+)-(\d+)", s)
    if not m:
        return None
    video_id = s
    code = m.group(1)
    episode = m.group(2)
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
    if title is not None and not title.strip():
        title = None
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
    if details is not None and not details.strip():
        details = None
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
    return {
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


class MissAVExtractor:
    def __init__(self, codes: List[str], headless: bool = False):
        self.codes = codes
        self.headless = headless
        self.incomplete_queue: List[Dict] = []
        self.complete_queue: List[Dict] = []
        self.existing_ids: Dict[str, set] = {}
        self.total_ingested = 0
        # Background ingest tasks so /ingest POSTs never block scraping.
        self._inflight_ingests: set[asyncio.Task] = set()
        self._max_inflight_ingests = MAX_INFLIGHT_INGESTS

    async def initialize(self):
        tasks = [fetch_existing_video_ids(code) for code in self.codes]
        results = await asyncio.gather(*tasks)
        for code, ids in zip(self.codes, results):
            self.existing_ids[code] = ids

    async def ingest_batch(self, items: List[Dict], queue_type: str) -> Dict[str, int]:
        """POST a batch to /ingest. Returns {inserted, updated}. Raises on failure."""
        if not items:
            return {"inserted": 0, "updated": 0}
        payload = {"items": items, "upsert": True}
        async with httpx.AsyncClient() as client:
            resp = await client.post(INGEST_ENDPOINT, json=payload, timeout=60.0)
        if resp.status_code != 200:
            raise RuntimeError(
                f"ingest failed for {queue_type}: HTTP {resp.status_code}"
            )
        result = resp.json()
        inserted = int(result.get("inserted", 0))
        updated = int(result.get("updated", 0))
        logger.info(
            f"✅ Ingested {queue_type}: {inserted} new, {updated} updated "
            f"({len(items)} items)"
        )
        return {"inserted": inserted, "updated": updated}

    def _ingest_in_background(self, items: List[Dict], queue_type: str) -> None:
        """Fire-and-forget ingest. Never blocks the caller."""
        if not items:
            return
        task = asyncio.create_task(
            self._run_ingest_batch(items, queue_type),
            name=f"ingest-{queue_type}-{len(items)}",
        )
        self._inflight_ingests.add(task)
        task.add_done_callback(self._inflight_ingests.discard)

    async def _run_ingest_batch(self, items: List[Dict], queue_type: str) -> None:
        try:
            result = await self.ingest_batch(items, queue_type)
            self.total_ingested += result["inserted"] + result["updated"]
        except Exception as e:
            logger.error(f"❌ Background ingest failed for {queue_type}: {e}")
            # Re-queue on failure so flush_queues()/next batch retries.
            if queue_type == "incomplete":
                self.incomplete_queue.extend(items)
            else:
                self.complete_queue.extend(items)

    async def _await_inflight_ingests(self, drain_below: Optional[int] = None) -> None:
        """
        Await in-flight ingests until the count drops below `drain_below`
        (or all of them, if None).
        """
        while self._inflight_ingests:
            if drain_below is not None and len(self._inflight_ingests) < drain_below:
                return
            await asyncio.gather(*self._inflight_ingests, return_exceptions=True)

    async def maybe_auto_ingest(self) -> None:
        """
        Schedule chunk POSTs without blocking. Backpressure: if too many
        ingests are in flight, await one before scheduling more so we don't
        pile up unbounded POSTs (each does server-side embedding work).
        """
        while len(self._inflight_ingests) >= self._max_inflight_ingests:
            await self._await_inflight_ingests(drain_below=self._max_inflight_ingests)

        if len(self.incomplete_queue) >= INGEST_CHUNK_SIZE:
            batch = self.incomplete_queue[:INGEST_CHUNK_SIZE]
            self.incomplete_queue = self.incomplete_queue[INGEST_CHUNK_SIZE:]
            self._ingest_in_background(batch, "incomplete")

        if len(self.complete_queue) >= INGEST_CHUNK_SIZE:
            batch = self.complete_queue[:INGEST_CHUNK_SIZE]
            self.complete_queue = self.complete_queue[INGEST_CHUNK_SIZE:]
            self._ingest_in_background(batch, "complete")

    async def flush_queues(self) -> None:
        """
        Schedule any remaining queued items and then wait for ALL in-flight
        ingests to finish. Called at code boundaries and at run end, so the
        blocking here is intentional and bounded.
        """
        if self.incomplete_queue:
            logger.info(
                f"💾 Scheduling final incomplete flush "
                f"({len(self.incomplete_queue)} items)..."
            )
            self._ingest_in_background(self.incomplete_queue, "incomplete")
            self.incomplete_queue = []
        if self.complete_queue:
            logger.info(
                f"💾 Scheduling final complete flush "
                f"({len(self.complete_queue)} items)..."
            )
            self._ingest_in_background(self.complete_queue, "complete")
            self.complete_queue = []
        if self._inflight_ingests:
            logger.info(
                f"⏳ Waiting for {len(self._inflight_ingests)} in-flight ingest(s)..."
            )
            await self._await_inflight_ingests()

    async def discover_page_urls(
        self, page: Page, code: str, search_url: str
    ) -> List[str]:
        """
        Discover all page URLs for a search.
        The paginator only renders a small window of page links (e.g. 1-10 plus
        the tail like 166-167). We parse the max link seen, but if the max looks
        suspiciously like a tail anchor, we probe forward to find the true last
        page. We also probe the first page to detect single-page results.
        """
        page_urls = [search_url]
        max_seen = 1
        try:
            paginator = await page.query_selector(".hidden.md\\:flex")
            if paginator:
                links = await paginator.query_selector_all('a[href*="page="]')
                for link in links:
                    href = await link.get_attribute("href")
                    if not href:
                        continue
                    m = re.search(r"[?&]page=(\d+)", href)
                    if m:
                        max_seen = max(max_seen, int(m.group(1)))
                    full_url = urljoin(search_url, href)
                    if full_url not in page_urls:
                        page_urls.append(full_url)
        except Exception as e:
            logger.warning(f"Could not parse pagination DOM: {e}")
        if max_seen <= 1 and len(page_urls) <= 1:
            logger.info(f"📄 Single search page detected for {code}")
            return page_urls
        base = BASE_SEARCH_URL.format(code)
        probe_page_num = 2
        consecutive_empty = 0
        while probe_page_num <= MAX_SEARCH_PAGES:
            probe_url = f"{base}?page={probe_page_num}"
            if probe_url in page_urls:
                probe_page_num += 1
                continue
            try:
                await page.goto(probe_url, wait_until="domcontentloaded")
                await page.wait_for_load_state("domcontentloaded", timeout=10000)
                html = await page.content()
                items = parse_search_page_html(html, probe_url)
                if not items:
                    consecutive_empty += 1
                    logger.info(
                        f"📄 Probe page {probe_page_num} empty "
                        f"({consecutive_empty}/{EMPTY_PAGE_STREAK_LIMIT})"
                    )
                    if consecutive_empty >= EMPTY_PAGE_STREAK_LIMIT:
                        logger.info(
                            f"📄 Stopping pagination probe at page {probe_page_num}"
                        )
                        break
                else:
                    consecutive_empty = 0
                    page_urls.append(probe_url)
            except Exception as e:
                logger.warning(f"Probe page {probe_page_num} failed: {e}")
                break
            probe_page_num += 1

        def _page_key(u: str) -> int:
            m = re.search(r"[?&]page=(\d+)", u)
            return int(m.group(1)) if m else 1

        page_urls = sorted(set(page_urls), key=_page_key)
        logger.info(f"📄 Discovered {len(page_urls)} search pages for {code}")
        return page_urls

    async def process_search_page(self, page: Page, code: str, url: str) -> List[Dict]:
        logger.info(f"🔍 Processing search page: {url}")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
            html = await page.content()
            items = parse_search_page_html(html, url)
            existing = self.existing_ids.get(code, set())
            new_items = [item for item in items if item["id"] not in existing]
            if new_items:
                logger.info(
                    f"Found {len(items)} items, {len(new_items)} new on page {url}"
                )
                self.incomplete_queue.extend(new_items)
                await self.maybe_auto_ingest()
            return [item["url"] for item in new_items]
        except Exception as e:
            logger.error(f"❌ Error processing search page {url}: {e}")
            return []

    async def run(self):
        await self.initialize()
        logger.info("🚀 Starting Playwright session...")
        playwright = await async_playwright().start()
        context: BrowserContext = await setup_async_browser_session(
            headless=self.headless
        )
        try:
            for code in self.codes:
                logger.info(f"📦 Starting extraction for code: {code}")
                search_url = BASE_SEARCH_URL.format(code)
                page = await context.new_page()
                await page.goto(search_url, wait_until="domcontentloaded")
                page_urls = await self.discover_page_urls(page, code, search_url)
                all_video_urls = []
                for idx, p_url in enumerate(page_urls):
                    if idx > 0:
                        await page.goto(p_url, wait_until="domcontentloaded")
                    urls = await self.process_search_page(page, code, p_url)
                    all_video_urls.extend(urls)
                await page.close()
                logger.info(f"📋 Collected {len(all_video_urls)} video URLs for {code}")
                if (
                    self.incomplete_queue
                    or self.complete_queue
                    or self._inflight_ingests
                ):
                    logger.info(
                        f"💾 Draining queues before video scrape "
                        f"(incomplete={len(self.incomplete_queue)}, "
                        f"complete={len(self.complete_queue)}, "
                        f"inflight={len(self._inflight_ingests)})"
                    )
                    await self.flush_queues()
                if not all_video_urls:
                    continue
                logger.info(
                    f"🚀 Starting fast-mode scrape for {len(all_video_urls)} videos..."
                )
                start_time = time.time()
                async for result in ascrape_urls(
                    urls=all_video_urls,
                    num_parallel=MAX_CONCURRENT_TABS,
                    headless=self.headless,
                    wait_for_js=False,
                    with_screenshot=False,
                    scroll_strategy="none",
                    fast_mode=True,
                    timeout=10000,
                ):
                    if result["status"] == "completed" and result["html"]:
                        metadata = parse_single_video_page_html(
                            result["html"], result["url"]
                        )
                        if metadata:
                            if metadata["title"] and metadata["details"]:
                                self.complete_queue.append(metadata)
                            else:
                                self.incomplete_queue.append(metadata)
                            # Schedules a background POST instead of blocking.
                            await self.maybe_auto_ingest()
                    elif result["status"] != "started":
                        logger.warning(
                            f"Failed to scrape {result['url']}: {result['status']}"
                        )
                elapsed = time.time() - start_time
                logger.info(
                    f"✅ Finished fast-mode scrape for {code} in {elapsed:.2f}s"
                )
                if (
                    self.incomplete_queue
                    or self.complete_queue
                    or self._inflight_ingests
                ):
                    logger.info(
                        f"💾 Draining queues before next code "
                        f"(incomplete={len(self.incomplete_queue)}, "
                        f"complete={len(self.complete_queue)}, "
                        f"inflight={len(self._inflight_ingests)})"
                    )
                    await self.flush_queues()
            await self.flush_queues()
        except Exception as e:
            logger.error(f"❌ Critical error during extraction: {e}", exc_info=True)
        finally:
            # Best-effort drain so partial progress is persisted on shutdown.
            try:
                await self.flush_queues()
            except Exception as e:
                logger.error(f"❌ Final flush failed: {e}")
            logger.info("🛑 Closing browser context...")
            await context.close()
            await playwright.stop()
        logger.info(f"🏁 Extraction complete. Total ingested: {self.total_ingested}")


async def run_missav_video_extractor(codes: List[str], headless: bool = False):
    extractor = MissAVExtractor(codes=codes, headless=headless)
    await extractor.run()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Run extraction for one or more codes."
    )
    parser.add_argument(
        "codes", nargs="+", metavar="CODE", help="One or more codes to extract"
    )
    parser.add_argument(
        "-H",
        "--headless",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Run browser in headless mode",
    )
    args = parser.parse_args()
    asyncio.run(run_missav_video_extractor(args.codes, headless=args.headless))

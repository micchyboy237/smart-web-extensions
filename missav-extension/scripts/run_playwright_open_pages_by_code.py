import argparse
import asyncio
from typing import List, Optional

from jet.logger import logger
from jet.scrapers.browser.playwright_helpers import (
    ascrape_urls,
    setup_async_browser_session,
)
from playwright.async_api import Page


async def extract_video_urls_from_page(page: Page, code: str) -> List[str]:
    """Extract video URLs from search results page that match the given code."""
    # Wait for content to load
    await page.wait_for_selector(".grid", timeout=10000)

    # Get all anchor hrefs that contain a video element
    video_urls = await page.evaluate(f"""
        () => {{
            const code = '{code}';
            const anchors = Array.from(document.querySelectorAll('a'));
            const uniqueUrls = new Set();
            
            anchors.forEach(anchor => {{
                const href = anchor.getAttribute('href');
                if (!href) return;
                
                // Check if this anchor contains a video element
                const hasVideo = anchor.querySelector('video') !== null;
                if (!hasVideo) return;
                
                // Check if href contains the code pattern (case-insensitive)
                if (new RegExp(code, 'i').test(href)) {{
                    // Ensure it's a video detail page (contains /en/)
                    if (href.includes('/en/')) {{
                        uniqueUrls.add(href);
                    }}
                }}
            }});
            
            return Array.from(uniqueUrls);
        }}
    """)

    return video_urls


async def get_next_page_url(page: Page, current_page_num: int) -> Optional[str]:
    """Get the URL for the next page if it exists."""
    next_page_num = current_page_num + 1

    # Look for pagination link with the next page number
    next_page_link = await page.evaluate(f"""
        () => {{
            const nextPageNum = {next_page_num};
            const links = Array.from(document.querySelectorAll('a[aria-label^="Go to page"]'));
            
            for (const link of links) {{
                const label = link.getAttribute('aria-label');
                if (label && label.includes(nextPageNum.toString())) {{
                    return link.href;
                }}
            }}
            
            // Also check for "Next" button
            const nextButton = document.querySelector('a[aria-label*="Next"]');
            if (nextButton) {{
                return nextButton.href;
            }}
            
            return null;
        }}
    """)

    return next_page_link


async def process_search_pages(
    code: str,
    headless: bool = False,
    js_wait_time_ms: int = 5000,
    num_parallel: int = 5,
):
    """Process all search pages for the given code and open matching video URLs."""
    logger.log(f"Starting search for code: {code}", colors=["BLUE", "INFO"])

    # Setup browser session
    context = await setup_async_browser_session(headless=headless)

    try:
        # Create initial page for navigation
        nav_page = await context.new_page()

        current_page_num = 1
        total_videos_found = 0

        while True:
            search_url = f"https://missav.ws/en/search/{code}-?page={current_page_num}"
            logger.log(
                f"Processing page {current_page_num}: {search_url}",
                colors=["YELLOW", "INFO"],
            )

            try:
                # Navigate to search page
                await nav_page.goto(
                    search_url, wait_until="domcontentloaded", timeout=30000
                )

                # Extract video URLs matching the code
                video_urls = await extract_video_urls_from_page(nav_page, code)

                if not video_urls:
                    logger.log(
                        f"No videos found on page {current_page_num}",
                        colors=["GRAY", "DEBUG"],
                    )
                    # Check if there's a next page
                    next_url = await get_next_page_url(nav_page, current_page_num)
                    if not next_url:
                        logger.log(
                            "No more pages available", colors=["GREEN", "SUCCESS"]
                        )
                        break
                    else:
                        current_page_num += 1
                        continue

                logger.log(
                    f"Found {len(video_urls)} videos on page {current_page_num}",
                    colors=["GREEN", "SUCCESS"],
                )
                total_videos_found += len(video_urls)

                # Use ascrape_urls to open all video URLs and wait for JS
                logger.log(
                    f"Opening {len(video_urls)} videos with JS wait...",
                    colors=["BLUE", "INFO"],
                )
                async for result in ascrape_urls(
                    urls=video_urls,
                    num_parallel=num_parallel,
                    headless=headless,
                    wait_for_js=True,
                    timeout=30000,
                    max_retries=1,
                    with_screenshot=False,
                    scroll_strategy="none",
                    context=context,
                ):
                    if result["status"] == "completed":
                        logger.log(
                            f"Successfully loaded: {result['url']}",
                            colors=["GREEN", "DEBUG"],
                        )
                    elif result["status"] == "failed_error":
                        logger.log(
                            f"Failed to load: {result['url']}", colors=["RED", "ERROR"]
                        )

                logger.log(
                    f"Completed processing page {current_page_num}",
                    colors=["GREEN", "SUCCESS"],
                )

                # Check if there's a next page
                next_url = await get_next_page_url(nav_page, current_page_num)
                if not next_url:
                    logger.log("No more pages available", colors=["GREEN", "SUCCESS"])
                    break

                current_page_num += 1

            except Exception as e:
                logger.log(
                    f"Error processing page {current_page_num}: {str(e)}",
                    colors=["RED", "ERROR"],
                )
                # Try to continue with next page
                current_page_num += 1
                if current_page_num > 100:  # Safety limit
                    logger.log(
                        "Reached maximum page limit (100)", colors=["RED", "ERROR"]
                    )
                    break
                continue

        logger.log(
            f"Completed! Total videos processed: {total_videos_found}",
            colors=["GREEN", "SUCCESS"],
        )

    finally:
        # Cleanup
        try:
            await context.close()
        except Exception as e:
            logger.log(f"Error closing context: {str(e)}", colors=["RED", "ERROR"])


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Open video watch URLs by code from missav.ws"
    )
    parser.add_argument("code", type=str, help='The code to search for (e.g., "wnz")')
    parser.add_argument(
        "--headless",
        action="store_true",
        default=False,
        help="Run browser in headless mode (default: False)",
    )
    parser.add_argument(
        "--wait-time",
        type=int,
        default=3000,
        help="Time in milliseconds to wait for JS to load (default: 3000)",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=5,
        help="Number of parallel browser tasks (default: 5)",
    )

    args = parser.parse_args()

    asyncio.run(
        process_search_pages(
            code=args.code,
            headless=args.headless,
            js_wait_time_ms=args.wait_time,
            num_parallel=args.parallel,
        )
    )


if __name__ == "__main__":
    main()

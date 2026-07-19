"""
Clear the current analysis session topic mapping.

Usage:
    python run_reset_topics.py
    python run_reset_topics.py --force
"""

import argparse

from config import init_config

init_config()
from rich.console import Console
from services.analysis_service import get_topic_count, reset_topics

console = Console()

parser = argparse.ArgumentParser(
    description="Clear the current analysis session topic mapping. "
    "This allows re-running topic extraction with different parameters."
)
parser.add_argument(
    "--force",
    action="store_true",
    help="Skip confirmation prompt",
)
args = parser.parse_args()

before_count = get_topic_count()

if before_count == 0:
    console.print("ℹ️  No topics to reset — session is already clear.")
    exit(0)

if not args.force:
    console.print(
        f"⚠️  [yellow]This will clear the topic mapping ({before_count} topics, "
        f"see run_get_video_topic_map.py to view).[/yellow]"
    )
    response = input("Continue? [y/N]: ").strip().lower()
    if response not in ("y", "yes"):
        console.print("❌ Reset cancelled.")
        exit(0)

console.print(f"🔄 Resetting topic mapping ({before_count} topics)...")
reset_topics()

after_count = get_topic_count()
console.print(f"\n✅ [bold green]Topic mapping cleared![/bold green]")
console.print(f"   Before: {before_count} topics → After: {after_count} topics")
console.print("   You can now run run_extract_topics.py with new parameters.")

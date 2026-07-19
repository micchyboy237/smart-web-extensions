"""
Quick check: how many unique topics are in the current analysis session.
Automatically extracts topics if none are found in the session.
Usage:
    python run_get_topic_count.py
"""

import argparse

from config import init_config

init_config()
from rich.console import Console
from services.analysis_service import (
    extract_topics,
    get_topic_count,
    get_video_topic_map,
)

console = Console()

parser = argparse.ArgumentParser(
    description="Quick check of how many topics are in the current analysis session. "
    "Auto-extracts topics if the session is empty."
)
args = parser.parse_args()

console.print("📊 Checking topic count...")
count = get_topic_count()

if count == 0:
    console.print("   ⚠️  No topics in session — running extraction now...")
    result = extract_topics()
    topics = result.get("topics", [])
    count = len(topics)
    if count == 0:
        console.print("\n❌ [red]Topic extraction returned no topics.[/red]")
        console.print("   Make sure ChromaDB has videos with embeddings stored.")
        exit(1)
    console.print(f"   ✅ Extracted {count} topics on-the-fly.")

mapping = get_video_topic_map()
console.print(
    f"\n✅ [bold green]{count} unique topics[/bold green] found across {len(mapping)} videos."
)

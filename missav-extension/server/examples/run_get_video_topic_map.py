"""
View the current video_id → topic_id mapping from the analysis session.
Auto-extracts topics if none are found in the session.
Usage:
    python run_get_video_topic_map.py
    python run_get_video_topic_map.py --summary
"""

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path

from config import init_config

init_config()
from rich.console import Console
from rich.table import Table
from services.analysis_service import (
    extract_topics,
    get_topic_count,
    get_video_topic_map,
)

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(
    description="View the current video_id → topic_id mapping. "
    "Auto-extracts topics if the session is empty."
)
parser.add_argument(
    "--summary",
    action="store_true",
    help="Show only topic distribution summary (not full mapping)",
)
args = parser.parse_args()

topic_count = get_topic_count()
if topic_count == 0:
    console.print("   ⚠️  No topics in session — running extraction now...")
    result = extract_topics()
    topics = result.get("topics", [])
    topic_count = len(topics)
    if topic_count == 0:
        console.print("❌ [red]Topic extraction returned no topics.[/red]")
        console.print("   Make sure ChromaDB has videos with embeddings stored.")
        exit(1)
    console.print(f"   ✅ Extracted {topic_count} topics on-the-fly.")
else:
    console.print(f"   📊 Found {topic_count} topics in session.")

console.print("🗺️  Retrieving video→topic mapping...")
mapping = get_video_topic_map()
console.print(f"   Total videos mapped: {len(mapping)}")
console.print(f"   Unique topics: {topic_count}")

# Convert numpy int32 keys/values to native Python int for JSON serialization
serializable_mapping = {str(k): int(v) for k, v in mapping.items()}

mapping_file = OUTPUT_DIR / "video_topic_map.json"
with open(mapping_file, "w", encoding="utf-8") as f:
    json.dump(serializable_mapping, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved full mapping to: [bold bright_blue][link=file://{mapping_file.resolve()}]{mapping_file.name}[/link][/bold bright_blue]"
)

# Convert topic IDs to int for Counter (numpy int32 → int)
topic_dist = Counter(int(v) for v in mapping.values())
dist_file = OUTPUT_DIR / "topic_distribution.json"
with open(dist_file, "w", encoding="utf-8") as f:
    json.dump(dict(sorted(topic_dist.items())), f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved topic distribution to: [bold bright_blue][link=file://{dist_file.resolve()}]{dist_file.name}[/link][/bold bright_blue]"
)

console.print("\n✅ Topic mapping retrieved!")
table = Table(title="Topic Distribution", show_header=True, header_style="bold cyan")
table.add_column("Topic ID", style="dim", width=10)
table.add_column("Video Count", justify="right", width=14)
table.add_column("Bar", width=40)

max_count = max(topic_dist.values()) if topic_dist else 1
for topic_id, count in sorted(topic_dist.items()):
    bar = "█" * int(40 * count / max_count)
    table.add_row(str(topic_id), str(count), bar)
console.print(table)

if not args.summary:
    console.print("\n📋 Sample mapping (first 10 entries):")
    for i, (vid, tid) in enumerate(serializable_mapping.items()):
        if i >= 10:
            console.print(
                f"   ... and {len(serializable_mapping) - 10} more (see JSON file)"
            )
            break
        console.print(f"   {vid} → topic {tid}")

"""
Extract topics from ChromaDB video embeddings using KMeans clustering.

Usage:
    python run_extract_topics.py
    python run_extract_topics.py --min-topic-size 5 --top-n-words 15
    python run_extract_topics.py --n-topics 10 --no-representative-docs
    python run_extract_topics.py --video-ids vid1 vid2 vid3
"""

import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from rich.console import Console
from rich.table import Table
from services.analysis_service import extract_topics, get_topic_count

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(
    description="Extract topics from ChromaDB video embeddings via KMeans clustering."
)
parser.add_argument(
    "--video-ids",
    type=str,
    nargs="*",
    default=None,
    help="Specific video IDs to analyze (omit for all videos)",
)
parser.add_argument(
    "--min-topic-size",
    type=int,
    default=3,
    help="Minimum documents per topic (default: 3)",
)
parser.add_argument(
    "--top-n-words",
    type=int,
    default=10,
    help="Number of keywords per topic (default: 10)",
)
parser.add_argument(
    "--n-topics",
    type=int,
    default=None,
    help="Force a specific number of topics (auto-detected if omitted)",
)
parser.add_argument(
    "--n-representative-docs",
    type=int,
    default=4,
    help="Max representative docs per topic. Use -1 for all (default: 4)",
)
args = parser.parse_args()

video_ids = args.video_ids if args.video_ids else None
min_topic_size = args.min_topic_size
top_n_words = args.top_n_words
n_topics = args.n_topics
n_representative_docs = (
    args.n_representative_docs if args.n_representative_docs >= 0 else None
)

console.print(
    f"🔬 [Step 1/1] Extracting topics "
    f"(video_ids={'provided' if video_ids else 'all'}, "
    f"min_topic_size={min_topic_size}, top_n_words={top_n_words}"
    f"{', n_topics=' + str(n_topics) if n_topics else ''})"
)

result = extract_topics(
    video_ids=video_ids,
    min_topic_size=min_topic_size,
    top_n_words=top_n_words,
    n_topics=n_topics,
    n_representative_docs=n_representative_docs,
)

topics = result.get("topics", [])
console.print(
    f"   Extracted {len(topics)} topics from {result.get('topic_info', None)}"
)

# Save full result
topics_file = OUTPUT_DIR / "topics.json"
serializable_topics = []
for t in topics:
    serializable_topics.append(
        {
            "topic_id": t["topic_id"],
            "name": t["name"],
            "keywords": t["keywords"],
            "size": t["size"],
            "representative_docs": t.get("representative_docs", []),
            "video_ids": t.get("video_ids", []),
        }
    )

with open(topics_file, "w", encoding="utf-8") as f:
    json.dump(serializable_topics, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved topics to: [bold bright_blue][link=file://{topics_file.resolve()}]{topics_file.name}[/link][/bold bright_blue]"
)

# Save topic_info as CSV for easy viewing
topic_info = result.get("topic_info")
if topic_info is not None:
    topic_info_file = OUTPUT_DIR / "topic_info.csv"
    topic_info.to_csv(topic_info_file, index=False)
    console.print(
        f"💾 Saved topic info to: [bold bright_blue][link=file://{topic_info_file.resolve()}]{topic_info_file.name}[/link][/bold bright_blue]"
    )

console.print("\n✅ Topic extraction complete!")
console.print(f"   Total topics: {len(topics)}")
console.print(f"   Current session topic count: {get_topic_count()}")

# Display topic summary table
if topics:
    table = Table(title="Topic Summary", show_header=True, header_style="bold cyan")
    table.add_column("ID", style="dim", width=4)
    table.add_column("Name", width=30)
    table.add_column("Size", justify="right", width=6)
    table.add_column("Top Keywords", width=60)

    for t in topics[:10]:
        table.add_row(
            str(t["topic_id"]),
            t["name"],
            str(t["size"]),
            ", ".join(t["keywords"][:5]),
        )

    console.print(table)

    if len(topics) > 10:
        console.print(f"   ... and {len(topics) - 10} more topics (see topics.json)")

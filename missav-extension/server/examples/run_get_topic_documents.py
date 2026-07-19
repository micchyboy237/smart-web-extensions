"""
Get video documents assigned to a specific topic after extraction.
Auto-extracts topics if none are found in the session.
Usage:
    python run_get_topic_documents.py 0
    python run_get_topic_documents.py 3 --limit 10
"""

import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from rich.console import Console
from services.analysis_service import (
    extract_topics,
    get_topic_count,
    get_topic_documents,
)

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(
    description="Get video documents assigned to a specific topic. "
    "Auto-extracts topics if the session is empty."
)
parser.add_argument(
    "topic_id",
    type=int,
    help="Topic ID to retrieve videos for (e.g. 0, 1, 2...)",
)
parser.add_argument(
    "--limit",
    type=int,
    default=None,
    help="Max number of video documents to return (default: all)",
)
args = parser.parse_args()

topic_id = args.topic_id
limit = args.limit

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

console.print(f"📋 Getting video documents for topic {topic_id}...")
documents = get_topic_documents(topic_id)

if limit:
    documents = documents[:limit]

console.print(f"   Found {len(documents)} video(s) for topic {topic_id}")

docs_file = OUTPUT_DIR / f"topic_{topic_id}_documents.json"
with open(docs_file, "w", encoding="utf-8") as f:
    json.dump(documents, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved documents to: [bold bright_blue][link=file://{docs_file.resolve()}]{docs_file.name}[/link][/bold bright_blue]"
)

console.print(f"\n✅ Topic {topic_id} document retrieval complete!")
for doc in documents[:5]:
    console.print(f"   📄 [{doc.get('id', '?')}] {doc.get('document', '')[:100]}...")
if len(documents) > 5:
    console.print(f"   ... and {len(documents) - 5} more documents (see JSON file)")

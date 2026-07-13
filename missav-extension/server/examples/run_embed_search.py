import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()

import chroma_service
from rich.console import Console

# Initialize Rich console
console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(description="Search ChromaService with a query.")
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
args = parser.parse_args()

query = args.query
top_k = 100
where = None
where_document = None

# Step 1: Search Chroma
search_results = chroma_service.search(
    query=query,
    top_k=top_k,
    where=where,
    where_document=where_document,
)

# Step 4: Merge hybrid results with original metadata
formatted_results = []
for index, item in enumerate(search_results):
    rank = index + 1
    original_item = search_results[index]
    metadata = original_item["metadata"]
    formatted_results.append(
        {
            "rank": rank,
            "score": item["score"],
            "id": item["id"],
            "video_id": metadata.get("video_id", ""),
            "code": metadata.get("code", ""),
            "episode": metadata.get("episode", ""),
            "url": metadata.get("url", ""),
            "document": item["document"],
        }
    )

search_results_file = OUTPUT_DIR / "search_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {search_results_file}")

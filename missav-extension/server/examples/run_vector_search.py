import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from rich.console import Console
from services import chroma_service

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(description="Search ChromaService with a query.")
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
parser.add_argument(
    "--top-k",
    type=int,
    default=100,
    help="Number of results to return (default: 100)",
)
parser.add_argument(
    "--threshold",
    type=float,
    default=0.7,
    help="Score threshold for search results (default: 0.7)",
)
parser.add_argument(
    "--diversity",
    type=float,
    default=0.5,
    help="Diversity value for result selection (0.0=relevance only, 1.0=max diversity, default: 0.5)",
)
parser.add_argument(
    "--shuffle-seed",
    type=int,
    default=None,
    help="Optional random seed for shuffling and diversity (default: None)",
)
args = parser.parse_args()

query = args.query
top_k = args.top_k
where = None
where_document = None
score_threshold = args.threshold
diversity = args.diversity
shuffle_seed = args.shuffle_seed

console.print(
    f"🔍 Vector search for query: '{query}' (top_k={top_k}, threshold={score_threshold}, diversity={diversity}, shuffle_seed={shuffle_seed})"
)

search_results = chroma_service.search(
    query=query,
    top_k=top_k,
    where=where,
    where_document=where_document,
    score_threshold=score_threshold,
    diversity=diversity,
    shuffle_seed=shuffle_seed,
)

console.print(f"   Retrieved {len(search_results)} results")

formatted_results = []
for index, item in enumerate(search_results):
    rank = index + 1
    original_item = search_results[index]
    metadata = original_item["metadata"]
    formatted_results.append(
        {
            "rank": rank,
            "score": item["score"],
            **metadata,
        }
    )

search_results_file = OUTPUT_DIR / "search_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)

console.print(
    f"💾 Saved results to: [bold bright_blue][link=file://{search_results_file.resolve()}]{search_results_file.name}[/link][/bold bright_blue]"
)
console.print(f"\n✅ Vector search complete! Top {len(formatted_results[:5])} results:")
for result in formatted_results[:5]:
    console.print(
        f"   #{result['rank']} [score:{result['score']:.4f}] {result['text'][:80]}..."
    )

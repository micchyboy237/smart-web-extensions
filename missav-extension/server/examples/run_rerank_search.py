import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from jet.adapters.llama_cpp.rerank_utils import rerank
from rich.console import Console
from services import chroma_service

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(description="Rerank search with ChromaService.")
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
parser.add_argument(
    "--candidates",
    type=int,
    default=100,
    help="Number of candidates from initial semantic search (default: 100)",
)
parser.add_argument(
    "--top-k",
    type=int,
    default=10,
    help="Number of final results after reranking (default: 10)",
)
parser.add_argument(
    "--threshold",
    type=float,
    default=0.7,
    help="Score threshold for initial semantic search (default: 0.7)",
)
args = parser.parse_args()

query = args.query
candidates_count = args.candidates
final_top_k = args.top_k
where = None
where_document = None
score_threshold = args.threshold

# Step 1: Get candidates from ChromaDB semantic search
console.print(f"🔍 [Step 1/2] Semantic search for candidates: '{query}'")
search_results = chroma_service.search(
    query=query,
    top_k=candidates_count,
    where=where,
    where_document=where_document,
    score_threshold=score_threshold,
)
console.print(f"   Retrieved {len(search_results)} candidates")

# Step 2: Extract documents and rerank
docs = [item["metadata"]["text"] for item in search_results]
doc_ids = [item["id"] for item in search_results]

console.print(f"🔄 [Step 2/2] Reranking {len(docs)} candidates to top {final_top_k}")
rerank_results = rerank(query, docs, top_n=final_top_k)

# Format results
formatted_results = []
for rank, rr in enumerate(rerank_results, start=1):
    original_item = search_results[rr["index"]]
    metadata = original_item["metadata"]
    formatted_results.append(
        {
            "rank": rank,
            "score": rr["score"],
            **metadata,
            "original_rank": rr["index"] + 1,  # +1 because ranks start at 1
            "original_semantic_score": original_item["score"],
        }
    )

# Save results
docs_file = OUTPUT_DIR / "candidates.json"
with open(docs_file, "w", encoding="utf-8") as f:
    json.dump(docs, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved candidates to: [bold bright_blue][link=file://{docs_file.resolve()}]{docs_file.name}[/link][/bold bright_blue]"
)

search_results_file = OUTPUT_DIR / "semantic_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(search_results, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved semantic results to: [bold bright_blue][link=file://{search_results_file.resolve()}]{search_results_file.name}[/link][/bold bright_blue]"
)

rerank_results_file = OUTPUT_DIR / "rerank_results.json"
with open(rerank_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved rerank results to: [bold bright_blue][link=file://{rerank_results_file.resolve()}]{rerank_results_file.name}[/link][/bold bright_blue]"
)

# Summary
console.print("\n✅ Rerank search complete!")
console.print(f"   Top {len(formatted_results)} results:")
for result in formatted_results[:5]:
    console.print(
        f"   #{result['rank']} [rerank:{result['score']:.4f}] "
        f"[semantic:{result['original_semantic_score']:.4f}] "
        f"{result['text'][:80]}..."
    )

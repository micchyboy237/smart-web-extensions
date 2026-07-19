import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from jet.adapters.llama_cpp.hybrid_utils import hybrid_search
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
    default=10,
    help="Number of final results to return (default: 10)",
)
parser.add_argument(
    "--embed-candidates",
    type=int,
    default=100,
    help="Number of initial semantic candidates (default: 100)",
)
parser.add_argument(
    "--threshold",
    type=float,
    default=0.7,
    help="Score threshold for initial semantic search (default: 0.7)",
)
args = parser.parse_args()

query = args.query
top_k = args.top_k
embed_candidates = args.embed_candidates
where = None
where_document = None
score_threshold = args.threshold

console.print(
    f"🔍 [Step 1/3] Semantic search for candidates: '{query}' "
    f"(embed_candidates={embed_candidates}, threshold={score_threshold})"
)

search_results = chroma_service.search(
    query=query,
    top_k=embed_candidates,
    where=where,
    where_document=where_document,
    score_threshold=score_threshold,
)

console.print(f"   Retrieved {len(search_results)} candidates")

docs = [item["metadata"]["text"] for item in search_results]
doc_ids = [item["id"] for item in search_results]

console.print("📊 [Step 2/3] Fetching stored embeddings from ChromaDB")
doc_embs = chroma_service.get_embeddings(doc_ids)

if doc_embs is not None:
    doc_embs_list = doc_embs.tolist()
    console.print(f"   Reusing {len(doc_embs_list)} embeddings from Chroma")
else:
    doc_embs_list = None
    console.print("   ⚠️  No stored embeddings found, will compute fresh")

console.print(f"🧬 [Step 3/3] Running hybrid search (top_k={top_k})")
hybrid_search_results = hybrid_search(
    query=query,
    documents=docs,
    top_k=top_k,
    embed_candidates=embed_candidates,
    doc_embeddings=doc_embs_list,
)

formatted_results = []
for rank, hr in enumerate(hybrid_search_results, start=1):
    original_item = search_results[hr["original_index"]]
    metadata = original_item["metadata"]
    formatted_results.append(
        {
            "rank": rank,
            "score": hr["score"],
            "id": original_item["id"],
            "video_id": metadata.get("video_id", ""),
            "code": metadata.get("code", ""),
            "episode": metadata.get("episode", ""),
            "url": metadata.get("url", ""),
            "document": hr["document"],
        }
    )

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

hybrid_search_results_file = OUTPUT_DIR / "hybrid_search_results.json"
with open(hybrid_search_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved hybrid results to: [bold bright_blue][link=file://{hybrid_search_results_file.resolve()}]{hybrid_search_results_file.name}[/link][/bold bright_blue]"
)

console.print("\n✅ Hybrid search complete!")
console.print(f"   Top {len(formatted_results[:5])} results:")
for result in formatted_results[:5]:
    console.print(
        f"   #{result['rank']} [score:{result['score']:.4f}] "
        f"{result['document'][:80]}..."
    )

import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()

import chroma_service
from jet.adapters.llama_cpp.hybrid_utils import hybrid_search_with_keywords
from rich.console import Console

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(
    description="Hybrid search with keywords (BM25 + Embeddings + optional Reranker)."
)
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
parser.add_argument(
    "--embed-weight",
    type=float,
    default=0.5,
    help="Weight for embedding similarity (default: 0.5)",
)
parser.add_argument(
    "--keyword-weight",
    type=float,
    default=0.5,
    help="Weight for keyword/BM25 similarity (default: 0.5)",
)
parser.add_argument(
    "--no-reranker",
    action="store_true",
    help="Disable the reranker final stage",
)
parser.add_argument(
    "--embed-candidates",
    type=int,
    default=100,
    help="Number of candidates to pass to reranker stage (default: 100)",
)
parser.add_argument(
    "--top-k",
    type=int,
    default=10,
    help="Number of final results to return (default: 10)",
)
args = parser.parse_args()

query = args.query
embed_weight = args.embed_weight
keyword_weight = args.keyword_weight
use_reranker = not args.no_reranker
embed_candidates = args.embed_candidates
top_k = args.top_k
where = None
where_document = None

console.print(f"🔍 [Step 1/4] Semantic search for initial candidates: '{query}'")
search_results = chroma_service.search(
    query=query,
    top_k=embed_candidates,
    where=where,
    where_document=where_document,
)
console.print(f"   Retrieved {len(search_results)} candidates")

docs = [item["metadata"]["text"] for item in search_results]
doc_ids = [item["id"] for item in search_results]

console.print("📊 [Step 2/4] Fetching stored embeddings from ChromaDB")
doc_embs = chroma_service.get_embeddings(doc_ids)
if doc_embs is not None:
    doc_embs_list = doc_embs.tolist()
    console.print(f"   Reusing {len(doc_embs_list)} embeddings from ChromaDB")
else:
    doc_embs_list = None
    console.print("   ⚠️  No stored embeddings found, will compute fresh")

console.print(
    f"🧬 [Step 3/4] Running hybrid keyword search "
    f"(embed:{embed_weight}, keyword:{keyword_weight}, reranker:{use_reranker})"
)
hybrid_keyword_results = hybrid_search_with_keywords(
    query=query,
    documents=docs,
    top_k=top_k,
    embed_weight=embed_weight,
    keyword_weight=keyword_weight,
    use_reranker=use_reranker,
    embed_candidates=embed_candidates,
    doc_embeddings=doc_embs_list,
)

console.print("📝 [Step 4/4] Formatting and saving results")
formatted_results = []
for rank, hr in enumerate(hybrid_keyword_results, start=1):
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
            "original_index": hr["original_index"],
            "original_semantic_score": original_item["score"],
            "keyword_score": hr["keyword_score"],
            "embed_score": hr["embed_score"],
        }
    )

# Save intermediate docs
docs_file = OUTPUT_DIR / "candidates.json"
with open(docs_file, "w", encoding="utf-8") as f:
    json.dump(docs, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved candidates to: [bold bright_blue][link=file://{docs_file.resolve()}]{docs_file.name}[/link][/bold bright_blue]"
)

# Save raw semantic search results
search_results_file = OUTPUT_DIR / "semantic_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(search_results, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved semantic results to: [bold bright_blue][link=file://{search_results_file.resolve()}]{search_results_file.name}[/link][/bold bright_blue]"
)

# Save final hybrid keyword results
hybrid_keyword_results_file = OUTPUT_DIR / "hybrid_keyword_results.json"
with open(hybrid_keyword_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved hybrid keyword results to: [bold bright_blue][link=file://{hybrid_keyword_results_file.resolve()}]{hybrid_keyword_results_file.name}[/link][/bold bright_blue]"
)

# Print summary
console.print("\n✅ Hybrid keyword search complete!")
console.print(
    f"   Top {len(formatted_results)} results "
    f"(embed:{embed_weight}, keyword:{keyword_weight}, reranker:{use_reranker}):"
)
for result in formatted_results[:5]:
    console.print(
        f"   #{result['rank']} [total:{result['score']:.4f}] "
        f"[kw:{result['keyword_score']:.4f}] [emb:{result['embed_score']:.4f}] "
        f"[semantic:{result['original_semantic_score']:.4f}] "
        f"{result['document'][:80]}..."
    )

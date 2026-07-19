import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
from jet.adapters.llama_cpp.ensemble_utils import ensemble_search
from jet.transformers.object import make_serializable
from rich.console import Console
from services import chroma_service

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(description="Ensemble search with ChromaService.")
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
parser.add_argument(
    "--top-k",
    type=int,
    default=10,
    help="Number of final ensemble results to return (default: 10)",
)
parser.add_argument(
    "--candidates",
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
parser.add_argument(
    "--weights",
    type=str,
    default=None,
    help='JSON string of weights (e.g. \'{"embedding":0.4,"keyword":0.3,"reranker":0.3}\')',
)
args = parser.parse_args()

query = args.query
top_k = args.top_k
candidates_count = args.candidates
where = None
where_document = None
score_threshold = args.threshold

weights = None
if args.weights:
    import json as json_module

    weights = json_module.loads(args.weights)
    console.print(f"⚖️  Using custom weights: {weights}")

console.print(
    f"🔍 [Step 1/3] Semantic search for candidates: '{query}' "
    f"(candidates={candidates_count}, threshold={score_threshold})"
)

search_results = chroma_service.search(
    query=query,
    top_k=candidates_count,
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
    console.print(f"   Reusing {len(doc_embs_list)} embeddings from ChromaDB")
else:
    doc_embs_list = None
    console.print("   ⚠️  No stored embeddings found, will compute fresh")

ensemble_top_k = min(top_k, len(docs))
console.print(
    f"🧬 [Step 3/3] Running ensemble search (embedding + keyword + reranker, top_k={ensemble_top_k})"
)

ensemble_results = ensemble_search(
    query=query,
    documents=docs,
    top_k=ensemble_top_k,
    return_details=True,
    weights=weights,
    doc_embeddings=doc_embs_list,
)

formatted_results = []
for rank, er in enumerate(ensemble_results, start=1):
    original_item = search_results[er["index"]]
    metadata = original_item["metadata"]
    formatted_results.append(
        {
            "rank": rank,
            "score": er["score"],
            "id": original_item["id"],
            "video_id": metadata.get("video_id", ""),
            "code": metadata.get("code", ""),
            "episode": metadata.get("episode", ""),
            "url": metadata.get("url", ""),
            "document": er["document"],
            "original_rank": er["index"] + 1,
            "original_semantic_score": original_item["score"],
            "signals": er.get("signals", {}),
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

ensemble_results_file = OUTPUT_DIR / "ensemble_results.json"
with open(ensemble_results_file, "w", encoding="utf-8") as f:
    json.dump(make_serializable(formatted_results), f, indent=2, ensure_ascii=False)
console.print(
    f"💾 Saved ensemble results to: [bold bright_blue][link=file://{ensemble_results_file.resolve()}]{ensemble_results_file.name}[/link][/bold bright_blue]"
)

console.print("\n✅ Ensemble search complete!")
console.print(f"   Top {len(ensemble_results)} results with signal breakdown:")
for result in formatted_results[:5]:
    signals_str = " | ".join(
        [f"{name}:{score:.3f}" for name, score in result.get("signals", {}).items()]
    )
    console.print(
        f"   #{result['rank']} [score:{result['score']:.4f}] "
        f"[original_rank:{result['original_rank']}] "
        f"[semantic:{result['original_semantic_score']:.4f}] "
        f"{result['document'][:80]}..."
    )
    console.print(f"      Signals: {signals_str}")

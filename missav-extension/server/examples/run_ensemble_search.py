import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()
import chroma_service
from jet.adapters.llama_cpp.ensemble_utils import ensemble_search
from jet.transformers.object import make_serializable
from rich.console import Console

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

parser = argparse.ArgumentParser(description="Ensemble search with ChromaService.")
parser.add_argument("query", type=str, help="Search query (e.g. 'amazing videos')")
parser.add_argument(
    "--weights",
    type=str,
    default=None,
    help='JSON string of weights (e.g. \'{"embedding":0.4,"keyword":0.3,"reranker":0.3}\')',
)
args = parser.parse_args()

query = args.query
top_k = 100
where = None
where_document = None

# Parse weights if provided
weights = None
if args.weights:
    import json as json_module

    weights = json_module.loads(args.weights)
    console.print(f"⚖️  Using custom weights: {weights}")

# Step 1: Get initial candidates from ChromaDB semantic search
console.print(f"🔍 [Step 1/3] Semantic search for query: '{query}'")
search_results = chroma_service.search(
    query=query,
    top_k=top_k,
    where=where,
    where_document=where_document,
)
console.print(f"   Retrieved {len(search_results)} candidates")

# Step 2: Extract documents and try to get pre-computed embeddings
docs = [item["metadata"]["text"] for item in search_results]
doc_ids = [item["id"] for item in search_results]

# Try to reuse embeddings from ChromaDB
doc_embs = chroma_service.get_embeddings(doc_ids)
if doc_embs is not None:
    doc_embs_list = doc_embs.tolist()
    console.print(
        f"🔁 [Step 2/3] Reusing {len(doc_embs_list)} embeddings from ChromaDB"
    )
else:
    doc_embs_list = None
    console.print("⚠️  [Step 2/3] No stored embeddings found, will compute fresh")

# Step 3: Run ensemble search with all signals
console.print("🧬 [Step 3/3] Running ensemble search (embedding + keyword + reranker)")
ensemble_results = ensemble_search(
    query=query,
    documents=docs,
    top_k=min(10, len(docs)),
    return_details=True,
    weights=weights,
    doc_embeddings=doc_embs_list,
)

# Format results
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
            "original_rank": er["index"] + 1,  # +1 because ranks start at 1
            "original_semantic_score": original_item["score"],
            "signals": er.get("signals", {}),
        }
    )

# Save outputs with clickable file links
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

# Summary
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

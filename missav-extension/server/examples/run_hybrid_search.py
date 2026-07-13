import argparse
import json
import shutil
from pathlib import Path

from config import init_config

init_config()

import chroma_service
from jet.adapters.llama_cpp.hybrid_utils import hybrid_search
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

docs = [item["metadata"]["text"] for item in search_results]

# Step 2: Get document embeddings from Chroma (already stored!)
doc_ids = [item["id"] for item in search_results]
doc_embs = chroma_service.get_embeddings(doc_ids)

if doc_embs is not None:
    doc_embs_list = doc_embs.tolist()
    console.print(f"🔁 Reusing {len(doc_embs_list)} embeddings from Chroma")
else:
    doc_embs_list = None
    console.print("⚠️ No stored embeddings found, will recompute")

# Step 3: Hybrid search with pre-computed doc embeddings
hybrid_search_results = hybrid_search(
    query=query,
    documents=docs,
    top_k=10,
    embed_candidates=100,
    doc_embeddings=doc_embs_list,
)

# Step 4: Merge hybrid results with original metadata
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

# Save results...

docs_file = OUTPUT_DIR / "docs.json"
with open(docs_file, "w", encoding="utf-8") as f:
    json.dump(docs, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {docs_file}")

search_results_file = OUTPUT_DIR / "search_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(search_results, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {search_results_file}")

hybrid_search_results_file = OUTPUT_DIR / "hybrid_search_results.json"
with open(hybrid_search_results_file, "w", encoding="utf-8") as f:
    json.dump(formatted_results, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {hybrid_search_results_file}")

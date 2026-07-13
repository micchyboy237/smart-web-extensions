import argparse
import json
import shutil
from pathlib import Path

from config import init_config
from jet.transformers.object import make_serializable

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
top_k = 20
where = None
where_document = None

search_results = chroma_service.search(
    query=query,
    top_k=top_k,
    where=where,
    where_document=where_document,
)

docs = [item["metadata"]["text"] for item in search_results]

hybrid_search_results = hybrid_search(
    query=query, documents=docs, top_k=10, embed_candidates=100
)

search_results_file = OUTPUT_DIR / "search_results.json"
with open(search_results_file, "w", encoding="utf-8") as f:
    json.dump(search_results, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {search_results_file}")

docs_file = OUTPUT_DIR / "docs.json"
with open(docs_file, "w", encoding="utf-8") as f:
    json.dump(docs, f, indent=2, ensure_ascii=False)
print(f"Saved results to: {docs_file}")

hybrid_search_results_file = OUTPUT_DIR / "hybrid_search_results.json"
with open(hybrid_search_results_file, "w", encoding="utf-8") as f:
    json.dump(make_serializable(hybrid_search_results), f, indent=2, ensure_ascii=False)
print(f"Saved results to: {hybrid_search_results_file}")

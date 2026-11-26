"""Document Clustering Pipeline with File I/O.

Clusters documents using LLM-based semantic analysis and saves both input
documents and clustering results to the OUTPUT_DIR.
"""

import json
import shutil
from pathlib import Path

from jet.adapters.llama_cpp.cluster_utils.clusterer_llm import run_clustering_pipeline
from jet.libs.bertopic.examples.mock import load_missav_videos
from jet.logger import logger
from rich.console import Console

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Define output file paths
INPUT_FILE = OUTPUT_DIR / "input_documents.json"
RESULTS_FILE = OUTPUT_DIR / "clustering_results.json"
SUMMARY_FILE = OUTPUT_DIR / "summary.txt"


def save_input_documents(documents: list[str], filepath: Path) -> None:
    """Save the input documents to a JSON file.

    Args:
        documents: List of document strings.
        filepath: Path to save the JSON file.
    """
    data = {
        "total_documents": len(documents),
        "documents": [{"index": i, "content": doc} for i, doc in enumerate(documents)],
    }
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    logger.info(f"💾 Saved {len(documents)} input documents to {filepath}")


def save_clustering_results(
    clustered: dict[int, dict], documents: list[str], filepath: Path
) -> None:
    """Save clustering results to a JSON file.

    Args:
        clustered: Dictionary mapping cluster_id to cluster info.
        documents: Original list of document strings.
        filepath: Path to save the JSON file.
    """
    # Convert to serializable format
    results = {
        "total_clusters": len(clustered),
        "total_documents": sum(
            len(info["document_indices"]) for info in clustered.values()
        ),
        "clusters": {},
    }

    for cluster_id, info in sorted(clustered.items()):
        results["clusters"][str(cluster_id)] = {
            "topic": info["topic"],
            "document_count": len(info["document_indices"]),
            "document_indices": info["document_indices"],
            "documents": [
                {"index": idx, "content": documents[idx]}
                for idx in info["document_indices"]
            ],
        }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    logger.info(f"💾 Saved clustering results to {filepath}")


def save_summary(clustered: dict[int, dict], filepath: Path) -> None:
    """Save a human-readable summary to a text file.

    Args:
        clustered: Dictionary mapping cluster_id to cluster info.
        filepath: Path to save the summary file.
    """
    lines = []
    lines.append("=" * 80)
    lines.append("DOCUMENT CLUSTERING SUMMARY")
    lines.append("=" * 80)
    lines.append(f"Total Clusters: {len(clustered)}")
    lines.append(
        f"Total Documents: {sum(len(info['document_indices']) for info in clustered.values())}"
    )
    lines.append("")

    for cluster_id, info in sorted(clustered.items()):
        lines.append(f"📁 Cluster {cluster_id}: {info['topic']}")
        lines.append(f"   Documents: {len(info['document_indices'])}")
        lines.append(f"   Indices: {info['document_indices']}")
        lines.append("")

    lines.append("=" * 80)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    logger.info(f"💾 Saved summary to {filepath}")


if __name__ == "__main__":
    logger.info("🚀 Starting document clustering pipeline with file I/O")

    # Load documents
    documents = load_missav_videos(code=["gvh"])
    documents = documents[:30]
    logger.info(f"📄 Loaded {len(documents)} documents")

    # Save input documents
    save_input_documents(documents, INPUT_FILE)

    # Run the pipeline
    granularity = "balanced"
    clustered = run_clustering_pipeline(documents, granularity=granularity)

    # Save results
    save_clustering_results(clustered, documents, RESULTS_FILE)
    save_summary(clustered, SUMMARY_FILE)

    # Print results to console
    print("\n" + "=" * 80)
    print("DOCUMENT CLUSTERING RESULTS")
    print("=" * 80)

    for cluster_id, info in sorted(clustered.items()):
        print(f"\n📁 Cluster {cluster_id}: {info['topic']}")
        print(f"   Documents ({len(info['document_indices'])}):")
        for idx in info["document_indices"]:
            preview = (
                documents[idx][:100] + "..."
                if len(documents[idx]) > 100
                else documents[idx]
            )
            print(f"     [{idx}] {preview}")

    print("\n" + "=" * 80)

    # Display clickable links to saved files using Rich console
    console.print("\n[bold green]📂 Output files saved to:[/bold green]")
    console.print(f"   📄 [link=file://{INPUT_FILE.resolve()}]{INPUT_FILE.name}[/link]")
    console.print(
        f"   📊 [link=file://{RESULTS_FILE.resolve()}]{RESULTS_FILE.name}[/link]"
    )
    console.print(
        f"   📝 [link=file://{SUMMARY_FILE.resolve()}]{SUMMARY_FILE.name}[/link]"
    )
    console.print("=" * 80)

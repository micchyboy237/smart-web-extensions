import argparse
import shutil
from pathlib import Path

from jet.adapters.llama_cpp.cluster_utils import (
    TextsClusterer,
    print_cluster_analysis,
    save_cluster_results,
)
from jet.adapters.llama_cpp.config import (
    EMBED_DOC_PREFIX,
    EMBED_MODEL,
    EMBED_QUERY_PREFIX,
)
from jet.libs.bertopic.examples.mock import load_missav_videos

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def get_args():
    """Parse command line arguments with defaults from existing config."""
    parser = argparse.ArgumentParser(
        description="Extract topics from video descriptions."
    )
    parser.add_argument(
        "-c",
        "--code",
        type=str,
        nargs="+",
        default=None,
        help="List of codes to filter missav videos on (e.g. -c ssni ssis snis). Defaults to load_missav_videos default when omitted.",
    )
    parser.add_argument(
        "-l",
        "--limit",
        type=int,
        default=None,
        help="Max number of missav video rows to load. None (default) returns all.",
    )
    parser.add_argument(
        "-s",
        "--min-cluster-size",
        type=int,
        default=2,
        help="Minimum cluster size for HDBSCAN.",
    )
    parser.add_argument(
        "-e",
        "--epsilon",
        type=float,
        default=0.25,
        help="Cluster selection epsilon (lower=strict, higher=loose).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = get_args()
    docs, embeddings = load_missav_videos(
        code=["gvh"], limit=args.limit, include_embeddings=True
    )

    clusterer = TextsClusterer(
        model_name=EMBED_MODEL,
        query_prefix=EMBED_QUERY_PREFIX,
        doc_prefix=EMBED_DOC_PREFIX,
        min_cluster_size=args.min_cluster_size,
        cluster_selection_epsilon=args.epsilon,
    )
    results, analysis = clusterer.cluster(docs, embeddings=embeddings)

    print(
        f"\nInput: {results['n_original_texts']} texts -> "
        f"Unique: {results['n_unique_texts']} texts"
    )

    print("\n" + "=" * 60)
    print("DETAILED CLUSTER ANALYSIS:")
    print("=" * 60)
    print_cluster_analysis(analysis)

    print(f"\n{'=' * 60}")
    print(f"SUMMARY: {results['n_clusters']} clusters, {results['n_noise']} outliers")
    print(f"{'=' * 60}")

    summary = clusterer.get_summary(analysis)
    saved = save_cluster_results(
        OUTPUT_DIR,
        analysis,
        summary,
        coordinates_2d=clusterer.coordinates_2d,
        labels=clusterer.labels,
        texts=clusterer._unique_texts or [],
    )
    print(f"\nResults saved to {OUTPUT_DIR}")
    for name, path in saved.items():
        print(f"  {name}: {path}")

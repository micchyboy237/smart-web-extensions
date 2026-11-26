import argparse
import json
import math
import shutil
from pathlib import Path
from typing import Dict, List, Optional, TypedDict

from jet.adapters.llama_cpp.cluster_utils.clusterer import (
    NOISE_KEY,
    DetailedAnalysis,
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
from jet.logger import logger
from jet.wordnet.histogram import TextAnalysis

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class ClusterKeyword(TypedDict):
    ngram: str
    docs: int  # texts in the cluster containing this phrase
    coverage: float  # docs / cluster size, in [0, 1]
    collocations: int  # raw occurrence count
    n: int  # words in the phrase


class ClusterKeywordReport(TypedDict):
    count: int
    consistency_score: float
    keywords: Dict[str, int]  # ngram -> number of docs containing it
    documents: List[str]


def extract_cluster_keywords(
    analysis: DetailedAnalysis,
    *,
    ngram_range: tuple[int, int] = (1, 3),
    min_doc_ratio: float = 0.3,
    min_docs: int = 2,
    top_n: Optional[int] = None,  # Changed default to None (no limit)
    min_coverage: float = 0.0,  # New: minimum coverage threshold
    min_collocations: int = 0,  # New: minimum collocation count
    max_keywords_percent: float = 1.0,  # New: max % of candidates to keep
) -> Dict[str, List[ClusterKeyword]]:
    """
    Find common words/phrases per cluster.
    A phrase is kept if it appears in at least
    max(min_docs, ceil(min_doc_ratio * cluster_size)) different texts.

    Parameters:
    -----------
    top_n: If set, limits to top N keywords. None means no limit.
    min_coverage: Minimum coverage ratio (0.0-1.0) to include keyword.
    min_collocations: Minimum collocation count to include keyword.
    max_keywords_percent: Maximum percentage of candidate keywords to keep (0.0-1.0).

    Ranked by: coverage, then phrase length, then raw count.
    """
    keywords: Dict[str, List[ClusterKeyword]] = {}
    for name, info in analysis.items():
        if name == NOISE_KEY:
            continue
        texts: List[str] = info["all_texts"]
        size = len(texts)
        if size < min_docs:
            logger.warning("[keywords] %s skipped: only %d text(s)", name, size)
            continue
        threshold = max(min_docs, math.ceil(min_doc_ratio * size))
        logger.info("[keywords] %s: size=%d, need docs>=%d", name, size, threshold)

        histogram = TextAnalysis(texts, lowercase=True).generate_histogram(
            ngram_ranges=[ngram_range],
            apply_tfidf=True,
            is_top=True,
            remove_stopwords=True,
        )
        rows = histogram[0]["results"] if histogram else []

        # Filter by significance thresholds
        kept: List[ClusterKeyword] = [
            {
                "ngram": r["ngram"],
                "docs": r["docs"],
                "coverage": round(r["docs"] / size, 3),
                "collocations": r["collocations"],
                "n": r["n"],
            }
            for r in rows
            if r["docs"] >= threshold
        ]

        # Apply additional filters for significance
        if min_coverage > 0:
            kept = [k for k in kept if k["coverage"] >= min_coverage]

        if min_collocations > 0:
            kept = [k for k in kept if k["collocations"] >= min_collocations]

        # Sort by significance
        kept.sort(key=lambda k: (-k["coverage"], -k["n"], -k["collocations"]))

        # Apply max percentage limit if specified
        if max_keywords_percent < 1.0 and len(rows) > 0:
            max_count = max(1, int(len(rows) * max_keywords_percent))
            kept = kept[:max_count]

        # Apply top_n limit if specified
        if top_n:
            kept = kept[:top_n]

        keywords[name] = kept
        logger.info(
            "[keywords] %s: %d candidates -> %d kept | top=%s",
            name,
            len(rows),
            len(kept),
            [k["ngram"] for k in kept[:3]],
        )
    return keywords


def build_keywords_report(
    analysis: DetailedAnalysis,
    keywords: Dict[str, List[ClusterKeyword]],
) -> Dict[str, ClusterKeywordReport]:
    """
    Merge keywords with cluster info into one report,
    sorted by cluster count (largest first).
    """
    report: Dict[str, ClusterKeywordReport] = {}
    for name, items in keywords.items():
        info = analysis[name]
        report[name] = {
            "count": info["count"],
            "consistency_score": round(info.get("consistency_score", 0.0), 4),
            "keywords": {k["ngram"]: k["docs"] for k in items},
            "documents": list(info["all_texts"]),
        }

    def sort_key(kv):
        cluster_no = int(kv[0].split(" ")[1]) if kv[0].split(" ")[-1].isdigit() else 0
        return (-kv[1]["count"], cluster_no)

    report = dict(sorted(report.items(), key=sort_key))
    logger.info(
        "[keywords] report built: %s",
        [(n, r["count"]) for n, r in report.items()],
    )
    return report


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
    parser.add_argument(
        "-k",
        "--extract-keywords",
        action="store_true",
        help="Extract similar keywords per cluster.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = get_args()
    docs, embeddings = load_missav_videos(
        code=args.code,
        limit=args.limit,
        include_embeddings=True,
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

    if args.extract_keywords:
        keywords = extract_cluster_keywords(
            analysis,
            top_n=None,  # No limit
            min_coverage=0.2,  # At least 20% coverage
            min_collocations=2,  # At least 2 collocations
        )
        keywords_report = build_keywords_report(analysis, keywords)

        print("\n" + "=" * 60)
        print("CLUSTER KEYWORDS (largest cluster first):")
        print("=" * 60)
        for name, rep in keywords_report.items():
            shown = ", ".join(f"{ng} ({n})" for ng, n in rep["keywords"].items()) or "-"
            print(f"{name} [{rep['count']} texts]: {shown}")

        keywords_path = OUTPUT_DIR / "keywords.json"
        keywords_path.write_text(
            json.dumps(keywords_report, indent=2, ensure_ascii=False)
        )
        print(f"Keywords saved to {keywords_path}")

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

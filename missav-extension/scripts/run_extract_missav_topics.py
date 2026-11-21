"""
Demo: Topic Extraction Representative Docs
Enhanced topic extraction with improved representation models.
Demonstrates KeyBERT-inspired topic labeling, MMR diversity, and stop word removal
for cleaner, more meaningful topic keywords.
Uses reusable factory functions from jet.adapters.bertopic.factory_with_repr.
"""

import argparse
import json
import shutil
from pathlib import Path
from typing import List, Optional

from jet.adapters.llama_cpp.config import EMBED_MODEL_LG
from jet.libs.bertopic.monkey_patches.add_check_array import init_patch
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

init_patch()

from jet.adapters.bertopic.factory_with_repr import (
    TopicExtractionResult,
    create_bertopic_embedder,
    extract_topics,
    sanity_check_embedder,
)
from jet.libs.bertopic.examples.mock import load_missav_videos

console = Console()

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
        "-m",
        "--min-topic-size",
        type=int,
        default=3,
        help="Minimum number of documents per topic",
    )
    parser.add_argument(
        "-n",
        "--top-n-words",
        type=int,
        default=10,
        help="Number of keywords to extract per topic",
    )
    parser.add_argument(
        "-r",
        "--n-representative-docs",
        type=int,
        default=None,
        help="Max representative docs per topic. None returns all.",
    )
    parser.add_argument(
        "--no-mmr",
        action="store_true",
        help="Disable Maximal Marginal Relevance for diverse keywords (MMR is enabled by default)",
    )
    parser.add_argument(
        "-div",
        "--mmr-diversity",
        type=float,
        default=0.7,
        help="Diversity parameter for MMR (0-1)",
    )
    parser.add_argument(
        "--no-keybert",
        action="store_true",
        help="Disable KeyBERT inspired representation",
    )
    parser.add_argument(
        "-ng",
        "--n-gram-range",
        type=int,
        nargs=2,
        default=[1, 2],
        help="N-gram range for vectorizer (e.g., -ng 1 2)",
    )
    return parser.parse_args()


def run_topic_extraction_demo(
    documents: List[str],
    min_topic_size: int = 3,
    top_n_words: int = 10,
    n_representative_docs: Optional[int] = None,
    use_mmr: bool = True,
    mmr_diversity: float = 0.7,
    use_keybert: bool = True,
    n_gram_range: tuple[int, int] = (1, 2),
) -> TopicExtractionResult:
    """
    Demonstrate topic extraction using the reusable factory functions.

    Args:
        documents: List of text documents to analyze
        min_topic_size: Minimum documents per topic
        top_n_words: Number of keywords to extract per topic
        n_representative_docs: Max representative docs per topic.
            None (default) returns all available.
        use_mmr: Use Maximal Marginal Relevance for diverse keywords
        mmr_diversity: Diversity parameter for MMR
        use_keybert: Use KeyBERT inspired representation
        n_gram_range: The n-gram range for the vectorizer

    Returns:
        Structured topic extraction results
    """
    console.print(Panel.fit("[bold green]Starting Topic Extraction Demo[/bold green]"))
    console.print(
        f"[dim]Parameters: min_topic_size={min_topic_size}, top_n_words={top_n_words}, "
        f"n_representative_docs={n_representative_docs}, use_mmr={use_mmr}, "
        f"n_gram_range={n_gram_range}[/dim]"
    )
    console.print(f"[dim]Number of documents to process: {len(documents)}[/dim]")

    input_file = OUTPUT_DIR / "input_documents.json"
    with open(input_file, "w", encoding="utf-8") as f:
        json.dump(documents, f, indent=2, ensure_ascii=False)

    console.print("[yellow]Creating BERTopic embedder...[/yellow]")
    embedder = create_bertopic_embedder(model=EMBED_MODEL_LG)

    console.print("[yellow]Running embedder sanity check...[/yellow]")
    sanity_check_embedder(embedder)

    console.print("[yellow]Starting topic extraction...[/yellow]")
    result = extract_topics(
        documents=documents,
        embedder=embedder,
        min_topic_size=min_topic_size,
        top_n_words=top_n_words,
        remove_stop_words=True,
        use_keybert=use_keybert,
        use_mmr=use_mmr,
        mmr_diversity=mmr_diversity,
        n_representative_docs=n_representative_docs,
        n_gram_range=n_gram_range,
        verbose=True,
    )

    console.print(
        Panel.fit(
            f"[bold green]Extracted {len(result['topics'])} topics from {len(documents)} documents[/bold green]"
        )
    )

    for topic in result["topics"]:
        table = Table(
            title=f"Topic {topic['topic_id']}: {topic['name']} (Size: {topic['size']})"
        )
        table.add_column("Rank", style="cyan", justify="right")
        table.add_column("Keyword", style="magenta")
        table.add_column("Score", style="green")
        for i, ks in enumerate(topic["keyword_scores"][:10]):
            table.add_row(str(i + 1), ks["word"], f"{ks['score']:.4f}")
        console.print(table)

        if topic["representative_docs"]:
            console.print("[bold blue]Top Representative Documents:[/bold blue]")
            for i, ds in enumerate(topic["doc_scores"][:3]):
                preview = (
                    ds["text"][:100] + "..." if len(ds["text"]) > 100 else ds["text"]
                )
                console.print(f"  [{i + 1}] (Prob: {ds['score']:.2f}) {preview}")
        console.print("")

    outlier_indices = [
        i for i, label in enumerate(result["topic_labels"]) if label == -1
    ]
    outliers_data = {
        "count": len(outlier_indices),
        "indices": outlier_indices,
        "documents": [documents[i] for i in outlier_indices],
    }
    outliers_file = OUTPUT_DIR / "outliers.json"
    with open(outliers_file, "w", encoding="utf-8") as f:
        json.dump(outliers_data, f, indent=2, ensure_ascii=False)
    console.print(f"[dim]Outliers saved to: {outliers_file}[/dim]")

    topics_output = []
    for topic in result["topics"]:
        topics_output.append(
            {
                "topic_id": topic["topic_id"],
                "name": topic["name"],
                "keywords": topic["keywords"],
                "keyword_scores": topic["keyword_scores"],
                "size": topic["size"],
                "representative_docs": topic["representative_docs"],
                "doc_scores": topic["doc_scores"],
            }
        )
    topics_file = OUTPUT_DIR / "topics.json"
    with open(topics_file, "w", encoding="utf-8") as f:
        json.dump(topics_output, f, indent=2, ensure_ascii=False)
    console.print(f"[dim]Topics saved to: {topics_file}[/dim]")

    labels_file = OUTPUT_DIR / "topic_labels.json"
    with open(labels_file, "w", encoding="utf-8") as f:
        json.dump(result["topic_labels"], f, indent=2)

    topic_info_file = OUTPUT_DIR / "topic_info.csv"
    result["topic_info"].to_csv(topic_info_file, index=False)

    embeddings_file = OUTPUT_DIR / "embeddings.npy"
    import numpy as np

    np.save(embeddings_file, result["embeddings"])

    summary = {
        "num_documents": len(documents),
        "num_topics": len(result["topics"]),
        "min_topic_size": min_topic_size,
        "top_n_words": top_n_words,
        "n_representative_docs": n_representative_docs,
        "embeddings_shape": list(result["embeddings"].shape),
        "output_directory": str(OUTPUT_DIR),
    }
    summary_file = OUTPUT_DIR / "summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    console.print(f"[green]All outputs saved to: {OUTPUT_DIR}[/green]")
    console.print("\n[bold white]Generated Files:[/bold white]")
    tree = Tree(f"[dir]{OUTPUT_DIR.name}")
    for file_path in sorted(OUTPUT_DIR.glob("*")):
        if file_path.is_file():
            file_url = file_path.as_uri()
            display_name = file_path.name
            tree.add(f"[link={file_url}]{display_name}[/link]")
    console.print(tree)

    return result


if __name__ == "__main__":
    args = get_args()

    codes = args.code
    console.print(
        f"[dim]Loading missav videos (code={codes or 'default'}, limit={args.limit})...[/dim]"
    )
    docs = load_missav_videos(code=codes, limit=args.limit)
    if not docs:
        raise ValueError("No missav videos returned; cannot run topic extraction.")
    console.print(f"[dim]Loaded {len(docs)} documents from missav videos[/dim]")

    result = run_topic_extraction_demo(
        docs,
        min_topic_size=args.min_topic_size,
        top_n_words=args.top_n_words,
        n_representative_docs=args.n_representative_docs,
        use_mmr=not args.no_mmr,
        mmr_diversity=args.mmr_diversity,
        use_keybert=not args.no_keybert,
        n_gram_range=tuple(args.n_gram_range),
    )

    console.print(
        Panel.fit(
            "[bold green]Topic extraction pipeline completed successfully[/bold green]"
        )
    )

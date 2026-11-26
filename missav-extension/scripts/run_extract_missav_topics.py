"""Extract KeyNMF topics from MissAV documents and save inputs and outputs."""

import argparse
import json
import shutil
from pathlib import Path

import topicwizard
from jet.adapters.turftopic.missav import cluster_topics
from rich.console import Console
from rich.table import Table

console = Console()


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract KeyNMF topics from MissAV documents."
    )
    parser.add_argument(
        "-c",
        "--code",
        type=str,
        default="juc",
        help="MissAV video code prefix to load (default: juc)",
    )
    parser.add_argument(
        "-n",
        "--n-topics",
        type=int,
        default=5,
        help="Number of topics to extract (default: 5)",
    )
    parser.add_argument(
        "-d",
        "--n-docs",
        type=int,
        default=100,
        help="Number of documents to process (default: 100)",
    )
    parser.add_argument(
        "-k",
        "--top-k",
        type=int,
        default=10,
        help="Number of top words per topic (default: 10)",
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="Disable LLM-based topic naming (use default keyword names)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
    OUTPUT_DIR = OUTPUT_DIR / args.code
    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    INPUT_FILE = OUTPUT_DIR / "input_documents.json"
    PREROCESSED_DOCS_FILE = OUTPUT_DIR / "preprocessed_documents.json"
    SCORED_DOCS_FILE = OUTPUT_DIR / "scored_documents.json"
    SORTED_INPUT_FILE = OUTPUT_DIR / "sorted_input_documents.json"
    TOPICS_FILE = OUTPUT_DIR / "topics.json"
    TOPICS_CSV = OUTPUT_DIR / "topics.csv"
    DOCUMENT_TOPICS_FILE = OUTPUT_DIR / "document_topics.json"
    REPRESENTATIVE_DOCS_FILE = OUTPUT_DIR / "representative_documents.json"
    TOPIC_BARCHARTS_FILE = OUTPUT_DIR / "topic_barcharts.html"
    TOPIC_MAP_FILE = OUTPUT_DIR / "topic_map.html"
    DOCUMENT_MAP_FILE = OUTPUT_DIR / "document_map.html"

    saved_files: list[Path] = []

    def write_json(path: Path, data: object) -> None:
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        saved_files.append(path)

    def write_figure(path: Path, figure) -> None:
        figure.write_html(path, include_plotlyjs="cdn")
        saved_files.append(path)

    # Call the core business logic
    results = cluster_topics(
        code=args.code,
        n_topics=args.n_topics,
        n_docs=args.n_docs,
        top_k=args.top_k,
        no_llm=args.no_llm,
        representative_top_k=None,  # Can be exposed as an arg if needed
    )

    # Save Input Data
    write_json(INPUT_FILE, results["raw_inputs"])
    console.print(
        f"💾 Saved input documents ({results['raw_inputs']['total_documents']})"
    )

    write_json(
        PREROCESSED_DOCS_FILE,
        {
            "total_documents": len(results["preprocessed_corpus"]),
            "documents": [
                {"index": i, "content": doc}
                for i, doc in enumerate(results["preprocessed_corpus"])
            ],
        },
    )
    console.print(
        f"💾 Saved preprocessed documents ({len(results['preprocessed_corpus'])})"
    )

    write_json(
        SCORED_DOCS_FILE,
        [
            {
                **r,
                "document": results["corpus"][r["index"]]
                if r["index"] < len(results["corpus"])
                else "",
            }
            for r in results["scored_results"]
        ],
    )
    console.print(f"💾 Saved scored documents ({len(results['scored_results'])})")

    write_json(
        SORTED_INPUT_FILE,
        {
            "total_documents": len(results["sorted_corpus_initial"]),
            "documents": [
                {"index": i, "content": doc}
                for i, doc in enumerate(results["sorted_corpus_initial"])
            ],
        },
    )
    console.print(
        f"💾 Saved sorted input documents ({len(results['sorted_corpus_initial'])})"
    )

    # Save Output Data
    write_json(
        TOPICS_FILE, {"n_topics": len(results["topics"]), "topics": results["topics"]}
    )

    write_json(
        REPRESENTATIVE_DOCS_FILE,
        {"top_k": None, "topics": results["representative_topics"]},
    )

    # Save CSV
    model = results["model"]
    topics_df = model.topics_df(top_k=args.top_k, show_scores=True)
    topics_df.to_csv(TOPICS_CSV, index=False)
    saved_files.append(TOPICS_CSV)

    write_json(
        DOCUMENT_TOPICS_FILE,
        {
            "topic_names": [str(name) for name in model.topic_names],
            "n_documents": len(results["document_topics"]),
            "documents": results["document_topics"],
        },
    )

    console.print(f"💾 Saved {len(results['topics'])} topics and document assignments")

    # Print Console Table
    topic_names = [str(name) for name in model.topic_names]
    topic_table = Table(title="Extracted topics", show_lines=True)
    topic_table.add_column("ID", justify="right", style="blue")
    topic_table.add_column("Name", style="cyan")
    topic_table.add_column("Rep. docs", justify="right", style="green")
    topic_table.add_column("Top words", style="magenta", max_width=80)

    for topic in results["topics"]:
        words = ", ".join(item["word"] for item in topic["words"][: args.top_k])
        topic_name = topic_names[topic["topic_id"]]
        topic_table.add_row(
            str(topic["topic_id"]),
            topic_name,
            str(topic["representative_document_count"]),
            words,
        )
    console.print(topic_table)

    # Save Figures
    write_figure(TOPIC_BARCHARTS_FILE, results["figures"]["barcharts"])
    write_figure(TOPIC_MAP_FILE, results["figures"]["topic_map"])
    write_figure(DOCUMENT_MAP_FILE, results["figures"]["document_map"])

    console.print("💾 Saved visualization figures")

    console.print("\n[bold green]📂 Saved files:[/bold green]")
    for path in saved_files:
        console.print(
            f"   [bold bright_blue][link=file://{path.resolve()}]{path.name}[/link][/bold bright_blue]"
        )

    console.print("\nLaunching TopicWizard...")
    topicwizard.visualize(topic_data=results["topic_data"])


if __name__ == "__main__":
    main()

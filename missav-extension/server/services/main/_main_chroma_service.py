import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path

import chroma_service
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress
from rich.table import Table
from rich.text import Text

# Initialize Rich console
console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def get_args():
    parser = argparse.ArgumentParser(
        description="Query ChromaService for video search results."
    )
    parser.add_argument(
        "query",
        type=str,
        help="Search query (e.g. 'amazing videos')",
    )
    parser.add_argument(
        "-k",
        "--top_k",
        type=int,
        default=20,
        help="Number of results to return (default: 20)",
    )
    parser.add_argument(
        "-w",
        "--where",
        type=str,
        default=None,
        help="Optional metadata filter as JSON string (default: None)",
    )
    parser.add_argument(
        "-d",
        "--where_document",
        type=str,
        default=None,
        help="Optional document content filter as JSON string (default: None)",
    )
    return parser.parse_args()


def save_all_videos_to_file(all_videos, output_dir):
    """Save all videos to a JSON file."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    all_videos_file = output_dir / "all_videos.json"

    all_videos_data = {
        "source": "ChromaService Video Database",
        "timestamp": timestamp,
        "total": all_videos["total"],
        "limit": all_videos["limit"],
        "offset": all_videos["offset"],
        "videos": all_videos["videos"],
    }

    with open(all_videos_file, "w", encoding="utf-8") as f:
        json.dump(all_videos_data, f, indent=2, ensure_ascii=False)

    return all_videos_file


def save_results_to_file(query, search_results, output_dir):
    """Save search results to JSON file with metadata and clickable source links."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    results_file = output_dir / "search_results.json"
    results_data = {
        "query": query,
        "timestamp": timestamp,
        "source": "ChromaService Video Database",
        "results_count": len(search_results),
        "results": search_results,
    }
    with open(results_file, "w", encoding="utf-8") as f:
        json.dump(results_data, f, indent=2, ensure_ascii=False)
    links_file = output_dir / "video_links.md"
    with open(links_file, "w", encoding="utf-8") as f:
        f.write(f"# Video Search Results: {query}\n\n")
        f.write(f"**Timestamp:** {timestamp}\n")
        f.write("**Source:** ChromaService Video Database\n\n")
        f.write("## Source Links (Cmd+Click to open)\n\n")
        for idx, result in enumerate(search_results, 1):
            metadata = result.get("metadata", {})
            # CHANGED: get video_id from metadata instead of top-level id
            video_id = metadata.get("video_id", result.get("id", "N/A"))
            source_link = metadata.get(
                "source", metadata.get("url", metadata.get("file_path", ""))
            )
            f.write(f"### {idx}. Video ID: {video_id}\n")
            f.write(f"- **Score:** {result.get('score', 'N/A')}\n")
            if source_link:
                if Path(source_link).exists():
                    file_uri = Path(source_link).resolve().as_uri()
                    f.write(f"- **Source:** [{source_link}]({file_uri})\n")
                else:
                    f.write(f"- **Source:** {source_link}\n")
            if metadata:
                f.write("- **Metadata:**\n")
                for key, value in metadata.items():
                    f.write(f"  - {key}: {value}\n")
            f.write("\n")
    return results_file, links_file


def display_source_links(search_results):
    """Display clickable source links using Rich markup."""
    if not search_results:
        return

    console.print("\n[bold yellow]📁 Source Links (Cmd+Click to open):[/bold yellow]")
    console.print("─" * 80)
    for idx, result in enumerate(search_results, 1):
        metadata = result.get("metadata", {})
        # CHANGED: get video_id from metadata instead of top-level id
        video_id = metadata.get("video_id", result.get("id", "N/A"))
        source_link = metadata.get(
            "source", metadata.get("url", metadata.get("file_path", ""))
        )
        if source_link:
            text = Text()
            text.append(f"{idx}. ", style="dim")
            text.append(f"{video_id}", style="cyan")
            text.append(" → ", style="dim")
            if Path(source_link).exists():
                file_uri = Path(source_link).resolve().as_uri()
                text.append(f"file://{source_link}", style=f"link {file_uri}")
            else:
                text.append(source_link, style="yellow")
            console.print(text)


def display_results_table(search_results):
    """Display search results in a Rich table."""
    if not search_results:
        console.print("[yellow]No results found.[/yellow]")
        return

    table = Table(
        title="[bold cyan]Search Results[/bold cyan]",
        caption=f"Total results: {len(search_results)}",
        show_header=True,
        header_style="bold magenta",
        border_style="blue",
    )
    table.add_column("Rank", style="dim", width=6, justify="right")
    table.add_column("Video ID", style="cyan", width=20)
    table.add_column("Score", style="green", width=12)
    table.add_column("Content", style="white", width=40)
    table.add_column("Source", style="yellow", width=30)

    for idx, result in enumerate(search_results, 1):
        # CHANGED: get video_id from metadata instead of top-level id
        metadata = result.get("metadata", {})
        video_id = metadata.get("video_id", result.get("id", "N/A"))
        score = f"{result.get('score', 0):.4f}"
        document = result.get("document", metadata.get("description", "N/A"))
        if isinstance(document, str) and len(document) > 60:
            document = document[:57] + "..."
        source = metadata.get("source", "")
        if not source:
            source = metadata.get("url", "")
        if not source:
            source = metadata.get("file_path", "N/A")
        if isinstance(source, str) and len(source) > 40:
            source = source[:37] + "..."
        table.add_row(str(idx), str(video_id), score, str(document), str(source))

    console.print(table)


def main():
    args = get_args()

    query = args.query
    top_k = args.top_k
    where = json.loads(args.where) if args.where else None
    where_document = json.loads(args.where_document) if args.where_document else None

    # Print search parameters
    console.print(
        Panel.fit(
            f"[bold]Query:[/bold] {query}\n"
            f"[bold]Top K:[/bold] {top_k}\n"
            f"[bold]Filters:[/bold] where={where}, where_document={where_document}",
            title="[bold blue]Search Parameters[/bold blue]",
            border_style="blue",
        )
    )

    with Progress() as progress:
        task = progress.add_task("[cyan]Searching...", total=3)

        # Get total count
        progress.update(task, description="[cyan]Getting database count...")
        all_count = chroma_service.get_count()
        progress.advance(task)

        # Get all videos (for statistics)
        progress.update(task, description="[cyan]Fetching all videos...")
        all_videos = chroma_service.get_videos(
            limit=99999,
            offset=0,
        )
        progress.advance(task)

        # Perform search
        progress.update(task, description=f"[cyan]Searching for: {query}")
        search_results = chroma_service.search(
            query,
            top_k,
            where,
            where_document,
        )
        progress.advance(task)

    # Print summary
    console.print("\n")
    stats_panel = Panel.fit(
        f"[bold green]Database Stats:[/bold green]\n"
        f"• Total videos in database: [cyan]{all_count}[/cyan]\n"
        f"• Search results returned: [cyan]{len(search_results)}[/cyan]\n"
        f"• Query: [yellow]'{query}'[/yellow]",
        title="[bold green]Search Summary[/bold green]",
        border_style="green",
    )
    console.print(stats_panel)

    # Display source links at the end
    console.print("\n")
    display_source_links(search_results)

    # Save results to files
    console.print("\n[bold yellow]Saving results...[/bold yellow]")
    results_file, links_file = save_results_to_file(query, search_results, OUTPUT_DIR)

    # Save all videos to JSON
    all_videos_file = save_all_videos_to_file(all_videos, OUTPUT_DIR)

    # Display results
    console.print("\n")
    display_results_table(search_results)

    console.print(
        f"[green]✓[/green] Clickable links saved to: [cyan][link=file://{links_file}]{links_file.name}[/link][/cyan]"
    )
    console.print(
        f"[green]✓[/green] All videos saved to: [cyan][link=file://{all_videos_file}]{all_videos_file.name}[/link][/cyan]"
    )
    console.print(
        f"[green]✓[/green] Search results saved to: [cyan][link=file://{results_file}]{results_file.name}[/link][/cyan]"
    )
    console.print(f"\n[dim]All files saved in: {OUTPUT_DIR}[/dim]")


if __name__ == "__main__":
    main()

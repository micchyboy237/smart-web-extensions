"""
Save Topics Batch Processor

Usage Examples:
    # Process two codes with default batch size (2)
    python save_topics.py -c juk jukd

    # Process multiple codes with custom batch size
    python save_topics.py -c code1 code2 code3 code4 code5 -b 3

    # Process a large list of codes
    python save_topics.py -c abc def ghi jkl mno pqr stu vwx -b 2

    # View help message
    python save_topics.py --help
"""

import argparse
import json
import urllib.error
import urllib.request

from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

URL = "http://localhost:9001/topics/save_topics"

console = Console()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Save topics in batches to the API endpoint."
    )
    parser.add_argument(
        "-c",
        "--codes",
        nargs="+",
        required=True,
        help="List of topic codes to process.",
    )
    parser.add_argument(
        "-b",
        "--batch-size",
        type=int,
        default=2,
        help="Number of codes per batch (default: 2).",
    )
    return parser.parse_args()


def send_batch(batch: list[str]) -> tuple[str, str, str]:
    payload = json.dumps({"code": batch}).encode("utf-8")
    request = urllib.request.Request(
        URL,
        data=payload,
        headers={
            "accept": "*/*",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        # Timeout removed completely (blocks indefinitely until response/error)
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
            return ("OK", f"HTTP {response.status}", body)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        return ("HTTP Error", f"HTTP {exc.code}", error_body)
    except urllib.error.URLError as exc:
        return ("Conn Error", "Network", str(exc.reason))


def build_progress() -> Progress:
    return Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}[/bold blue]", table_column=None),
        BarColumn(),
        MofNCompleteColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
        expand=True,
    )


def main() -> None:
    args = parse_args()
    codes = args.codes
    batch_size = args.batch_size

    batches = [codes[i : i + batch_size] for i in range(0, len(codes), batch_size)]
    total = len(batches)

    console.rule(
        f"[bold cyan]Save Topics ({len(codes)} codes across {total} batches)[/bold cyan]"
    )

    summary = Table(show_header=True, header_style="bold magenta")
    summary.add_column("Batch", style="dim", width=8)
    summary.add_column("Codes", justify="right", width=6)
    summary.add_column("Status", width=12)
    summary.add_column("Detail", width=12)
    summary.add_column("Response")

    ok_count = 0
    err_count = 0

    with build_progress() as progress:
        task_id = progress.add_task("Initializing...", total=total)

        for index, batch in enumerate(batches, start=1):
            # Format preview of codes in the current batch
            preview_limit = 4
            preview_str = ", ".join(batch[:preview_limit])
            if len(batch) > preview_limit:
                preview_str += f", ... (+{len(batch) - preview_limit})"

            progress.update(
                task_id,
                description=f"Processing Batch {index}/{total}: [{preview_str}] | [green]OK: {ok_count}[/green] [red]Err: {err_count}[/red]",
            )

            status, detail, body = send_batch(batch)
            if status == "OK":
                ok_count += 1
                status_cell = "[green]OK[/green]"
            else:
                err_count += 1
                status_cell = f"[red]{status}[/red]"

            summary.add_row(
                f"{index}/{total}",
                str(len(batch)),
                status_cell,
                detail,
                body.strip() or "-",
            )
            progress.advance(task_id)

    console.print(summary)
    if ok_count == total:
        console.print(
            f"[bold green]Completed all {total}/{total} batches successfully.[/bold green]"
        )
    else:
        console.print(
            f"[bold yellow]Completed with {ok_count}/{total} batches succeeded ({err_count} failed).[/bold yellow]"
        )


if __name__ == "__main__":
    main()

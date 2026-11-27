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
BATCH_SIZE = 2

CODES = [
    "juy",
    "ssni",
    "dasd",
    "hnd",
    "ssis",
    "wanz",
    "gvg",
    "jufd",
    "snis",
    "nhdtb",
    "sprd",
    "meyd",
    "adn",
    "roe",
    "aldn",
    "gvh",
    "jur",
    "venu",
    "scop",
    "vec",
    "sone",
    "juq",
    "vnds",
    "nhdta",
    "juc",
    "nacr",
    "dldss",
    "jux",
    "jul",
    "jrzd",
    "nsps",
    "mdyd",
    "ksbj",
    "cemd",
    "lulu",
    "hbad",
    "dht",
    "mxgs",
    "doks",
    "nash",
    "jukd",
    "sma",
    "san",
    "iesp",
    "mcsr",
    "kbkd",
    "dse",
    "sdms",
    "nkkd",
    "okax",
    "jusd",
    "umso",
    "nxg",
    "jrze",
    "nhdtc",
    "mond",
    "cead",
    "venx",
    "oba",
    "ngod",
    "natr",
    "oksn",
    "cadv",
    "bokd",
    "wnz",
    "jura",
    "mard",
    "emaf",
    "mama",
    "emaz",
    "juta",
    "ofku",
    "nass",
    "hone",
    "mot",
    "erdm",
    "anb",
    "nwf",
    "aed",
    "mlw",
    "momj",
    "kmds",
    "dmat",
    "ylw",
    "nask",
    "newm",
    "scd",
    "havd",
    "xmom",
    "snos",
    "fera",
    "dgcemd",
    "sqis",
    "hhh",
    "voss",
    "bnsps",
    "tos",
    "zeaa",
    "oomn",
    "ntsu",
    "embw",
    "nuka",
    "emav",
    "tod",
    "nem",
    "mkdv",
    "mom",
    "emas",
    "jgaho",
    "embm",
    "ugug",
    "ymlw",
    "nsfs",
    "okas",
    "dgkd",
    "gifd",
    "sbns",
    "tpd",
    "wnxg",
    "emot",
    "thnd",
    "nxgs",
    "okae",
    "obd",
    "arwa",
    "yume",
    "nade",
    "johs",
]

console = Console()


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
    batches = [CODES[i : i + BATCH_SIZE] for i in range(0, len(CODES), BATCH_SIZE)]
    total = len(batches)

    console.rule(
        f"[bold cyan]Save Topics ({len(CODES)} codes across {total} batches)[/bold cyan]"
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
                description=f"Batch {index}/{total} [{preview_str}] | [green]OK: {ok_count}[/green] [red]Err: {err_count}[/red]",
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

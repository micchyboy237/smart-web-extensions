import json
import shutil
import sys
from pathlib import Path

from rich.console import Console

sys.path.append(str(Path(__file__).parent.parent.parent))

from jet.transformers.object import make_serializable
from services import postgres_service

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

video_ids = [
    "jav-6x3ilc",
    "jav-4pjdpo",
]
results = postgres_service.get_videos_by_ids(video_ids)

results_file = OUTPUT_DIR / "results.json"
with open(results_file, "w", encoding="utf-8") as f:
    json.dump(make_serializable(results), f, indent=2, ensure_ascii=False)

console.print(
    f"💾 Saved results to: [bold bright_blue][link=file://{results_file.resolve()}]{results_file.name}[/link][/bold bright_blue]"
)

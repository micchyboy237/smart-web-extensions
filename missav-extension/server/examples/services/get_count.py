import json
import shutil
import sys
from pathlib import Path

from rich.console import Console

sys.path.append(str(Path(__file__).parent.parent.parent))

from services import postgres_service

console = Console()

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

count = postgres_service.get_count()

result_file = OUTPUT_DIR / "result.json"
with open(result_file, "w", encoding="utf-8") as f:
    json.dump({"count": count}, f, indent=2, ensure_ascii=False)

console.print(
    f"💾 Saved result to: [bold bright_blue][link=file://{result_file.resolve()}]{result_file.name}[/link][/bold bright_blue]"
)

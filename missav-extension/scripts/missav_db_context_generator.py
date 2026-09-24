import shutil
from pathlib import Path

from jet.db.metadata.chroma_context_generator import generate_rag_context

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

if __name__ == "__main__":
    DB_PATH = "/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"

    context = generate_rag_context(DB_PATH)

    output_file = OUTPUT_DIR / "chroma_db_context.txt"
    with open(output_file, "w") as f:
        f.write(context)

    print(f"\nPreview (first 2000 chars):\n{context[:2000]}...")
    print(f"\n✓ Context saved to {output_file}")

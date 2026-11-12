import shutil
from pathlib import Path

from jet.db.metadata.postgres_context_generator import generate_rag_context

OUTPUT_DIR = Path(__file__).parent / "data"
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    CONNECTION_STRING = "postgresql://jethroestrada:@localhost:5432/missav_db1"

    context = generate_rag_context(CONNECTION_STRING, schema="public")

    output_file = OUTPUT_DIR / "missav_db_context.txt"
    with open(output_file, "w") as f:
        f.write(context)

    print(f"\nPreview (first 2000 chars):\n{context[:2000]}...")
    print(f"\n✓ Context saved to {output_file}")

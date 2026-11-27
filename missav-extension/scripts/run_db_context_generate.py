import argparse
import shutil
from pathlib import Path

from jet.db.metadata.postgres_context_generator import generate_rag_context

OUTPUT_DIR = Path(__file__).parent / "data"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate RAG context from a PostgreSQL database schema."
    )
    parser.add_argument(
        "-t",
        "--tables",
        nargs="+",
        default=None,
        metavar="TABLE",
        help="One or more table names to filter by. If omitted, all tables are used.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    CONNECTION_STRING = "postgresql://jethroestrada:@localhost:5432/missav_db1"

    context = generate_rag_context(
        CONNECTION_STRING, schema="public", tables_filter=args.tables
    )

    output_file = OUTPUT_DIR / "missav_db_context.txt"
    with open(output_file, "w") as f:
        f.write(context)

    print(f"\nPreview (first 2000 chars):\n{context[:2000]}...")
    print(f"\n✓ Context saved to {output_file}")

from jet.db.metadata.chroma_context_generator import ChromaDBContextGenerator

if __name__ == "__main__":
    import shutil
    from pathlib import Path

    OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    DB_PATH = "/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"

    generator = ChromaDBContextGenerator(DB_PATH)
    context = generator.generate_full_context()

    output_file = OUTPUT_DIR / "chroma_db_context.txt"
    with open(output_file, "w") as f:
        f.write(context)

    print(f"\nPreview (first 2000 chars):\n{context[:2000]}...")
    print(f"\n✓ Context saved to {output_file}")

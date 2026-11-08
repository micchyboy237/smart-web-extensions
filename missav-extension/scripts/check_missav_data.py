from pathlib import Path

import chromadb

PERSIST_DIR = str(Path("~/.cache/chrome_db/missav/chroma_data").expanduser().resolve())
client = chromadb.PersistentClient(path=PERSIST_DIR)
collection = client.get_collection("missav_videos")

results = collection.get(include=["metadatas", "documents"])

count = 0
for i, id in enumerate(results["ids"]):
    metadata = results["metadatas"][i]
    details = metadata.get("details")
    release_date = metadata.get("release_date")

    if details or release_date:
        print(f"ID: {id}")
        print(f"  Code: {metadata.get('code')}-{metadata.get('episode')}")
        print(f"  Details: {details[:50]}..." if details else "  Details: None")
        print(f"  Release Date: {release_date}")
        print(f"  URL: {metadata.get('url')}")
        print("-" * 20)
        count += 1

print(f"\nTotal items with details or release date: {count}")

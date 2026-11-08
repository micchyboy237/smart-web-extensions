# /Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/scripts/check_missav_data.py

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
    genres = metadata.get("genres")

    # Check if any of the new fields are present
    has_data = details or release_date or (genres and len(genres) > 0)

    if has_data:
        print(f"ID: {id}")
        print(f"  Code: {metadata.get('code')}-{metadata.get('episode')}")

        if details:
            # Truncate long details for cleaner output
            display_details = details[:50] + "..." if len(details) > 50 else details
            print(f"  Details: {display_details}")
        else:
            print(f"  Details: None")

        print(f"  Release Date: {release_date}")

        if genres:
            print(f"  Genres: {', '.join(genres)}")
        else:
            print(f"  Genres: []")

        print(f"  URL: {metadata.get('url')}")
        print("-" * 20)
        count += 1

print(f"\nTotal items with details, release date, or genres: {count}")

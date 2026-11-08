from pathlib import Path

import chromadb

PERSIST_DIR = str(Path("~/.cache/chrome_db/missav/chroma_data").expanduser().resolve())

# 1. Connect to your persistent client
# Use the same path defined in your server/app/config.py
client = chromadb.PersistentClient(path=PERSIST_DIR)

# 2. Get the collection
collection = client.get_collection("missav_videos")

# 3. Option A: Get ALL records (Careful if you have thousands)
# This returns ids, documents, and metadatas
results = collection.get(include=["metadatas", "documents"])

# 4. Inspect the data
for i, id in enumerate(results["ids"]):
    metadata = results["metadatas"][i]

    # Check for the new fields
    details = metadata.get("details")
    release_date = metadata.get("release_date")

    # Print if they exist or if you want to see everything
    if details or release_date:
        print(f"ID: {id}")
        print(f"  Code: {metadata.get('code')}")
        print(f"  Details: {details[:50]}..." if details else "  Details: None")
        print(f"  Release Date: {release_date}")
        print("-" * 20)

# 5. Option B: Search for a specific video by ID
# specific_id = "jav-abc123"  # Replace with an actual ID from your extension
# try:
#     record = collection.get(ids=[specific_id], include=["metadatas"])
#     if record["ids"]:
#         print(f"Metadata for {specific_id}:")
#         print(record["metadatas"][0])
#     else:
#         print("ID not found.")
# except Exception as e:
#     print(f"Error: {e}")

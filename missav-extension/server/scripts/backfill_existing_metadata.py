import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# One-off script — run once against your existing PERSIST_DIR
from services import chroma_service

service = chroma_service.get_service()
all_videos = service.get_videos(limit=None, offset=0)  # get everything

ids = []
metadatas = []
for v in all_videos["videos"]:
    meta = dict(v["metadata"])
    meta["id"] = v["id"]
    ids.append(v["id"])
    metadatas.append(meta)

# Chroma lets you update metadata without touching embeddings/documents
service.collection.update(ids=ids, metadatas=metadatas)
print(f"Backfilled id field for {len(ids)} videos")

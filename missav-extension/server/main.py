"""
MissAV Smart Search API Server
FastAPI server with ChromaDB for video storage and smart search.
"""

import logging
import os

from app.config import CHROMA_DIR, SERVER_DIR

logger = logging.getLogger(__name__)

if __name__ == "__main__":
    import uvicorn

    os.chdir(SERVER_DIR)

    print(f"📂 Server directory: {SERVER_DIR}")
    print(f"📂 ChromaDB directory: {CHROMA_DIR}")
    print()

    reload_dirs: list[str] = [
        "routes",
        "services",
        "utils",
        "models",
        "app",  # ← Added: important for app/serve.py
    ]

    print("👁️ Auto-reload watching:")
    for d in reload_dirs:
        print(f"   📁 {d}/")
    print(" 🚫 Excluding: chroma_data/, __pycache__/, *.sqlite3")
    print()

    # FIXED: Correct module path to where the FastAPI app actually lives
    uvicorn.run(
        "app.serve:app",  # ← This is the key fix
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=reload_dirs,
        reload_excludes=[
            "*.sqlite3",
            "*.db",
            "*.log",
            "chroma_data/*",
            "__pycache__/*",
            ".chroma_*",
        ],
        log_level="info",
        access_log=True,
        timeout_keep_alive=30,
    )

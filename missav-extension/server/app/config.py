import os
from pathlib import Path

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVE_BASE_DIR = Path("~/.cache/chrome_db/missav").expanduser().resolve()
CHROMA_DIR = str(SAVE_BASE_DIR / "chroma_data")
PERSIST_DIR = CHROMA_DIR

import os
from pathlib import Path

SERVER_DIR = str(Path(__file__).parent.parent)

# Database Configuration
PG_DB_NAME = os.getenv("PG_DB_NAME", "missav_db1")
PG_USER = os.getenv("PG_USER", "jethroestrada")
PG_PASSWORD = os.getenv("PG_PASSWORD", "")
PG_HOST = os.getenv("PG_HOST", "localhost")
PG_PORT = int(os.getenv("PG_PORT", 5432))

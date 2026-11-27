import os
from typing import Optional

# Database
DB_CONNINFO = os.getenv(
    "DATABASE_URL", "dbname=missav_db1 user=jethroestrada host=localhost port=5432"
)

# Embedding
EMBED_MODEL = os.getenv("EMBED_MODEL", "all-MiniLM-L6-v2")
EMBED_DOC_PREFIX = ""
EMBED_QUERY_PREFIX = ""

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "9001"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# Clustering
CLUSTER_CANDIDATE_CAP_QUERY = int(os.getenv("CLUSTER_CANDIDATE_CAP_QUERY", "5000"))
CLUSTER_CANDIDATE_CAP_BROWSE = int(os.getenv("CLUSTER_CANDIDATE_CAP_BROWSE", "5000"))

# Search Tuning
ITERATIVE_SCAN_MODE: Optional[str] = "strict_order"
MAX_SCAN_TUPLES = 20000
INGEST_MAX_TOKENS = 500

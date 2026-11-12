"""
MissAV Smart Search API Server
FastAPI server with PostgreSQL for video storage and smart search.
"""

import argparse
import logging
import sys
from pathlib import Path

# Add the project root to the path to ensure imports work correctly
SERVER_DIR = str(Path(__file__).parent)
sys.path.insert(0, SERVER_DIR)

from app.config import SERVER_DIR as CONFIG_SERVER_DIR

logger = logging.getLogger(__name__)


def parse_args():
    parser = argparse.ArgumentParser(description="MissAV Smart Search API Server")

    parser.add_argument(
        "--host",
        "-H",
        type=str,
        default="0.0.0.0",
        help="Host to bind the server to (default: 0.0.0.0)",
    )

    parser.add_argument(
        "--port",
        "-p",
        type=int,
        default=8000,
        help="Port to bind the server to (default: 8000)",
    )

    parser.add_argument(
        "--no-reload",
        "-nr",
        action="store_true",
        help="Disable auto-reload for production environments",
    )

    parser.add_argument(
        "--log-level",
        "-l",
        type=str,
        choices=["debug", "info", "warning", "error", "critical"],
        default="info",
        help="Set the logging level (default: info)",
    )

    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    print(f"📂 Server directory: {CONFIG_SERVER_DIR}")
    print(f"🚀 Starting MissAV Smart Search API on {args.host}:{args.port}...")

    import uvicorn

    uvicorn.run(
        "app.serve:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
        reload_dirs=["app"],
        log_level=args.log_level,
        access_log=True,
    )

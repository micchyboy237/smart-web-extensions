import argparse

import uvicorn
from config import HOST, LOG_LEVEL, PORT


def parse_args():
    parser = argparse.ArgumentParser(description="Video Search API Server")
    parser.add_argument("--host", type=str, default=HOST, help="Host to bind to")
    parser.add_argument("--port", type=int, default=PORT, help="Port to bind to")
    parser.add_argument("--log-level", type=str, default=LOG_LEVEL, help="Log level")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    print(f"Starting Video Search Server on http://{args.host}:{args.port}")
    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level.lower(),
        reload=False,
    )

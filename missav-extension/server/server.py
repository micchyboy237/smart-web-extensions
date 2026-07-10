# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/server.py
"""
MissAV Smart Search API Server

FastAPI server with ChromaDB for video storage and smart search.
Provides AI-powered search with diversity, filtering, and personalization.
"""

import logging
import os
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Import route modules
from routes.health import router as health_router
from routes.preferences import router as preferences_router
from routes.search import router as search_router
from routes.videos import router as videos_router
from services import chroma_service as chroma_service_module
from utils.search_strategies import (
    DiversityAwareSearch,
    EnsembleSearchStrategy,
)

# ====================== LOGGING ======================

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# ====================== FASTAPI APP ======================

app = FastAPI(
    title="MissAV Smart Search API",
    version="1.0.0",
    description="Smart search and filtering for video recommendations with diversity-aware ranking",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ====================== CORS CONFIGURATION ======================

ALLOWED_ORIGINS = [
    # Browser extension origins (Chrome/Firefox)
    "chrome-extension://*",
    "moz-extension://*",
    "extension://*",
    # MissAV website
    "https://missav.ws",
    "https://*.missav.ws",
    # Local development
    "http://localhost",
    "http://localhost:*",
    "http://127.0.0.1",
    "http://127.0.0.1:*",
    # Allow all for development (restrict in production)
    "*",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
        "Origin",
        "User-Agent",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
    ],
    expose_headers=[
        "Content-Type",
        "Content-Length",
        "X-Request-ID",
    ],
    max_age=3600,
)

# ====================== REQUEST LOGGING MIDDLEWARE ======================


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all incoming requests with timing and origin info."""
    start_time = time.time()

    origin = request.headers.get("origin", "unknown")
    method = request.method
    path = request.url.path

    logger.info(f"[REQUEST] {method} {path} | Origin: {origin}")

    response = await call_next(request)

    elapsed = (time.time() - start_time) * 1000
    status_code = response.status_code

    if status_code >= 400:
        logger.warning(f"[RESPONSE] {method} {path} → {status_code} ({elapsed:.2f}ms)")
    else:
        logger.info(f"[RESPONSE] {method} {path} → {status_code} ({elapsed:.2f}ms)")

    return response


# ====================== ERROR HANDLER ======================


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler with proper error responses."""
    logger.error(
        f"[ERROR] {request.method} {request.url.path}: {str(exc)}",
        exc_info=True,
    )

    return JSONResponse(
        status_code=500,
        content={
            "error": str(exc),
            "type": type(exc).__name__,
            "path": str(request.url.path),
        },
    )


# ====================== SERVICES ======================

# Get the directory containing this script for ChromaDB storage
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
CHROMA_DIR = os.path.join(SERVER_DIR, "chroma_data")
chroma_service = chroma_service_module.init_service(CHROMA_DIR)

# Initialize services (shared across route modules)
diversity_search = DiversityAwareSearch()
ensemble_strategy = EnsembleSearchStrategy()

# ====================== ROUTE REGISTRATION ======================

app.include_router(health_router)
app.include_router(videos_router)
app.include_router(search_router)
app.include_router(preferences_router)

# ====================== LIFECYCLE EVENTS ======================


@app.on_event("startup")
async def startup():
    """Log startup info and verify services."""
    logger.info("=" * 60)
    logger.info("🚀 MissAV Smart Search API Starting...")
    logger.info(f"📂 Server directory: {SERVER_DIR}")
    logger.info(f"📂 ChromaDB directory: {CHROMA_DIR}")
    logger.info("=" * 60)

    # Verify ChromaDB
    try:
        count = chroma_service.get_count()
        logger.info(f"📊 ChromaDB: {count} videos indexed")
    except Exception as e:
        logger.error(f"❌ ChromaDB error: {e}")

    # Log CORS configuration
    logger.info("🌐 CORS: Enabled for all origins (development mode)")
    logger.info(f"   Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH")
    logger.info(f"   Max Age: 3600s")

    # Log registered routes
    routes = [
        route.path
        for route in app.routes
        if hasattr(route, "methods") and route.path.startswith("/api")
    ]
    logger.info(f"📋 Registered API routes ({len(routes)}):")
    for route in sorted(routes):
        logger.info(f"   {route}")

    logger.info("=" * 60)
    logger.info("✅ Server ready at http://0.0.0.0:8000")
    logger.info("📖 API docs at http://localhost:8000/docs")
    logger.info("=" * 60)


@app.on_event("shutdown")
async def shutdown():
    """Clean shutdown."""
    logger.info("🛑 Server shutting down...")


# ====================== MAIN ======================

if __name__ == "__main__":
    import uvicorn

    # Change to server directory for consistent relative paths
    os.chdir(SERVER_DIR)

    print(f"📂 Server directory: {SERVER_DIR}")
    print(f"📂 ChromaDB directory: {CHROMA_DIR}")
    print()

    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info",
        access_log=True,
        timeout_keep_alive=30,
    )

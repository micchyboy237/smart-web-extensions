"""
MissAV Smart Search API Server
FastAPI server with ChromaDB for video storage and smart search.
Provides AI-powered search with diversity, filtering, and personalization.
"""

import logging
import time

from app.config import CHROMA_DIR, SERVER_DIR
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from routes.health import router as health_router
from routes.preferences import router as preferences_router
from routes.search import router as search_router
from routes.videos import router as videos_router
from services import chroma_service as chroma_service_module
from utils.search_strategies import (
    DiversityAwareSearch,
    EnsembleSearchStrategy,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="MissAV Smart Search API",
    version="1.0.0",
    description="Smart search and filtering for video recommendations with diversity-aware ranking",
    docs_url="/docs",
    redoc_url="/redoc",
)

ALLOWED_ORIGINS = [
    "chrome-extension://*",
    "moz-extension://*",
    "extension://*",
    "https://missav.ws",
    "https://*.missav.ws",
    "http://localhost",
    "http://localhost:*",
    "http://127.0.0.1",
    "http://127.0.0.1:*",
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


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all incoming requests with timing and origin info, and add the
    legacy Private Network Access preflight header.

    NOTE: The "canceled"/CORS error the extension was hitting is Chrome's
    newer Local Network Access (LNA) permission check, which is a browser
    permission the user grants per-origin — this header alone does not fix
    that. It's included here as a harmless fallback for older Chrome
    versions that still check the pre-LNA Private Network Access preflight
    header. See the extension's service-worker.js for the actual fix.
    """
    start_time = time.time()
    origin = request.headers.get("origin", "unknown")
    method = request.method
    path = request.url.path
    logger.info(f"[REQUEST] {method} {path} | Origin: {origin}")
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    elapsed = (time.time() - start_time) * 1000
    status_code = response.status_code
    if status_code >= 400:
        logger.warning(f"[RESPONSE] {method} {path} → {status_code} ({elapsed:.2f}ms)")
    else:
        logger.info(f"[RESPONSE] {method} {path} → {status_code} ({elapsed:.2f}ms)")
    return response


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


chroma_service = chroma_service_module.init_service(CHROMA_DIR)
diversity_search = DiversityAwareSearch()
ensemble_strategy = EnsembleSearchStrategy()
app.include_router(health_router)
app.include_router(videos_router)
app.include_router(search_router)
app.include_router(preferences_router)


@app.on_event("startup")
async def startup():
    """Log startup info and verify services."""
    logger.info("=" * 60)
    logger.info("🚀 MissAV Smart Search API Starting...")
    logger.info(f"📂 Server directory: {SERVER_DIR}")
    logger.info(f"📂 ChromaDB directory: {CHROMA_DIR}")
    logger.info("=" * 60)
    try:
        count = chroma_service.get_count()
        logger.info(f"📊 ChromaDB: {count} videos indexed")
    except Exception as e:
        logger.error(f"❌ ChromaDB error: {e}")
    logger.info("🌐 CORS: Enabled for all origins (development mode)")
    logger.info("   Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH")
    logger.info("   Max Age: 3600s")
    logger.info("🔓 Private Network Access header: enabled on every response")
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

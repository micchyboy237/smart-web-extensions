import logging
from contextlib import asynccontextmanager

from db import close_db, init_db
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import health, topics, videos

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("video_search_api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await close_db()
    from jet.adapters.llama_cpp.embed_utils import shutdown_embed_pool

    shutdown_embed_pool()
    logger.info("Embed pool closed")


app = FastAPI(title="Video Semantic Search", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(videos.router)
app.include_router(topics.router, prefix="/topics")
app.include_router(health.router)

from app.routes.search import router as search_router
from fastapi import FastAPI

app = FastAPI(
    title="MissAV Smart Search API",
    description="PostgreSQL-backed vector search for MissAV extension",
    version="1.0.0",
)

app.include_router(search_router)


@app.get("/health")
def health_check():
    return {"status": "healthy"}

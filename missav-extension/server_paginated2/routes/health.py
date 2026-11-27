import time

from db import pool
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health():
    t0 = time.perf_counter()
    with pool.connection() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True, "db_ms": (time.perf_counter() - t0) * 1000}

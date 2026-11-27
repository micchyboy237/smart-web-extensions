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


@router.get("/facets")
def facets(top_genres: int = 60, top_codes: int = 40, completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        genres = conn.execute(
            f"SELECT g AS name, COUNT(*)::int AS count FROM public.videos, unnest(genres) AS g WHERE genres IS NOT NULL {extra} GROUP BY g ORDER BY count DESC NULLS LAST LIMIT %s",
            (top_genres,),
        ).fetchall()
        codes = conn.execute(
            f"SELECT code, COUNT(*)::int AS count FROM public.videos WHERE TRUE {extra} GROUP BY code ORDER BY count DESC LIMIT %s",
            (top_codes,),
        ).fetchall()
        years = conn.execute(
            f"SELECT EXTRACT(YEAR FROM release_date)::int AS year, COUNT(*)::int AS count FROM public.videos WHERE release_date IS NOT NULL {extra} GROUP BY 1 ORDER BY 1"
        ).fetchall()
    return {
        "genres": [{"name": r["name"], "count": r["count"]} for r in genres],
        "codes": [{"code": r["code"], "count": r["count"]} for r in codes],
        "years": [{"year": r["year"], "count": r["count"]} for r in years],
    }


@router.get("/facets/codes")
def facets_codes(completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        codes = conn.execute(
            f"SELECT code, COUNT(*)::int AS count, SUM(CASE WHEN COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0 THEN 1 ELSE 0 END)::int AS completed FROM public.videos WHERE code IS NOT NULL {extra} GROUP BY code ORDER BY count DESC"
        ).fetchall()
        return {
            "code_count": len(codes),
            "codes": [
                {"code": r["code"], "count": r["count"], "completed": r["completed"]}
                for r in codes
            ],
        }


@router.get("/facets/genres")
def facets_genres(completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        genres = conn.execute(
            f"SELECT g AS name, COUNT(*)::int AS count FROM public.videos, unnest(genres) AS g WHERE genres IS NOT NULL {extra} GROUP BY g ORDER BY count DESC NULLS LAST"
        ).fetchall()
        return {
            "genre_count": len(genres),
            "genres": [{"name": r["name"], "count": r["count"]} for r in genres],
        }

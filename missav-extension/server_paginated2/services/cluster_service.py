import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Tuple

import numpy as np
from config import (
    CLUSTER_CANDIDATE_CAP_BROWSE,
    CLUSTER_CANDIDATE_CAP_QUERY,
    ITERATIVE_SCAN_MODE,
    MAX_SCAN_TUPLES,
)
from db import pool
from fastapi import HTTPException
from jet.adapters.llama_cpp.cluster_utils.clusterer import TextsClusterer
from jet.adapters.turftopic.missav import ClusterTopicsResult, cluster_topics
from models.schemas import (
    ClusteredSearchRequest,
    ClusteredSearchResponse,
    ClusterItem,
    VideoItem,
)

from services.utils import embed_query, to_float_list
from services.video_service import apply_filters, row_to_item

logger = logging.getLogger(__name__)


def resolve_cluster_candidate_limit(req: ClusteredSearchRequest) -> int:
    cap = (
        CLUSTER_CANDIDATE_CAP_QUERY
        if req.query is not None
        else CLUSTER_CANDIDATE_CAP_BROWSE
    )
    if req.cluster_candidate_limit is None:
        return cap
    return max(10, min(req.cluster_candidate_limit, cap))


def fetch_clustered_candidates(req: ClusteredSearchRequest, limit: int) -> List[dict]:
    params: dict = {"limit": limit}
    conds: List[str] = ["embedding IS NOT NULL"]
    apply_filters(req, params, conds)

    if req.query is not None:
        emb = to_float_list(embed_query(req.query))
        params["emb"] = emb
        distance_sql = "(embedding <=> %(emb)s::vector)"
        if req.min_similarity is not None:
            conds.append("(embedding <=> %(emb)s::vector) <= %(max_dist)s")
            params["max_dist"] = 1.0 - req.min_similarity
        where_sql = " AND ".join(conds)
        sql = f"""
            SELECT id, title, details, url, code, episode, release_date, genres,
                   thumbnail, preview, embedding, {distance_sql} AS distance
            FROM public.videos WHERE {where_sql}
            ORDER BY {distance_sql} ASC, id ASC LIMIT %(limit)s
        """
        with pool.connection() as conn:
            if ITERATIVE_SCAN_MODE:
                conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
                conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
            return conn.execute(sql, params).fetchall()

    where_sql = " AND ".join(conds)
    if req.candidate_source == "random":
        order_sql = "ORDER BY random()"
    else:
        order_sql = (
            "ORDER BY release_date DESC NULLS LAST, created_at DESC NULLS LAST, id ASC"
        )

    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, embedding, NULL::float8 AS distance
        FROM public.videos WHERE {where_sql} {order_sql} LIMIT %(limit)s
    """
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def search_clustered(req: ClusteredSearchRequest) -> ClusteredSearchResponse:
    t0 = time.perf_counter()
    limit = resolve_cluster_candidate_limit(req)
    try:
        rows = fetch_clustered_candidates(req, limit)
    except Exception as e:
        logger.error("search_clustered DB error: %s", e)
        raise HTTPException(500, f"Search failed: {e}")

    if not rows:
        return ClusteredSearchResponse(
            query=req.query or "",
            total_results=0,
            candidate_limit=limit,
            n_clusters=0,
            n_noise=0,
            total_misplaced_items=0,
            clusters=[],
            took_ms=(time.perf_counter() - t0) * 1000,
        )

    matrix = np.asarray([to_float_list(r["embedding"]) for r in rows], dtype=np.float32)
    texts = [f"{r['id']}" for r in rows]
    clusterer = TextsClusterer(
        min_cluster_size=req.min_cluster_size,
        cluster_selection_epsilon=req.cluster_selection_epsilon,
    )
    clusterer.fit_predict(
        texts, indices=list(range(len(rows))), deduplicate=False, embeddings=matrix
    )
    analysis = clusterer.get_detailed_analysis()
    summary = clusterer.get_summary(analysis)

    by_id: Dict[str, dict] = {r["id"]: r for r in rows}
    clusters: List[ClusterItem] = []
    for cluster_name, info in analysis.items():
        is_noise = cluster_name == "Noise/Outliers"
        cluster_id = -1 if is_noise else int(cluster_name.split(" ")[1])
        texts_in_cluster = info["all_texts"]
        probs = info["probabilities"]
        dists = info["distances_to_centroid"]
        sils = info["silhouette_scores"]
        items: List[VideoItem] = []
        for row_id, prob, dist, sil in zip(texts_in_cluster, probs, dists, sils):
            row = by_id.get(row_id)
            if row is None:
                continue
            sim = (1.0 - row["distance"]) if row["distance"] is not None else None
            item = row_to_item(row, similarity=sim)
            item.probability = float(prob)
            item.distance_to_centroid = float(dist)
            item.silhouette = float(sil)
            items.append(item)

        centroid_sim = None
        if req.query is not None and items:
            sims = [it.similarity for it in items if it.similarity is not None]
            if sims:
                centroid_sim = float(np.mean(sims))

        detail = summary["cluster_details"].get(cluster_name, {})
        clusters.append(
            ClusterItem(
                cluster_id=cluster_id,
                label="Noise/Outliers" if is_noise else None,
                size=len(items),
                centroid_similarity=centroid_sim,
                consistency_score=float(detail.get("consistency_score", 0.0)),
                avg_silhouette=float(detail.get("avg_silhouette_score", 0.0)),
                misplaced_items_count=int(detail.get("misplaced_items_count", 0)),
                is_noise=is_noise,
                items=items,
            )
        )

    clusters.sort(key=lambda c: (c.is_noise, -((c.consistency_score or 0.0) * c.size)))
    took = (time.perf_counter() - t0) * 1000
    return ClusteredSearchResponse(
        query=req.query or "",
        total_results=len(rows),
        candidate_limit=limit,
        n_clusters=summary["summary"]["n_clusters"],
        n_noise=summary["summary"]["n_noise"],
        total_misplaced_items=summary["summary"]["total_misplaced_items"],
        clusters=clusters,
        took_ms=took,
    )


def map_results_to_db_format(
    results: ClusterTopicsResult,
) -> Tuple[List[dict], List[dict]]:
    topics_data = []
    assignments_data = []
    rep_by_topic = {
        item["topic_id"]: item for item in results.get("representative_topics", [])
    }
    topic_names = [str(name) for name in results["model"].topic_names]
    for topic in results.get("topics", []):
        topic_id = topic["topic_id"]
        rep_info = rep_by_topic.get(topic_id, {})
        words = [
            {"word": w["word"], "score": w["score"], "rank": i}
            for i, w in enumerate(topic["words"])
        ]
        rep_docs = [
            {"content": doc["content"], "membership_score": doc["score"]}
            for doc in rep_info.get("documents", [])
        ]
        topics_data.append(
            {
                "topic_id": topic_id,
                "name": topic_names[topic_id] if topic_id < len(topic_names) else None,
                "representative_doc_count": topic["representative_document_count"],
                "words": words,
                "representative_docs": rep_docs,
            }
        )
    corpus = results.get("corpus", [])
    for assignment in results.get("document_topics", []):
        idx = assignment["index"]
        assignments_data.append(
            {
                "source_index": idx,
                "topic_id": assignment["topic_id"],
                "topic_name": assignment["topic_name"],
                "scores": assignment["scores"],
                "content": corpus[idx] if idx < len(corpus) else "",
            }
        )
    return topics_data, assignments_data


def save_topics(
    code: str, n_topics: int, n_docs: int, top_k: int, no_llm: bool
) -> dict:
    t0 = time.perf_counter()
    run_id = str(uuid.uuid4())
    try:
        results: ClusterTopicsResult = cluster_topics(
            code=code,
            n_topics=n_topics,
            n_docs=n_docs,
            top_k=top_k,
            no_llm=no_llm,
            representative_top_k=None,
        )
        topics_data, assignments_data = map_results_to_db_format(results)
        model_config = {
            "vectorizer": "NounPhraseCountVectorizer",
            "encoder": "LlamaCppEncoder",
        }

        with pool.connection() as conn:
            conn.execute(
                "INSERT INTO public.topic_runs (id, code, n_topics, n_docs, top_k, no_llm, model_params) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    run_id,
                    code,
                    n_topics,
                    n_docs,
                    top_k,
                    no_llm,
                    json.dumps(model_config),
                ),
            )
            for topic in topics_data:
                topic_uuid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO public.topics (id, run_id, topic_id, name, representative_doc_count) VALUES (%s, %s, %s, %s, %s)",
                    (
                        topic_uuid,
                        run_id,
                        topic["topic_id"],
                        topic["name"],
                        topic["representative_doc_count"],
                    ),
                )
                for word in topic["words"]:
                    conn.execute(
                        "INSERT INTO public.topic_words (id, topic_id, word, score, rank) VALUES (%s, %s, %s, %s, %s)",
                        (
                            str(uuid.uuid4()),
                            topic_uuid,
                            word["word"],
                            word["score"],
                            word["rank"],
                        ),
                    )
                for doc in topic["representative_docs"]:
                    conn.execute(
                        "INSERT INTO public.topic_representative_docs (id, topic_id, content, membership_score) VALUES (%s, %s, %s, %s)",
                        (
                            str(uuid.uuid4()),
                            topic_uuid,
                            doc["content"],
                            doc["membership_score"],
                        ),
                    )
            for assignment in assignments_data:
                conn.execute(
                    "INSERT INTO public.document_topic_assignments (id, run_id, source_index, topic_id, topic_name, scores, content) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (
                        str(uuid.uuid4()),
                        run_id,
                        assignment["source_index"],
                        assignment["topic_id"],
                        assignment["topic_name"],
                        assignment["scores"],
                        assignment["content"],
                    ),
                )
            conn.commit()

            summary_row = conn.execute(
                """
                WITH latest_run AS (SELECT id, code, n_topics, n_docs, created_at FROM public.topic_runs WHERE id = %s),
                primary_topic AS (SELECT t.id as topic_uuid, t.name, t.representative_doc_count FROM public.topics t JOIN latest_run lr ON t.run_id = lr.id WHERE t.topic_id = 0),
                ranked_words AS (SELECT tw.word, tw.score, ROW_NUMBER() OVER (ORDER BY tw.rank ASC) as rn FROM public.topic_words tw JOIN primary_topic pt ON tw.topic_id = pt.topic_uuid)
                SELECT lr.code, lr.id as run_id, lr.created_at, lr.n_topics, lr.n_docs,
                       pt.name as top_topic_name, pt.representative_doc_count as top_topic_rep_count,
                       COALESCE(jsonb_agg(jsonb_build_object('word', rw.word, 'score', rw.score) ORDER BY rw.rn ASC) FILTER (WHERE rw.rn <= lr.n_topics), '[]'::jsonb) as top_topic_words
                FROM latest_run lr LEFT JOIN primary_topic pt ON true LEFT JOIN ranked_words rw ON true
                GROUP BY lr.id, lr.code, lr.created_at, lr.n_topics, lr.n_docs, pt.name, pt.representative_doc_count
                """,
                (run_id,),
            ).fetchone()

            if not summary_row:
                raise Exception("Failed to retrieve summary after save")
            item = dict(summary_row)
            item["run_id"] = str(item["run_id"])
            if isinstance(item["top_topic_words"], str):
                item["top_topic_words"] = json.loads(item["top_topic_words"])
            return item
    except Exception as e:
        logger.error("Failed to save topics: %s", e)
        raise HTTPException(500, f"Failed to save topics: {e}")


def list_topic_runs(code: Optional[str], limit: int, offset: int) -> List[dict]:
    params: dict = {"limit": limit, "offset": offset}
    conds: List[str] = []
    if code:
        conds.append("code = %(code)s")
        params["code"] = code
    where_sql = " AND ".join(conds) if conds else "TRUE"
    sql = f"SELECT id, code, n_topics, n_docs, created_at FROM public.topic_runs WHERE {where_sql} ORDER BY created_at DESC LIMIT %(limit)s OFFSET %(offset)s"
    try:
        with pool.connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            item = dict(r)
            if "id" in item and item["id"] is not None:
                item["id"] = str(item["id"])
            result.append(item)
        return result
    except Exception as e:
        logger.error("DB error listing topic runs: %s", e)
        raise HTTPException(500, f"Failed to list topic runs: {e}")


def get_topic_run_detail(run_id: str) -> dict:
    try:
        with pool.connection() as conn:
            run_row = conn.execute(
                "SELECT id, code, n_topics, n_docs, top_k, no_llm, created_at FROM public.topic_runs WHERE id = %s",
                (run_id,),
            ).fetchone()
            if not run_row:
                raise HTTPException(404, "Topic run not found")
            run_data = dict(run_row)
            if "id" in run_data:
                run_data["id"] = str(run_data["id"])

            topics_rows = conn.execute(
                "SELECT id, topic_id, name, representative_doc_count FROM public.topics WHERE run_id = %s ORDER BY topic_id ASC",
                (run_id,),
            ).fetchall()
            topics_list = []
            for t in topics_rows:
                topic_uuid = str(t["id"])
                words_rows = conn.execute(
                    "SELECT word, score, rank FROM public.topic_words WHERE topic_id = %s ORDER BY rank ASC",
                    (topic_uuid,),
                ).fetchall()
                docs_rows = conn.execute(
                    "SELECT content, membership_score FROM public.topic_representative_docs WHERE topic_id = %s ORDER BY membership_score DESC",
                    (topic_uuid,),
                ).fetchall()
                topics_list.append(
                    {
                        "id": topic_uuid,
                        "topic_id": t["topic_id"],
                        "name": t["name"],
                        "representative_doc_count": t["representative_doc_count"],
                        "words": [dict(w) for w in words_rows],
                        "representative_docs": [dict(d) for d in docs_rows],
                    }
                )

            assignments_rows = conn.execute(
                "SELECT source_index, topic_id, topic_name, scores, content FROM public.document_topic_assignments WHERE run_id = %s ORDER BY source_index ASC",
                (run_id,),
            ).fetchall()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("DB error getting topic run detail: %s", e)
        raise HTTPException(500, f"Failed to get topic run detail: {e}")

    return {
        "run": run_data,
        "topics": topics_list,
        "assignments": [dict(a) for a in assignments_rows],
    }


def search_topics_by_word(word: str, limit: int) -> List[dict]:
    sql = """
        SELECT DISTINCT tr.id as run_id, tr.code, t.topic_id, t.name as topic_name, tw.word, tw.score
        FROM public.topic_words tw
        JOIN public.topics t ON tw.topic_id = t.id
        JOIN public.topic_runs tr ON t.run_id = tr.id
        WHERE LOWER(tw.word) = LOWER(%(word)s)
        ORDER BY tw.score DESC LIMIT %(limit)s
    """
    try:
        with pool.connection() as conn:
            rows = conn.execute(sql, {"word": word, "limit": limit}).fetchall()
        result = []
        for r in rows:
            item = dict(r)
            if "run_id" in item and item["run_id"] is not None:
                item["run_id"] = str(item["run_id"])
            result.append(item)
        return result
    except Exception as e:
        logger.error("DB error searching topics: %s", e)
        raise HTTPException(500, f"Failed to search topics: {e}")


def get_topics_dashboard() -> dict:
    sql = """
        WITH latest_runs AS (SELECT DISTINCT ON (code) id, code, n_topics, n_docs, created_at FROM public.topic_runs ORDER BY code, created_at DESC),
        top_topics AS (SELECT t.id as topic_uuid, t.run_id, t.name, t.representative_doc_count FROM public.topics t JOIN latest_runs lr ON t.run_id = lr.id WHERE t.topic_id = 0),
        ranked_words AS (SELECT tw.topic_id, tw.word, tw.score, ROW_NUMBER() OVER (PARTITION BY tw.topic_id ORDER BY tw.rank ASC) as rn FROM public.topic_words tw JOIN top_topics tt ON tw.topic_id = tt.topic_uuid)
        SELECT lr.id as run_id, lr.code, lr.n_topics, lr.n_docs, lr.created_at,
               tt.name as top_topic_name, tt.representative_doc_count as top_topic_rep_count,
               COALESCE(jsonb_agg(jsonb_build_object('word', rw.word, 'score', rw.score) ORDER BY rw.rn ASC) FILTER (WHERE rw.rn <= lr.n_topics), '[]'::jsonb) as top_topic_words
        FROM latest_runs lr
        LEFT JOIN top_topics tt ON tt.run_id = lr.id
        LEFT JOIN ranked_words rw ON rw.topic_id = tt.topic_uuid
        GROUP BY lr.id, lr.code, lr.n_topics, lr.n_docs, lr.created_at, tt.name, tt.representative_doc_count
        ORDER BY lr.code ASC
    """
    try:
        with pool.connection() as conn:
            rows = conn.execute(sql).fetchall()
        result = []
        for r in rows:
            item = dict(r)
            item["run_id"] = str(item["run_id"])
            if isinstance(item["top_topic_words"], str):
                item["top_topic_words"] = json.loads(item["top_topic_words"])
            elif item["top_topic_words"] is None:
                item["top_topic_words"] = []
            result.append(item)
        return {"codes": result}
    except Exception as e:
        logger.error("DB error fetching dashboard: %s", e)
        raise HTTPException(500, f"Failed to load dashboard: {e}")

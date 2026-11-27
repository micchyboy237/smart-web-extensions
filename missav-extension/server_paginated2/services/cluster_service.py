import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Set, Tuple

import numpy as np
from config import (
    CLUSTER_CANDIDATE_CAP_BROWSE,
    CLUSTER_CANDIDATE_CAP_QUERY,
    EMBED_DOC_PREFIX,
    EMBED_MODEL,
    EMBED_QUERY_PREFIX,
    ITERATIVE_SCAN_MODE,
    MAX_SCAN_TUPLES,
)
from db import pool
from fastapi import HTTPException
from jet.adapters.llama_cpp.cluster_utils.clusterer import TextsClusterer
from jet.adapters.llama_cpp.embed_utils import embed
from jet.adapters.turftopic.missav import ClusterTopicsResult, cluster_topics
from models.schemas.topic import (
    CodeDashboardSummary,
    DashboardResponse,
    RepresentativeDocWithVideo,
    TopicSearchResultItem,
)
from models.types.topic import (
    AssignmentDataTD,
    DocumentAssignmentTD,
    RunDB,
    RunMetadataTD,
    TopicDataTD,
    TopicRunDetailTD,
    TopicSummaryTD,
    VideoRowTD,
)

from services.utils import to_float_list

logger = logging.getLogger(__name__)


def resolve_cluster_candidate_limit(req) -> int:
    cap = (
        CLUSTER_CANDIDATE_CAP_QUERY
        if req.query is not None
        else CLUSTER_CANDIDATE_CAP_BROWSE
    )
    if req.cluster_candidate_limit is None:
        return cap
    return max(10, min(req.cluster_candidate_limit, cap))


def fetch_clustered_candidates(req, limit: int) -> List[VideoRowTD]:
    params: dict = {"limit": limit}
    conds: List[str] = ["embedding IS NOT NULL"]
    from services.video_service import apply_filters

    apply_filters(req, params, conds)

    if req.query is not None:
        emb = to_float_list(
            embed(
                req.query,
                model=EMBED_MODEL,
                return_format="list",
                prefix=EMBED_QUERY_PREFIX,
            )
        )
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


def search_clustered(req):
    # Returns ClusteredSearchResponse (Pydantic)
    from models.schemas.cluster import ClusteredSearchResponse, ClusterItem

    from services.video_service import row_to_item

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

    by_id: Dict[str, VideoRowTD] = {r["id"]: r for r in rows}
    clusters: List[ClusterItem] = []
    for cluster_name, info in analysis.items():
        is_noise = cluster_name == "Noise/Outliers"
        cluster_id = -1 if is_noise else int(cluster_name.split(" ")[1])
        texts_in_cluster = info["all_texts"]
        probs = info["probabilities"]
        dists = info["distances_to_centroid"]
        sils = info["silhouette_scores"]
        items = []
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
) -> Tuple[List[TopicDataTD], List[AssignmentDataTD]]:
    topics_data: List[TopicDataTD] = []
    assignments_data: List[AssignmentDataTD] = []

    rep_by_topic = {
        item["topic_id"]: item for item in results.get("representative_topics", [])
    }
    topic_names = [str(name) for name in results["model"].topic_names]

    # Get corpus records to map indices back to video_ids
    corpus_records = results.get("corpus_records", [])

    for topic in results.get("topics", []):
        topic_id = topic["topic_id"]
        rep_info = rep_by_topic.get(topic_id, {})
        topic_text = f"{topic_names[topic_id] if topic_id < len(topic_names) else ''} {' '.join([w['word'] for w in topic['words'][:5]])}"

        try:
            topic_emb = embed(
                topic_text,
                model=EMBED_MODEL,
                return_format="list",
                prefix=EMBED_DOC_PREFIX,
            )
        except Exception:
            topic_emb = None

        words = [
            {"word": w["word"], "score": w["score"], "rank": i}
            for i, w in enumerate(topic["words"])
        ]

        # Map representative docs to include video_id
        rep_docs = []
        for doc in rep_info.get("documents", []):
            idx = doc.get("index")
            vid = ""
            if idx is not None and idx < len(corpus_records):
                vid = corpus_records[idx].get("video_id", "")

            rep_docs.append(
                {
                    "content": doc["content"],
                    "membership_score": doc["score"],
                    "video_id": vid,
                }
            )

        topics_data.append(
            {
                "topic_id": topic_id,
                "name": topic_names[topic_id] if topic_id < len(topic_names) else None,
                "representative_doc_count": topic["representative_document_count"],
                "words": words,
                "representative_docs": rep_docs,
                "embedding": topic_emb,
            }
        )

    corpus = results.get("corpus", [])
    for assignment in results.get("document_topics", []):
        idx = assignment["index"]
        vid = ""
        if idx < len(corpus_records):
            vid = corpus_records[idx].get("video_id", "")

        assignments_data.append(
            {
                "source_index": idx,
                "video_id": vid,
                "topic_id": assignment["topic_id"],
                "topic_name": assignment["topic_name"],
                "scores": assignment["scores"],
                "content": corpus[idx] if idx < len(corpus) else "",
            }
        )
    return topics_data, assignments_data


def save_topics(
    code: str, n_topics: int, n_docs: int, top_k: int, no_llm: bool
) -> CodeDashboardSummary:
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
                    "INSERT INTO public.topics (id, run_id, topic_id, name, representative_doc_count, embedding) VALUES (%s, %s, %s, %s, %s, %s)",
                    (
                        topic_uuid,
                        run_id,
                        topic["topic_id"],
                        topic["name"],
                        topic["representative_doc_count"],
                        topic["embedding"],
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

                # Updated INSERT for representative docs to include video_id
                for doc in topic["representative_docs"]:
                    conn.execute(
                        "INSERT INTO public.topic_representative_docs (id, topic_id, content, membership_score, video_id) VALUES (%s, %s, %s, %s, %s)",
                        (
                            str(uuid.uuid4()),
                            topic_uuid,
                            doc["content"],
                            doc["membership_score"],
                            doc["video_id"],
                        ),
                    )

            # Updated INSERT for assignments to include video_id
            for assignment in assignments_data:
                conn.execute(
                    "INSERT INTO public.document_topic_assignments (id, run_id, source_index, video_id, topic_id, topic_name, scores, content) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        str(uuid.uuid4()),
                        run_id,
                        assignment["source_index"],
                        assignment["video_id"],
                        assignment["topic_id"],
                        assignment["topic_name"],
                        assignment["scores"],
                        assignment["content"],
                    ),
                )

            conn.commit()

            # ... [Summary retrieval logic remains unchanged] ...
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

            top_words_raw = summary_row["top_topic_words"]
            if isinstance(top_words_raw, str):
                top_words = json.loads(top_words_raw)
            elif top_words_raw is None:
                top_words = []
            else:
                top_words = top_words_raw

            return CodeDashboardSummary(
                code=summary_row["code"],
                run_id=str(summary_row["run_id"]),
                created_at=summary_row["created_at"],
                n_topics=summary_row["n_topics"],
                n_docs=summary_row["n_docs"],
                top_topic_name=summary_row["top_topic_name"],
                top_topic_rep_count=summary_row["top_topic_rep_count"],
                top_topic_words=top_words,
            )

    except Exception as e:
        logger.error("Failed to save topics: %s", e)
        raise HTTPException(500, f"Failed to save topics: {e}")


def list_topic_runs(code: Optional[str], limit: int, offset: int) -> List[RunDB]:
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
        result: List[RunDB] = []
        for r in rows:
            item: RunDB = {
                "id": str(r["id"]),
                "code": r["code"],
                "n_topics": r["n_topics"],
                "n_docs": r["n_docs"],
                "created_at": r["created_at"],
                "top_k": 0,
                "no_llm": False,
                "model_params": None,
            }
            result.append(item)
        return result
    except Exception as e:
        logger.error("DB error listing topic runs: %s", e)
        raise HTTPException(500, f"Failed to list topic runs: {e}")


def get_topic_run_detail(run_id: str) -> TopicRunDetailTD:
    try:
        with pool.connection() as conn:
            run_row = conn.execute(
                "SELECT id, code, n_topics, n_docs, top_k, no_llm, created_at FROM public.topic_runs WHERE id = %s",
                (run_id,),
            ).fetchone()
            if not run_row:
                raise HTTPException(404, "Topic run not found")

            run_data: RunMetadataTD = {
                "id": str(run_row["id"]),
                "code": run_row["code"],
                "n_topics": run_row["n_topics"],
                "n_docs": run_row["n_docs"],
                "top_k": run_row["top_k"],
                "no_llm": run_row["no_llm"],
                "created_at": run_row["created_at"],
            }

            topics_rows = conn.execute(
                "SELECT id, topic_id, name, representative_doc_count FROM public.topics WHERE run_id = %s ORDER BY topic_id ASC",
                (run_id,),
            ).fetchall()

            topics_list: List[TopicSummaryTD] = []
            for t in topics_rows:
                topic_uuid = str(t["id"])

                # Fetch words
                words_rows = conn.execute(
                    "SELECT word, score, rank FROM public.topic_words WHERE topic_id = %s ORDER BY rank ASC",
                    (topic_uuid,),
                ).fetchall()

                # Fetch representative docs WITH video details
                docs_rows = conn.execute(
                    """
                    SELECT 
                        rd.content, 
                        rd.membership_score, 
                        rd.video_id,
                        v.thumbnail,
                        v.preview,
                        v.title
                    FROM public.topic_representative_docs rd
                    LEFT JOIN public.videos v ON rd.video_id = v.video_id
                    WHERE rd.topic_id = %s 
                    ORDER BY rd.membership_score DESC
                    """,
                    (topic_uuid,),
                ).fetchall()

                topics_list.append(
                    {
                        "id": topic_uuid,
                        "topic_id": t["topic_id"],
                        "name": t["name"],
                        "representative_doc_count": t["representative_doc_count"],
                        "words": [dict(w) for w in words_rows],
                        "representative_docs": [
                            {
                                "content": d["content"],
                                "membership_score": d["membership_score"],
                                "video_id": d["video_id"],
                                "thumbnail": d["thumbnail"],
                                "preview": d["preview"],
                                "title": d["title"],
                            }
                            for d in docs_rows
                        ],
                        "embedding": None,
                    }
                )

            # Fetch assignments WITH video details
            assignments_rows = conn.execute(
                """
                SELECT 
                    da.source_index, 
                    da.video_id, 
                    da.topic_id, 
                    da.topic_name, 
                    da.scores, 
                    da.content,
                    v.thumbnail,
                    v.preview,
                    v.title
                FROM public.document_topic_assignments da
                LEFT JOIN public.videos v ON da.video_id = v.video_id
                WHERE da.run_id = %s 
                ORDER BY da.source_index ASC
                """,
                (run_id,),
            ).fetchall()

            assignments: List[DocumentAssignmentTD] = [
                {
                    "source_index": a["source_index"],
                    "video_id": a["video_id"],
                    "topic_id": a["topic_id"],
                    "topic_name": a["topic_name"],
                    "scores": a["scores"],
                    "content": a["content"],
                    "thumbnail": a["thumbnail"],
                    "preview": a["preview"],
                    "title": a["title"],
                }
                for a in assignments_rows
            ]

    except HTTPException:
        raise
    except Exception as e:
        logger.error("DB error getting topic run detail: %s", e)
        raise HTTPException(500, f"Failed to get topic run detail: {e}")

    return {
        "run": run_data,
        "topics": topics_list,
        "assignments": assignments,
    }


def get_topics_dashboard() -> DashboardResponse:
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

        summaries: List[CodeDashboardSummary] = []
        for r in rows:
            top_words_raw = r["top_topic_words"]
            if isinstance(top_words_raw, str):
                top_words = json.loads(top_words_raw)
            elif top_words_raw is None:
                top_words = []
            else:
                top_words = top_words_raw

            summaries.append(
                CodeDashboardSummary(
                    code=r["code"],
                    run_id=str(r["run_id"]),
                    created_at=r["created_at"],
                    n_topics=r["n_topics"],
                    n_docs=r["n_docs"],
                    top_topic_name=r["top_topic_name"],
                    top_topic_rep_count=r["top_topic_rep_count"],
                    top_topic_words=top_words,
                )
            )

        return DashboardResponse(codes=summaries)

    except Exception as e:
        logger.error("DB error fetching dashboard: %s", e)
        raise HTTPException(500, f"Failed to load dashboard: {e}")


def generate_query_ngrams(query: str) -> List[str]:
    """
    Generates a list of n-grams from a query string.
    Example: 'beautiful mature wife' -> ['beautiful mature wife', 'beautiful mature', 'mature wife', 'beautiful', 'mature', 'wife']
    """
    words = query.lower().split()
    if not words:
        return []

    ngrams = set()
    # Add full phrase
    ngrams.add(query.lower())

    # Add all contiguous sub-phrases of length > 1
    for i in range(len(words)):
        for j in range(i + 2, len(words) + 1):
            ngrams.add(" ".join(words[i:j]))

    # Add individual words
    for word in words:
        ngrams.add(word)

    # Sort by length descending so more specific phrases are processed first (optional but good for debugging)
    return sorted(list(ngrams), key=len, reverse=True)


def search_topics_by_ngrams(
    query: str,
    limit: int,
    min_topic_score: float = 0.0,
    min_doc_score: float = 0.0,
    max_rep_docs: int = 5,
    use_ngram_fusion: bool = True,
) -> List[TopicSearchResultItem]:
    """
    Multi-vector semantic search using n-gram fusion.
    """
    t0 = time.perf_counter()
    k = 60  # RRF constant

    # Generate n-grams
    if use_ngram_fusion:
        ngrams = generate_query_ngrams(query)
    else:
        ngrams = [query.lower()]

    logger.info("Searching with n-grams: %s", ngrams)

    # Store scores and which ngrams contributed
    global_scores: Dict[str, float] = {}
    contributing_ngrams: Dict[str, Set[str]] = {}

    with pool.connection() as conn:
        for ngram in ngrams:
            try:
                emb = embed(
                    ngram,
                    model=EMBED_MODEL,
                    return_format="list",
                    prefix=EMBED_QUERY_PREFIX,
                )
            except Exception as e:
                logger.error("Embedding failed for ngram '%s': %s", ngram, e)
                continue

            # Fetch vector candidates for this specific ngram
            rows = conn.execute(
                """
                SELECT id as topic_id, 
                1.0 / (%(k)s + ROW_NUMBER() OVER (ORDER BY embedding <=> %(emb)s::vector)) as rrf_score
                FROM public.topics
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> %(emb)s::vector
                LIMIT %(limit)s
                """,
                {
                    "emb": emb,
                    "k": k,
                    "limit": limit * 3,
                },  # Fetch more candidates per ngram
            ).fetchall()

            for r in rows:
                tid = str(r["topic_id"])
                score = r["rrf_score"]

                global_scores[tid] = global_scores.get(tid, 0) + score
                if tid not in contributing_ngrams:
                    contributing_ngrams[tid] = set()
                contributing_ngrams[tid].add(ngram)

    # Filter and Sort
    candidates = []
    for tid, score in global_scores.items():
        if score < min_topic_score:
            continue
        candidates.append((tid, score, list(contributing_ngrams[tid])))

    candidates.sort(key=lambda x: -x[1])
    ordered_candidates = candidates[:limit]

    if not ordered_candidates:
        return []

    ids_to_fetch = [x[0] for x in ordered_candidates]

    # Fetch Detailed Info with Video Joins
    final_rows = conn.execute(
        """
        SELECT 
            t.id, t.topic_id, t.name, t.representative_doc_count, t.run_id, tr.code, tr.created_at,
            (SELECT jsonb_agg(jsonb_build_object('word', x.word, 'score', x.score, 'rank', x.rank) ORDER BY x.rank ASC)
             FROM (SELECT w.word, w.score, w.rank FROM public.topic_words w WHERE w.topic_id = t.id ORDER BY w.rank ASC LIMIT 5) x) AS top_words_json,
            (SELECT jsonb_agg(doc_obj ORDER BY (doc_obj->>'membership_score')::float8 DESC)
             FROM (
                 SELECT jsonb_build_object(
                     'video_id', rd.video_id, 'membership_score', rd.membership_score, 'content_snippet', rd.content,
                     'title', v.title, 'thumbnail', v.thumbnail, 'preview', v.preview, 'release_date', v.release_date
                 ) as doc_obj
                 FROM public.topic_representative_docs rd
                 LEFT JOIN public.videos v ON rd.video_id = v.video_id
                 WHERE rd.topic_id = t.id AND rd.membership_score >= %(min_doc_score)s
                 ORDER BY rd.membership_score DESC LIMIT %(max_rep_docs)s
             ) sub) AS rep_docs_with_video
        FROM public.topics t
        JOIN public.topic_runs tr ON t.run_id = tr.id
        WHERE t.id = ANY(%(ids)s::uuid[])
        """,
        {
            "ids": ids_to_fetch,
            "min_doc_score": min_doc_score,
            "max_rep_docs": max_rep_docs,
        },
    ).fetchall()

    row_map = {str(r["id"]): r for r in final_rows}
    result: List[TopicSearchResultItem] = []

    for tid, score, matched_ngrams_list in ordered_candidates:
        r = row_map.get(tid)
        if not r:
            continue

        # Parse Top Words safely
        top_words_raw = r["top_words_json"]
        top_words = []
        if top_words_raw:
            if isinstance(top_words_raw, str):
                top_words = json.loads(top_words_raw)
            elif isinstance(top_words_raw, list):
                top_words = top_words_raw

        # Parse Representative Docs safely
        rep_docs_raw = r["rep_docs_with_video"]
        rep_docs = []
        if rep_docs_raw:
            rep_docs_list = []
            if isinstance(rep_docs_raw, str):
                rep_docs_list = json.loads(rep_docs_raw)
            elif isinstance(rep_docs_raw, list):
                rep_docs_list = rep_docs_raw

            for doc in rep_docs_list:
                if doc:
                    rep_docs.append(RepresentativeDocWithVideo(**doc))

        result.append(
            TopicSearchResultItem(
                run_id=str(r["run_id"]),
                code=r["code"],
                topic_id=r["topic_id"],
                topic_name=r["name"],
                representative_doc_count=r["representative_doc_count"],
                created_at=r["created_at"],
                relevance_score=score,
                matched_ngrams=matched_ngrams_list,
                top_words=top_words,
                representative_docs=rep_docs,
            )
        )

    logger.info(
        "N-gram fusion search done: %d results in %.1fms",
        len(result),
        (time.perf_counter() - t0) * 1000,
    )
    return result

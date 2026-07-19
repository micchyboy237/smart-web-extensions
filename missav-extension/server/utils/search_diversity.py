"""Diversity-aware result selection for semantic search.

Isolated here so chroma_service.py stays focused on CRUD/search plumbing.
This module owns:
  - the SemHash-compatible encoder adapter for our llama.cpp server
  - the MMR-based diversification step applied over an already-fetched
    candidate pool (embeddings are reused from ChromaDB, not recomputed)
  - the "shuffle" sampling step: a weighted random resample of the
    candidate pool, used before diversify() to vary which results surface
    across repeated calls for the same query, while staying biased toward
    relevance (see sample_candidate_pool)
"""

import logging
import time

import numpy as np
from jet.adapters.llama_cpp.embed_utils import embed
from semhash import SemHash

logger = logging.getLogger(__name__)

# "Balanced" default: normalized relevance score is used as-is (exponent 1.0)
# when weighting the shuffle sample. Higher exponent -> favor relevance more
# (less variety per shuffle). Lower exponent -> favor variety more (more
# surprising results, occasionally lower relevance).
BALANCED_RELEVANCE_BIAS = 1.0

# Floor probability weight so even the lowest-scored candidate in the pool
# always has *some* chance of appearing in a shuffle - otherwise a shuffle
# would just keep re-picking from the same top slice of the pool.
MIN_SAMPLE_WEIGHT = 0.05


class LlamaCppSemHashEncoder:
    """
    Semhash-compatible Encoder (see semhash.utils.Encoder protocol — only
    needs `.encode()`), backed by our local llama.cpp embedding server.

    Only invoked by SemHash during the MMR diversity re-ranking step
    (self_find_representative -> _diversify), since the initial index is
    built from embeddings already stored in ChromaDB via
    SemHash.from_embeddings() — no full re-embedding of the candidate pool.
    """

    def encode(self, inputs, **kwargs) -> np.ndarray:
        """
        Encode a string or list of strings into embeddings.
        :param inputs: A string or a list of strings to encode.
        :param **kwargs: Ignored. Kept for Encoder protocol compatibility.
        :return: Embeddings as a numpy array of shape (n_inputs, embedding_dim).
        """
        texts = [inputs] if isinstance(inputs, str) else list(inputs)
        logger.debug(
            f"🧠 [LlamaCppSemHashEncoder] Re-encoding {len(texts)} candidate(s)"
        )
        return embed(texts, return_format="numpy", show_progress=False)


def compute_fetch_k(top_k: int, diversity: float) -> int:
    """
    Compute how many candidates to overfetch before diversifying (normal,
    non-shuffle path).

    MMR needs a pool larger than top_k to have anything to trade relevance
    against — fetching exactly top_k candidates and then "diversifying"
    them is a no-op. Scales with top_k but is capped to avoid an
    unnecessarily expensive Chroma query for large top_k values.

    :param top_k: Number of final results the caller wants.
    :param diversity: Diversity weight (0 disables overfetching entirely).
    :return: Number of candidates to fetch from the vector store.
    """
    if diversity <= 0:
        return top_k
    return min(max(top_k * 4, top_k + 20), 200)


def compute_shuffle_fetch_k(top_k: int) -> int:
    """
    Compute how many candidates to overfetch for a SHUFFLE request.

    Shuffle needs a noticeably bigger pool than the normal path — the
    whole point is to have enough breadth to sample a genuinely different
    subset each time. There's no caching (per current design), so this
    directly controls the Chroma query cost per shuffle click.

    :param top_k: Number of final results the caller wants.
    :return: Number of candidates to fetch from the vector store.
    """
    return min(max(top_k * 10, top_k + 60), 300)


def sample_candidate_pool(
    results: list[dict],
    sample_size: int,
    seed: int,
    relevance_bias: float = BALANCED_RELEVANCE_BIAS,
) -> list[dict]:
    """
    Weighted random sample (without replacement) of `results`, biased
    toward higher relevance scores. This is what makes "shuffle" vary
    across calls: a different random subset of the (still relevant)
    candidate pool is chosen each time, before MMR diversifies it.

    Weighting scheme: scores are min-max normalized to [0, 1] across the
    pool, then raised to `relevance_bias` and floored at MIN_SAMPLE_WEIGHT
    so no candidate has zero chance of being picked.
        relevance_bias > 1.0  -> favors top-scored candidates more
                                  (shuffles look more similar to each other)
        relevance_bias == 1.0 -> balanced (default)
        relevance_bias < 1.0  -> favors variety more
                                  (shuffles can surface weaker matches)

    :param results: Scored search results; each dict must have a "score" key.
    :param sample_size: Number of results to sample.
    :param seed: Random seed — same seed always produces the same sample.
    :param relevance_bias: Exponent controlling relevance-vs-variety balance.
    :return: Sampled subset of `results`, length == min(sample_size, len(results)).
    """
    if sample_size >= len(results):
        return results

    scores = np.asarray([r["score"] for r in results], dtype=np.float64)
    score_range = scores.max() - scores.min()
    normalized = (
        (scores - scores.min()) / score_range
        if score_range > 0
        else np.ones_like(scores)
    )

    weights = np.power(normalized, relevance_bias) + MIN_SAMPLE_WEIGHT
    weights = weights / weights.sum()

    rng = np.random.default_rng(seed)
    indices = rng.choice(len(results), size=sample_size, replace=False, p=weights)

    logger.debug(
        f"🔀 [SearchDiversity] Sampled {sample_size}/{len(results)} candidates "
        f"(seed={seed}, relevance_bias={relevance_bias})"
    )
    return [results[i] for i in indices]


def diversify_results(
    results: list[dict],
    top_k: int,
    diversity: float,
    get_embeddings_fn,
) -> list[dict]:
    """
    Select a diverse subset of `results` using SemHash's MMR-based
    diversification (pyversity under the hood).

    Reuses embeddings already stored in ChromaDB for the candidate pool —
    the custom LlamaCpp encoder is only used internally by SemHash to
    re-embed the shortlisted candidates during MMR re-ranking.

    Works identically whether `results` is the plain overfetched pool
    (normal path) or an already-shuffled subset of it (shuffle path) —
    shuffling only changes what's fed in here, not this function itself.

    :param results: Candidate search results (already ranked by relevance,
        already score-filtered), each a dict with at least "id" and
        "document".
    :param top_k: Number of diverse representatives to select.
    :param diversity: Trade-off between diversity (1.0) and relevance (0.0).
    :param get_embeddings_fn: Callable(ids: list[str]) -> Optional[np.ndarray],
        used to fetch stored embeddings for the candidate pool. Injected
        rather than imported to avoid a circular import with
        chroma_service.py.
    :return: Diversified subset of `results`, length <= top_k. Falls back
        to a plain top_k slice if embeddings can't be retrieved/aligned.
    """
    if len(results) <= top_k:
        return results

    ids = [r["id"] for r in results]
    embeddings = get_embeddings_fn(ids)

    if embeddings is None or len(embeddings) != len(results):
        logger.warning(
            f"⚠️ [SearchDiversity] Could not retrieve aligned embeddings for "
            f"{len(ids)} candidates — skipping diversification, returning "
            f"top_k by relevance"
        )
        return results[:top_k]

    start_time = time.time()
    semhash = SemHash.from_embeddings(
        embeddings=embeddings,
        records=results,
        model=LlamaCppSemHashEncoder(),
        columns=["document"],
    )
    diversified = semhash.self_find_representative(
        diversity=diversity,
        selection_size=top_k,
    )
    elapsed = (time.time() - start_time) * 1000
    logger.info(
        f"🎨 [SearchDiversity] Diversified {len(results)} candidates -> "
        f"{len(diversified.selected)} results (diversity={diversity}) "
        f"in {elapsed:.2f}ms"
    )
    return diversified.selected


def shuffle_and_diversify(
    results: list[dict],
    top_k: int,
    diversity: float,
    seed: int,
    get_embeddings_fn,
    relevance_bias: float = BALANCED_RELEVANCE_BIAS,
) -> list[dict]:
    """
    Shuffle entry point: weighted-sample the overfetched candidate pool
    down to a workable size, then run the normal MMR diversify step on
    that sample.

    :param results: The overfetched, score-filtered candidate pool (should
        be fetched with compute_shuffle_fetch_k for enough variety).
    :param top_k: Number of final results to return.
    :param diversity: Trade-off between diversity (1.0) and relevance (0.0),
        applied during the diversify step (same meaning as elsewhere).
    :param seed: Random seed for the shuffle — same seed -> same output.
    :param get_embeddings_fn: See diversify_results.
    :param relevance_bias: See sample_candidate_pool.
    :return: A diverse top_k subset, varying by `seed`.
    """
    # Sample down to roughly the same size a normal (non-shuffle) diversify
    # candidate pool would use, just drawn randomly instead of by strict rank.
    sample_size = min(len(results), compute_fetch_k(top_k, diversity))
    sampled = sample_candidate_pool(
        results, sample_size=sample_size, seed=seed, relevance_bias=relevance_bias
    )
    return diversify_results(
        sampled, top_k=top_k, diversity=diversity, get_embeddings_fn=get_embeddings_fn
    )

"""Diversity-aware search strategy using MMR and metadata-based diversity.

Self-contained implementation — no external MMR dependencies.
Calculates per-result diversity_score for transparency.

Performance optimizations:
- Pre-trims candidates before expensive MMR (O(n²) → O(k²))
- Reuses pre-computed embeddings from ChromaDB
- Falls back to fast metadata interleaving when embeddings unavailable
- Early exit when diversity_factor=0 or results ≤ 1
"""

import logging
from collections import defaultdict
from typing import Optional

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger(__name__)


class DiversityAwareSearch:
    """
    Search strategy that balances relevance with diversity.

    Implements Maximal Marginal Relevance (MMR) and code-limit enforcement
    to avoid showing too many similar videos from the same series.

    Calculates diversity_score for each result:
        diversity_score = 1.0 - avg_cosine_similarity_to_other_results
        Higher = more unique/diverse in the result set.
    """

    MAX_MMR_CANDIDATES: int = 40

    def __init__(
        self,
        diversity_factor: float = 0.3,
        max_per_code: Optional[int] = None,
    ):
        """
        Args:
            diversity_factor: 0 = pure relevance, 1 = maximum diversity.
            max_per_code: Maximum results allowed per series code.
        """
        self.diversity_factor = diversity_factor
        self.max_per_code = max_per_code
        self.scaler = MinMaxScaler()

    # ── public API ──────────────────────────────────────────────────

    def apply_diversity(
        self,
        results: list[dict],
        embeddings: Optional[np.ndarray] = None,
    ) -> list[dict]:
        """
        Apply diversity re-ranking and attach diversity_score to each result.

        Args:
            results: List of dicts with keys: id, score, metadata.
            embeddings: Optional pre-computed embedding vectors (N x D).

        Returns:
            Re-ranked results with diversity_score added to each dict.
        """
        if not results or self.diversity_factor <= 0:
            logger.debug(
                "DiversityAwareSearch: skipping (empty=%s, factor=%.2f)",
                not results,
                self.diversity_factor,
            )
            for r in results:
                r["diversity_score"] = 0.0
            return results

        logger.info(
            "DiversityAwareSearch: processing %d results "
            "(factor=%.2f, max_per_code=%s)",
            len(results),
            self.diversity_factor,
            self.max_per_code,
        )

        # Step 1: per-code limit enforcement
        if self.max_per_code is not None:
            results = self._enforce_code_limit(results)
            if embeddings is not None and len(embeddings) > len(results):
                kept_ids = {r["id"] for r in results}
                indices = [i for i, r in enumerate(results) if r["id"] in kept_ids]
                embeddings = embeddings[indices] if indices else None

        # Step 2: calculate diversity scores BEFORE re-ranking
        if embeddings is not None and len(embeddings) > 1:
            diversity_scores = self._calculate_diversity_scores(results, embeddings)
            for i, r in enumerate(results):
                r["diversity_score"] = float(diversity_scores[i])
        else:
            for r in results:
                r["diversity_score"] = 0.0

        # Step 3: pre-trim for MMR performance
        if embeddings is not None and len(embeddings) > self.MAX_MMR_CANDIDATES:
            logger.debug(
                "DiversityAwareSearch: trimming MMR candidates %d → %d",
                len(results),
                self.MAX_MMR_CANDIDATES,
            )
            results = results[: self.MAX_MMR_CANDIDATES]
            embeddings = embeddings[: self.MAX_MMR_CANDIDATES]

        # Step 4: diversity re-ranking
        if embeddings is not None and len(embeddings) > 1:
            logger.debug(
                "DiversityAwareSearch: using MMR (embeddings shape=%s, lambda=%.2f)",
                embeddings.shape,
                1.0 - self.diversity_factor,
            )
            results = self._apply_mmr(results, embeddings)
        else:
            if embeddings is not None and len(embeddings) <= 1:
                logger.debug(
                    "DiversityAwareSearch: too few embeddings for MMR, "
                    "using metadata fallback"
                )
            else:
                logger.debug(
                    "DiversityAwareSearch: no embeddings, using metadata fallback"
                )
            results = self._metadata_diversity(results)

        logger.info(
            "DiversityAwareSearch: diversified to %d results "
            "(avg diversity_score=%.3f)",
            len(results),
            np.mean([r.get("diversity_score", 0.0) for r in results]),
        )
        return results

    # ── private helpers ──────────────────────────────────────────────

    def _enforce_code_limit(self, results: list[dict]) -> list[dict]:
        """Limit the number of results per series code."""
        code_counts: dict[str, int] = {}
        filtered: list[dict] = []
        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            code_counts[code] = code_counts.get(code, 0) + 1
            if code_counts[code] <= self.max_per_code:
                filtered.append(r)
        removed = len(results) - len(filtered)
        if removed > 0:
            logger.debug("DiversityAwareSearch: code limit removed %d results", removed)
        return filtered

    def _calculate_diversity_scores(
        self,
        results: list[dict],
        embeddings: np.ndarray,
    ) -> np.ndarray:
        """
        Per-result diversity score.

        diversity_score = 1.0 - mean cosine similarity to all other results.

        Returns:
            1-D array of shape (n,) — higher = more unique in the set.
        """
        n = len(results)
        if n <= 1:
            return np.ones(n, dtype=np.float64) if n == 1 else np.array([])

        sim_matrix = cosine_similarity(embeddings)  # (n, n)

        avg_similarities = np.zeros(n, dtype=np.float64)
        for i in range(n):
            others = np.concatenate([sim_matrix[i, :i], sim_matrix[i, i + 1 :]])
            avg_similarities[i] = np.mean(others)

        diversity_scores = 1.0 - avg_similarities

        logger.debug(
            "DiversityAwareSearch: diversity_scores "
            "min=%.3f max=%.3f mean=%.3f std=%.3f",
            float(diversity_scores.min()),
            float(diversity_scores.max()),
            float(diversity_scores.mean()),
            float(diversity_scores.std()),
        )
        return diversity_scores

    def _apply_mmr(
        self,
        results: list[dict],
        embeddings: np.ndarray,
    ) -> list[dict]:
        """
        Maximal Marginal Relevance (MMR) — greedy re-ranking.

        Iteratively selects the result that maximises:
            λ · relevance  −  (1 − λ) · max_similarity_to_selected

        where λ = 1 − diversity_factor.
        """
        n = len(results)
        if n <= 1:
            return results

        scores = np.array([r["score"] for r in results], dtype=np.float64)
        score_min = scores.min()
        score_max = scores.max()
        if score_max - score_min < 1e-8:
            logger.debug(
                "DiversityAwareSearch: uniform scores, using metadata diversity only"
            )
            return self._metadata_diversity(results)

        scores_norm = (scores - score_min) / (score_max - score_min)
        sim_matrix = cosine_similarity(embeddings)
        lambda_weight = 1.0 - self.diversity_factor

        selected: list[int] = [0]
        remaining: list[int] = list(range(1, n))

        logger.debug(
            "DiversityAwareSearch: MMR running lambda=%.2f candidates=%d",
            lambda_weight,
            n,
        )

        while remaining:
            mmr_scores = []
            for idx in remaining:
                relevance = scores_norm[idx]
                max_sim = max(sim_matrix[idx][s] for s in selected)
                mmr = lambda_weight * relevance - self.diversity_factor * max_sim
                mmr_scores.append(mmr)

            best_local = int(np.argmax(mmr_scores))
            best_idx = remaining[best_local]
            selected.append(best_idx)
            remaining.remove(best_idx)

        logger.debug(
            "DiversityAwareSearch: MMR complete, selected %d/%d",
            len(selected),
            n,
        )
        return [results[i] for i in selected]

    def _metadata_diversity(self, results: list[dict]) -> list[dict]:
        """
        Metadata-based diversity fallback.

        Round-robin interleaving by series code, blended with original
        relevance order when diversity_factor < 1.0.
        """
        by_code: dict[str, list[dict]] = defaultdict(list)
        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            by_code[code].append(r)

        for code in by_code:
            by_code[code].sort(key=lambda x: x["score"], reverse=True)

        diversified: list[dict] = []
        codes = list(by_code.keys())
        max_len = max(len(group) for group in by_code.values())
        for i in range(max_len):
            for code in codes:
                if i < len(by_code[code]):
                    diversified.append(by_code[code][i])

        if self.diversity_factor < 1.0:
            original_order = {r["id"]: idx for idx, r in enumerate(results)}
            diversified.sort(
                key=lambda x: (
                    (1.0 - self.diversity_factor)
                    * original_order.get(x["id"], len(results))
                    + self.diversity_factor * diversified.index(x)
                )
            )

        return diversified


# Singleton instance used by routes/search.py
diversity_search = DiversityAwareSearch()

"""Diversity-aware search strategy using MMR and metadata-based diversity."""

import logging
from collections import defaultdict
from typing import Optional

import numpy as np
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger(__name__)


class DiversityAwareSearch:
    """
    Search strategy that balances relevance with diversity.

    Implements Maximal Marginal Relevance (MMR) and code-limit enforcement
    to avoid showing too many similar videos from the same series.
    """

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

    def apply_diversity(
        self,
        results: list[dict],
        embeddings: Optional[np.ndarray] = None,
    ) -> list[dict]:
        """
        Apply diversity re-ranking to a list of search results.

        When embeddings are provided, uses the MMR algorithm for
        embedding-aware diversity. Otherwise falls back to metadata-based
        interleaving by series code.

        Args:
            results: List of dicts with keys: id, score, metadata.
            embeddings: Optional pre-computed embedding vectors (N x D).

        Returns:
            Re-ranked results with diversity applied.
        """
        if not results or self.diversity_factor <= 0:
            logger.debug("DiversityAwareSearch: skipping (empty results or factor=0)")
            return results

        logger.info(
            "DiversityAwareSearch: applying diversity factor=%.2f max_per_code=%s",
            self.diversity_factor,
            self.max_per_code,
        )

        # Step 1 — enforce per-code limit if configured
        if self.max_per_code is not None:
            results = self._enforce_code_limit(results)

        # Step 2 — apply the best available diversity algorithm
        if embeddings is not None and len(embeddings) > 1:
            logger.debug("DiversityAwareSearch: using MMR (embeddings available)")
            results = self._apply_mmr(results, embeddings)
        else:
            logger.debug("DiversityAwareSearch: using metadata diversity fallback")
            results = self._metadata_diversity(results)

        logger.info("DiversityAwareSearch: diversified to %d results", len(results))
        return results

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

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

    def _apply_mmr(
        self,
        results: list[dict],
        embeddings: np.ndarray,
    ) -> list[dict]:
        """
        Maximal Marginal Relevance (MMR) algorithm.

        Iteratively selects the result that maximizes:
            λ · relevance  —  (1 − λ) · max_similarity_to_selected

        where λ = 1 − diversity_factor.
        """
        n = len(results)
        if n <= 1:
            return results

        from sklearn.metrics.pairwise import cosine_similarity

        scores = np.array([r["score"] for r in results])
        scores_norm = (scores - scores.min()) / (scores.max() - scores.min() + 1e-8)

        sim_matrix = cosine_similarity(embeddings)

        selected_indices = [0]
        remaining = list(range(1, n))

        while remaining:
            mmr_scores = []
            for idx in remaining:
                relevance = scores_norm[idx]
                max_similarity = max(sim_matrix[idx][selected_indices])
                mmr = (
                    1.0 - self.diversity_factor
                ) * relevance - self.diversity_factor * max_similarity
                mmr_scores.append(mmr)

            best_local = int(np.argmax(mmr_scores))
            best_idx = remaining[best_local]
            selected_indices.append(best_idx)
            remaining.remove(best_idx)

        return [results[i] for i in selected_indices]

    def _metadata_diversity(self, results: list[dict]) -> list[dict]:
        """
        Metadata-based diversity fallback.

        Groups results by series code, then interleaves them so that
        consecutive results come from different codes.  When
        diversity_factor < 1.0 a weighted sort is applied that blends
        the original relevance order with the interleaved order.
        """
        by_code: dict[str, list[dict]] = defaultdict(list)
        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            by_code[code].append(r)

        # Sort each code group by score (descending)
        for code in by_code:
            by_code[code].sort(key=lambda x: x["score"], reverse=True)

        # Interleave
        diversified: list[dict] = []
        codes = list(by_code.keys())
        max_len = max(len(group) for group in by_code.values())

        for i in range(max_len):
            for code in codes:
                if i < len(by_code[code]):
                    diversified.append(by_code[code][i])

        # Blend with original order when diversity is not maxed out
        if self.diversity_factor < 1.0:
            original_order = {r["id"]: idx for idx, r in enumerate(results)}
            # Use the interleaved position as a secondary sort key
            diversified.sort(
                key=lambda x: (
                    (1.0 - self.diversity_factor)
                    * original_order.get(x["id"], len(results))
                    + self.diversity_factor * diversified.index(x)
                )
            )

        return diversified

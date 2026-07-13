"""Diversity-aware search strategy using MMR and metadata-based diversity."""

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

    Performance optimizations:
    - Pre-trims candidates before expensive MMR computation (O(n²) → O(k²))
    - Reuses pre-computed embeddings from ChromaDB when available
    - Falls back to fast metadata interleaving when embeddings unavailable
    - Early exit when diversity_factor=0 or results ≤ 1
    """

    # Maximum candidates to process with MMR (O(n²) complexity)
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
            logger.debug(
                "DiversityAwareSearch: skipping (empty=%s, factor=%.2f)",
                not results,
                self.diversity_factor,
            )
            return results

        logger.info(
            "DiversityAwareSearch: applying diversity "
            "factor=%.2f max_per_code=%s candidates=%d",
            self.diversity_factor,
            self.max_per_code,
            len(results),
        )

        # Step 1: Enforce per-code limits (fast metadata operation)
        if self.max_per_code is not None:
            results = self._enforce_code_limit(results)
            # Trim embeddings to match if provided
            if embeddings is not None and len(embeddings) > len(results):
                kept_ids = {r["id"] for r in results}
                indices = [i for i, r in enumerate(results) if r["id"] in kept_ids]
                embeddings = embeddings[indices] if indices else None

        # Step 2: Pre-trim candidates for MMR (O(n²) → O(k²) optimization)
        if embeddings is not None and len(embeddings) > self.MAX_MMR_CANDIDATES:
            logger.debug(
                "DiversityAwareSearch: trimming MMR candidates %d → %d",
                len(results),
                self.MAX_MMR_CANDIDATES,
            )
            results = results[: self.MAX_MMR_CANDIDATES]
            embeddings = embeddings[: self.MAX_MMR_CANDIDATES]

        # Step 3: Apply diversity re-ranking
        if embeddings is not None and len(embeddings) > 1:
            logger.debug(
                "DiversityAwareSearch: using MMR (embeddings shape=%s)",
                embeddings.shape,
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

        logger.info("DiversityAwareSearch: diversified to %d results", len(results))
        return results

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
            λ · relevance  -  (1 - λ) · max_similarity_to_selected

        where λ = 1 - diversity_factor.

        Performance: O(k²) where k ≤ MAX_MMR_CANDIDATES.
        """
        n = len(results)
        if n <= 1:
            return results

        # Normalize scores to [0, 1] for stable MMR calculation
        scores = np.array([r["score"] for r in results], dtype=np.float64)
        score_min = scores.min()
        score_max = scores.max()
        if score_max - score_min < 1e-8:
            # All scores equal — skip expensive MMR, just apply code diversity
            logger.debug(
                "DiversityAwareSearch: uniform scores, using metadata diversity only"
            )
            return self._metadata_diversity(results)

        scores_norm = (scores - score_min) / (score_max - score_min)

        # Compute pairwise cosine similarity matrix
        # Shape: (n, n), symmetric with ones on diagonal
        sim_matrix = cosine_similarity(embeddings)

        # MMR weight: lambda balances relevance vs diversity
        # lambda=1.0 → pure relevance, lambda=0.0 → pure diversity
        lambda_weight = 1.0 - self.diversity_factor

        # Greedy MMR selection
        selected_indices: list[int] = [0]  # Always pick highest-scored first
        remaining: list[int] = list(range(1, n))

        logger.debug(
            "DiversityAwareSearch: MMR running "
            "lambda=%.2f candidates=%d max_results=%d",
            lambda_weight,
            n,
            n,
        )

        while remaining:
            mmr_scores = []
            for idx in remaining:
                relevance = scores_norm[idx]
                # Max similarity to any already-selected result
                max_similarity = max(sim_matrix[idx][s] for s in selected_indices)
                mmr = lambda_weight * relevance - self.diversity_factor * max_similarity
                mmr_scores.append(mmr)

            best_local = int(np.argmax(mmr_scores))
            best_idx = remaining[best_local]
            selected_indices.append(best_idx)
            remaining.remove(best_idx)

        logger.debug(
            "DiversityAwareSearch: MMR complete, selected %d/%d",
            len(selected_indices),
            n,
        )
        return [results[i] for i in selected_indices]

    def _metadata_diversity(self, results: list[dict]) -> list[dict]:
        """
        Metadata-based diversity fallback.

        Groups results by series code, then interleaves them so that
        consecutive results come from different codes. When
        diversity_factor < 1.0 a weighted sort blends the original
        relevance order with the interleaved order.

        Performance: O(n log n) — much faster than MMR's O(n²).
        """
        # Group results by series code
        by_code: dict[str, list[dict]] = defaultdict(list)
        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            by_code[code].append(r)

        # Sort each group by relevance score (descending)
        for code in by_code:
            by_code[code].sort(key=lambda x: x["score"], reverse=True)

        # Interleave: pick one from each code in round-robin fashion
        diversified: list[dict] = []
        codes = list(by_code.keys())
        max_len = max(len(group) for group in by_code.values())
        for i in range(max_len):
            for code in codes:
                if i < len(by_code[code]):
                    diversified.append(by_code[code][i])

        # Blend interleaved order with original relevance order
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


# Create the singleton instance that routes/search.py expects
diversity_search = DiversityAwareSearch()

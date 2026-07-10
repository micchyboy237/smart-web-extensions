# Jet_Apps/server/utils/search_strategies.py
"""Advanced search strategies for diverse video recommendations."""

import logging
from typing import Optional

import numpy as np
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger(__name__)


class DiversityAwareSearch:
    """
    Search strategy that balances relevance with diversity.

    Implements Maximal Marginal Relevance (MMR) and other techniques
    to avoid showing too many similar videos.
    """

    def __init__(
        self,
        diversity_factor: float = 0.3,
        max_per_code: Optional[int] = None,
    ):
        """
        Args:
            diversity_factor: 0 = pure relevance, 1 = max diversity
            max_per_code: Max results per series code
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
        Apply MMR (Maximal Marginal Relevance) for diversity.

        Args:
            results: List of {id, score, metadata} dicts
            embeddings: Pre-computed embeddings for MMR (optional)

        Returns:
            Re-ranked results with diversity applied
        """
        if not results or self.diversity_factor <= 0:
            return results

        logger.info(
            f"Applying diversity (factor={self.diversity_factor}, "
            f"max_per_code={self.max_per_code})"
        )

        # Step 1: Enforce max_per_code constraint
        if self.max_per_code:
            results = self._enforce_code_limit(results)

        # Step 2: Apply MMR if embeddings available
        if embeddings is not None and len(embeddings) > 1:
            results = self._apply_mmr(results, embeddings)
        else:
            # Fallback: use metadata-based diversity
            results = self._metadata_diversity(results)

        logger.info(f"Diversified to {len(results)} results")
        return results

    def _enforce_code_limit(self, results: list[dict]) -> list[dict]:
        """Limit results per series code."""
        code_counts = {}
        filtered = []

        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            code_counts[code] = code_counts.get(code, 0) + 1

            if code_counts[code] <= self.max_per_code:
                filtered.append(r)

        removed = len(results) - len(filtered)
        if removed > 0:
            logger.debug(f"Code limit removed {removed} results")

        return filtered

    def _apply_mmr(
        self,
        results: list[dict],
        embeddings: np.ndarray,
    ) -> list[dict]:
        """
        Maximal Marginal Relevance algorithm.

        Selects results that are both relevant AND diverse from
        already selected results.
        """
        n = len(results)
        if n <= 1:
            return results

        # Normalize relevance scores to [0, 1]
        scores = np.array([r["score"] for r in results])
        scores_norm = (scores - scores.min()) / (scores.max() - scores.min() + 1e-8)

        # Compute pairwise similarities
        from sklearn.metrics.pairwise import cosine_similarity

        sim_matrix = cosine_similarity(embeddings)

        selected_indices = [0]  # Start with highest scored
        remaining = list(range(1, n))

        while remaining:
            mmr_scores = []
            for idx in remaining:
                # Relevance minus max similarity to any selected
                relevance = scores_norm[idx]
                max_similarity = max(sim_matrix[idx][selected_indices])
                mmr = (
                    1 - self.diversity_factor
                ) * relevance - self.diversity_factor * max_similarity
                mmr_scores.append(mmr)

            # Select best MMR score
            best_idx = remaining[np.argmax(mmr_scores)]
            selected_indices.append(best_idx)
            remaining.remove(best_idx)

        # Reorder results
        return [results[i] for i in selected_indices]

    def _metadata_diversity(self, results: list[dict]) -> list[dict]:
        """
        Metadata-based diversity fallback.

        Groups by code and interleaves results from different codes.
        """
        from collections import defaultdict

        # Group by code
        by_code = defaultdict(list)
        for r in results:
            code = r.get("metadata", {}).get("code", "unknown")
            by_code[code].append(r)

        # Sort groups by best score
        for code in by_code:
            by_code[code].sort(key=lambda x: x["score"], reverse=True)

        # Interleave results from different codes
        diversified = []
        codes = list(by_code.keys())
        max_len = max(len(group) for group in by_code.values())

        for i in range(max_len):
            for code in codes:
                if i < len(by_code[code]):
                    diversified.append(by_code[code][i])

        # Apply diversity factor: blend with original order
        if self.diversity_factor < 1.0:
            original_order = {r["id"]: idx for idx, r in enumerate(results)}
            diversified.sort(
                key=lambda x: (
                    (1 - self.diversity_factor)
                    * original_order.get(x["id"], len(results))
                    + self.diversity_factor * diversified.index(x)
                )
            )

        return diversified


class EnsembleSearchStrategy:
    """
    Multi-signal ensemble search combining:
    - Semantic (embedding) similarity
    - Keyword (BM25) matching
    - Code popularity/recency
    - User preference boosting
    """

    def __init__(
        self,
        weights: Optional[dict] = None,
    ):
        self.weights = weights or {
            "semantic": 0.35,
            "keyword": 0.25,
            "recency": 0.15,
            "diversity": 0.15,
            "preference": 0.10,
        }

        # Normalize weights
        total = sum(self.weights.values())
        self.weights = {k: v / total for k, v in self.weights.items()}

    def combine_scores(
        self,
        semantic_scores: np.ndarray,
        keyword_scores: np.ndarray,
        recency_scores: np.ndarray,
        preference_boost: np.ndarray,
    ) -> np.ndarray:
        """
        Combine multiple signal scores with configured weights.

        Args:
            semantic_scores: From embedding similarity
            keyword_scores: From BM25 or keyword matching
            recency_scores: Based on when video was added
            preference_boost: Boost from user preferences

        Returns:
            Combined scores array
        """
        # Normalize all scores to [0, 1]
        scaler = MinMaxScaler()

        scores_stack = np.vstack(
            [
                semantic_scores,
                keyword_scores,
                recency_scores,
                preference_boost,
            ]
        )

        normalized = scaler.fit_transform(scores_stack.T).T

        # Weighted combination
        combined = (
            self.weights["semantic"] * normalized[0]
            + self.weights["keyword"] * normalized[1]
            + self.weights["recency"] * normalized[2]
            + self.weights["preference"] * normalized[3]
        )

        return combined


class QueryUnderstanding:
    """
    Parse and understand user queries to extract intent and filters.

    Examples:
    - "popular juq videos from episode 300-400" → code=juq, episode_range=[300,400]
    - "new mxgs content not juq" → include=mxgs, exclude=juq
    - "something like juq-373 but different" → similar_to=juq-373, diversity=high
    """

    # Pattern matching for common query structures
    import re

    CODE_PATTERN = re.compile(r"\b([a-z]{2,5})\b", re.IGNORECASE)
    EPISODE_PATTERN = re.compile(r"\b(\d{3,4})\b")
    RANGE_PATTERN = re.compile(r"(\d+)\s*[-–]\s*(\d+)")

    @classmethod
    def parse(cls, query: str) -> dict:
        """
        Extract structured understanding from natural language query.

        Returns:
            dict with extracted filters and intent
        """
        understanding = {
            "intent": "search",
            "extracted_codes": [],
            "extracted_episodes": [],
            "episode_range": None,
            "exclude_codes": [],
            "diversity_hint": None,
        }

        query_lower = query.lower()

        # Detect intent
        if any(word in query_lower for word in ["popular", "trending", "top"]):
            understanding["intent"] = "popular"
        elif any(word in query_lower for word in ["new", "latest", "recent"]):
            understanding["intent"] = "recent"
        elif any(word in query_lower for word in ["similar to", "like", "related"]):
            understanding["intent"] = "similar"

        # Detect diversity preference
        if any(
            word in query_lower for word in ["diverse", "variety", "different", "mix"]
        ):
            understanding["diversity_hint"] = "high"
        elif any(word in query_lower for word in ["focused", "specific", "exact"]):
            understanding["diversity_hint"] = "low"

        # Extract codes
        codes = cls.CODE_PATTERN.findall(query_lower)
        # Filter out common words
        stop_words = {"the", "and", "for", "not", "but", "from", "with", "new", "top"}
        understanding["extracted_codes"] = [c for c in codes if c not in stop_words]

        # Detect exclusion ("not juq", "except mxgs")
        if "not " in query_lower or "except" in query_lower:
            exclude_matches = cls.CODE_PATTERN.findall(
                query_lower.split("not ")[-1]
                if "not " in query_lower
                else query_lower.split("except")[-1]
            )
            understanding["exclude_codes"] = [
                c for c in exclude_matches if c not in stop_words
            ]

        # Extract episode numbers and ranges
        episodes = cls.EPISODE_PATTERN.findall(query)
        if episodes:
            understanding["extracted_episodes"] = [int(e) for e in episodes]

        # Detect range
        range_match = cls.RANGE_PATTERN.search(query)
        if range_match:
            understanding["episode_range"] = (
                int(range_match.group(1)),
                int(range_match.group(2)),
            )

        logger.debug(f"Query understanding: {understanding}")
        return understanding

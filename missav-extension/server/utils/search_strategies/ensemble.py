"""Ensemble search strategy combining multiple ranking signals."""

import logging
from typing import Optional

import numpy as np
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger(__name__)


class EnsembleSearchStrategy:
    """
    Multi-signal ensemble search.

    Combines semantic similarity, keyword matching, recency, and user
    preference boosting into a single weighted score.
    """

    # Default weight distribution across signals
    DEFAULT_WEIGHTS: dict[str, float] = {
        "semantic": 0.35,
        "keyword": 0.25,
        "recency": 0.15,
        "diversity": 0.15,
        "preference": 0.10,
    }

    def __init__(self, weights: Optional[dict[str, float]] = None):
        """
        Args:
            weights: Optional per-signal weight overrides.  Keys must be
                     a subset of DEFAULT_WEIGHTS keys.  Weights are
                     normalised to sum to 1.
        """
        raw = {**self.DEFAULT_WEIGHTS, **(weights or {})}
        total = sum(raw.values())
        self.weights = {k: v / total for k, v in raw.items()}
        logger.info(
            "EnsembleSearchStrategy: initialised with weights=%s",
            {k: round(v, 3) for k, v in self.weights.items()},
        )

    def combine_scores(
        self,
        semantic_scores: np.ndarray,
        keyword_scores: np.ndarray,
        recency_scores: np.ndarray,
        preference_boost: np.ndarray,
    ) -> np.ndarray:
        """
        Combine four signal arrays into a single score per item.

        All input arrays must have the same length (N,).

        Args:
            semantic_scores: Embedding similarity scores.
            keyword_scores: BM25 / keyword match scores.
            recency_scores: Recency-based scores.
            preference_boost: User preference boost scores.

        Returns:
            Combined score array of shape (N,).

        Raises:
            ValueError: If input arrays have different lengths.
        """
        lengths = {
            name: len(arr)
            for name, arr in [
                ("semantic", semantic_scores),
                ("keyword", keyword_scores),
                ("recency", recency_scores),
                ("preference", preference_boost),
            ]
        }
        if len(set(lengths.values())) != 1:
            raise ValueError(
                f"All score arrays must have the same length, got: {lengths}"
            )

        logger.debug("EnsembleSearchStrategy: combining %d scores", lengths["semantic"])

        # Stack and normalise each signal independently to [0, 1]
        scaler = MinMaxScaler()
        scores_stack = np.vstack(
            [semantic_scores, keyword_scores, recency_scores, preference_boost]
        )  # shape (4, N)

        normalized = scaler.fit_transform(scores_stack.T).T  # shape (4, N)

        combined = (
            self.weights["semantic"] * normalized[0]
            + self.weights["keyword"] * normalized[1]
            + self.weights["recency"] * normalized[2]
            + self.weights["preference"] * normalized[3]
        )

        logger.debug(
            "EnsembleSearchStrategy: combined scores → min=%.4f max=%.4f mean=%.4f",
            float(combined.min()),
            float(combined.max()),
            float(combined.mean()),
        )
        return combined

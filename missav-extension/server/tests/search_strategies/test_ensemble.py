"""Unit tests for EnsembleSearchStrategy."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from utils.search_strategies.ensemble import EnsembleSearchStrategy


class TestDefaultWeights:
    def test_default_weights_sum_to_one(self):
        strategy = EnsembleSearchStrategy()
        total = sum(strategy.weights.values())
        assert abs(total - 1.0) < 1e-9

    def test_default_weights_have_expected_keys(self):
        strategy = EnsembleSearchStrategy()
        assert set(strategy.weights.keys()) == {
            "semantic",
            "keyword",
            "recency",
            "diversity",
            "preference",
        }


class TestCustomWeights:
    def test_custom_weights_normalised(self):
        strategy = EnsembleSearchStrategy(weights={"semantic": 10.0, "keyword": 10.0})
        # Defaults: semantic=0.35, keyword=0.25, recency=0.15, diversity=0.15, preference=0.10
        # Override semantic→10, keyword→10 → total = 10+10+0.15+0.15+0.10 = 20.40
        total = 10.0 + 10.0 + 0.15 + 0.15 + 0.10
        assert abs(strategy.weights["semantic"] - 10.0 / total) < 1e-9
        assert abs(strategy.weights["preference"] - 0.10 / total) < 1e-9


class TestCombineScores:
    def test_combine_returns_correct_shape(self):
        strategy = EnsembleSearchStrategy()
        N = 10
        sem = np.random.rand(N)
        kw = np.random.rand(N)
        rec = np.random.rand(N)
        pref = np.random.rand(N)
        combined = strategy.combine_scores(sem, kw, rec, pref)
        assert combined.shape == (N,)

    def test_combine_outputs_in_range(self):
        strategy = EnsembleSearchStrategy()
        N = 5
        # Each signal in [0, 1] → combined also in [0, 1] after normalisation
        combined = strategy.combine_scores(
            np.ones(N), np.zeros(N), np.full(N, 0.5), np.random.rand(N)
        )
        assert combined.min() >= 0.0
        assert combined.max() <= 1.0

    def test_mismatched_lengths_raises(self):
        strategy = EnsembleSearchStrategy()
        with pytest.raises(ValueError, match="same length"):
            strategy.combine_scores(
                np.array([1.0, 2.0]),
                np.array([3.0]),
                np.array([4.0, 5.0]),
                np.array([6.0, 7.0]),
            )

    def test_higher_semantic_weight_boosts_semantic(self):
        """When semantic weight dominates, semantic rank order is preserved."""
        strategy = EnsembleSearchStrategy(
            weights={
                "semantic": 0.99,
                "keyword": 0.01,
                "recency": 0.0,
                "diversity": 0.0,
                "preference": 0.0,
            }
        )
        sem = np.array([0.9, 0.1, 0.5])
        kw = np.zeros(3)
        rec = np.zeros(3)
        pref = np.zeros(3)
        combined = strategy.combine_scores(sem, kw, rec, pref)
        # rank order should match semantic order
        assert np.argmax(combined) == np.argmax(sem)
        assert np.argmin(combined) == np.argmin(sem)

    def test_identical_signals_produce_constant_output(self):
        strategy = EnsembleSearchStrategy()
        arr = np.full(5, 0.42)
        combined = strategy.combine_scores(arr, arr, arr, arr)
        # all inputs equal → all outputs equal
        assert np.allclose(combined, combined[0])

"""Unit tests for DiversityAwareSearch."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from utils.search_strategies.diversity import DiversityAwareSearch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_result(vid: str, score: float, code: str) -> dict:
    """Create a minimal search-result dict for testing."""
    return {
        "id": vid,
        "score": score,
        "document": f"doc-{vid}",
        "metadata": {"code": code, "episode": vid.split("-")[-1]},
    }


# ---------------------------------------------------------------------------
# Empty / early-exit cases
# ---------------------------------------------------------------------------


class TestEmptyAndEarlyExit:
    def test_empty_results(self):
        strategy = DiversityAwareSearch(diversity_factor=0.5)
        assert strategy.apply_diversity([]) == []

    def test_factor_zero_returns_unchanged(self):
        strategy = DiversityAwareSearch(diversity_factor=0.0)
        results = [_make_result("a", 0.9, "juq"), _make_result("b", 0.8, "juq")]
        out = strategy.apply_diversity(results)
        assert out == results  # identity — no reordering

    def test_single_result(self):
        strategy = DiversityAwareSearch(diversity_factor=1.0)
        results = [_make_result("a", 0.9, "juq")]
        out = strategy.apply_diversity(results)
        assert out == results


# ---------------------------------------------------------------------------
# Code-limit enforcement
# ---------------------------------------------------------------------------


class TestCodeLimit:
    def test_enforces_max_per_code(self):
        strategy = DiversityAwareSearch(max_per_code=2)
        results = [
            _make_result("a-1", 0.9, "juq"),
            _make_result("a-2", 0.8, "juq"),
            _make_result("a-3", 0.7, "juq"),  # should be dropped
            _make_result("b-1", 0.6, "mxgs"),
        ]
        out = strategy.apply_diversity(results)
        codes = [r["metadata"]["code"] for r in out]
        # Only check counts, not order (diversity reorders)
        assert codes.count("juq") == 2
        assert codes.count("mxgs") == 1
        assert len(out) == 3

    def test_code_limit_across_multiple_codes(self):
        strategy = DiversityAwareSearch(max_per_code=1)
        results = [
            _make_result("a", 0.9, "juq"),
            _make_result("b", 0.8, "juq"),
            _make_result("c", 0.7, "mxgs"),
            _make_result("d", 0.6, "mxgs"),
            _make_result("e", 0.5, "fc2"),
        ]
        out = strategy.apply_diversity(results)
        codes = [r["metadata"]["code"] for r in out]
        # After code-limit + diversity, we expect 1 per code = 3 results
        assert len(out) == 3
        assert set(codes) == {"juq", "mxgs", "fc2"}
        assert codes.count("juq") == 1
        assert codes.count("mxgs") == 1
        assert codes.count("fc2") == 1


# ---------------------------------------------------------------------------
# Metadata diversity (no embeddings)
# ---------------------------------------------------------------------------


class TestMetadataDiversity:
    def test_interleaves_codes(self):
        strategy = DiversityAwareSearch(diversity_factor=1.0)
        results = [
            _make_result("a1", 0.95, "juq"),
            _make_result("a2", 0.85, "juq"),
            _make_result("b1", 0.90, "mxgs"),
            _make_result("b2", 0.80, "mxgs"),
            _make_result("c1", 0.70, "fc2"),
        ]
        out = strategy.apply_diversity(results)
        codes_order = [r["metadata"]["code"] for r in out]
        # interleaved: juq, mxgs, fc2, juq, mxgs
        assert codes_order == ["juq", "mxgs", "fc2", "juq", "mxgs"]

    def test_partial_diversity_preserves_some_original_order(self):
        """When factor < 1.0 the final order is a blend."""
        strategy = DiversityAwareSearch(diversity_factor=0.5)
        results = [
            _make_result("a1", 0.95, "juq"),
            _make_result("b1", 0.90, "mxgs"),
            _make_result("a2", 0.85, "juq"),
        ]
        out = strategy.apply_diversity(results)
        # a1 has highest score — it should appear early (first or second)
        ids = [r["id"] for r in out]
        assert "a1" in ids[:2], f"Expected a1 in first two positions, got {ids}"
        assert len(out) == 3


# ---------------------------------------------------------------------------
# MMR (embeddings provided)
# ---------------------------------------------------------------------------


class TestMMR:
    def test_mmr_selects_diverse_embeddings(self):
        strategy = DiversityAwareSearch(diversity_factor=1.0)
        # 2D embeddings: [juq_a, juq_b, mxgs]
        embeddings = np.array(
            [
                [1.0, 0.0],  # juq-a
                [0.9, 0.1],  # juq-b  (very similar to juq-a)
                [0.0, 1.0],  # mxgs   (orthogonal)
            ]
        )
        results = [
            _make_result("juq-a", 0.95, "juq"),
            _make_result("juq-b", 0.90, "juq"),
            _make_result("mxgs", 0.85, "mxgs"),
        ]
        out = strategy.apply_diversity(results, embeddings=embeddings)
        # With diversity_factor=1.0 the first two should be dissimilar
        assert out[0]["id"] == "juq-a"  # highest score starts
        assert out[1]["id"] == "mxgs"  # most dissimilar to juq-a
        assert out[2]["id"] == "juq-b"

    def test_mmr_with_low_diversity_behaves_like_relevance(self):
        strategy = DiversityAwareSearch(diversity_factor=0.01)
        embeddings = np.array(
            [
                [1.0, 0.0],
                [0.9, 0.1],
                [0.0, 1.0],
            ]
        )
        results = [
            _make_result("a", 0.95, "juq"),
            _make_result("b", 0.90, "juq"),
            _make_result("c", 0.85, "mxgs"),
        ]
        out = strategy.apply_diversity(results, embeddings=embeddings)
        # nearly pure relevance → original score order
        assert [r["id"] for r in out] == ["a", "b", "c"]

    def test_mmr_with_single_result(self):
        strategy = DiversityAwareSearch(diversity_factor=1.0)
        embeddings = np.array([[1.0, 0.0]])
        results = [_make_result("a", 0.9, "juq")]
        out = strategy.apply_diversity(results, embeddings=embeddings)
        assert out == results

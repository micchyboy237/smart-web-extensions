"""Unit tests for QueryUnderstanding."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from utils.search_strategies.query_understanding import QueryUnderstanding


class TestIntentDetection:
    def test_default_intent_is_search(self):
        result = QueryUnderstanding.parse("hello world")
        assert result["intent"] == "search"

    def test_popular_intent(self):
        for word in ("popular", "trending", "top"):
            result = QueryUnderstanding.parse(f"{word} videos")
            assert result["intent"] == "popular", f"failed for {word!r}"

    def test_recent_intent(self):
        for word in ("new", "latest", "recent"):
            result = QueryUnderstanding.parse(f"{word} releases")
            assert result["intent"] == "recent", f"failed for {word!r}"

    def test_similar_intent(self):
        for phrase in ("similar to", "like", "related"):
            result = QueryUnderstanding.parse(f"{phrase} juq-373")
            assert result["intent"] == "similar", f"failed for {phrase!r}"


class TestCodeExtraction:
    def test_extracts_lowercase_codes(self):
        result = QueryUnderstanding.parse("juq mxgs videos")
        assert set(result["extracted_codes"]) == {"juq", "mxgs"}

    def test_ignores_stop_words(self):
        result = QueryUnderstanding.parse("the new and for not but")
        assert "the" not in result["extracted_codes"]
        assert "and" not in result["extracted_codes"]
        assert "new" not in result["extracted_codes"]

    def test_code_length_bounds(self):
        """Only 2–5 char alpha tokens are treated as codes."""
        result = QueryUnderstanding.parse("a bb ccc dddd eeeee ffffff")
        # a (len 1) and ffffff (len 6) excluded by pattern
        codes = result["extracted_codes"]
        assert "a" not in codes
        assert "ffffff" not in codes
        # others are 2-5 chars → extracted
        assert all(2 <= len(c) <= 5 for c in codes)


class TestExclusionCodes:
    def test_exclusion_with_not(self):
        result = QueryUnderstanding.parse("juq videos not mxgs fc2")
        assert set(result["exclude_codes"]) == {"mxgs", "fc2"}

    def test_exclusion_with_except(self):
        result = QueryUnderstanding.parse("juq videos except fc2")
        assert set(result["exclude_codes"]) == {"fc2"}

    def test_exclusion_ignores_stop_words(self):
        result = QueryUnderstanding.parse("videos not the and new")
        # "the", "and", "new" are stop-words → excluded from exclude list
        assert result["exclude_codes"] == []


class TestEpisodeExtraction:
    def test_extracts_episode_numbers(self):
        result = QueryUnderstanding.parse("juq 373 400")
        assert result["extracted_episodes"] == [373, 400]

    def test_ignores_short_numbers(self):
        """EPISODE_PATTERN requires 3-4 digits."""
        result = QueryUnderstanding.parse("ep 12 99 100 9999")
        assert result["extracted_episodes"] == [100, 9999]

    def test_episode_range_hyphen(self):
        result = QueryUnderstanding.parse("300-400")
        assert result["episode_range"] == (300, 400)

    def test_episode_range_en_dash(self):
        result = QueryUnderstanding.parse("300–400")  # en-dash
        assert result["episode_range"] == (300, 400)

    def test_episode_range_with_spaces(self):
        result = QueryUnderstanding.parse("from 300 - 500")
        assert result["episode_range"] == (300, 500)


class TestDiversityHint:
    def test_high_diversity_words(self):
        for word in ("diverse", "variety", "different", "mix"):
            result = QueryUnderstanding.parse(f"something {word}")
            assert result["diversity_hint"] == "high", f"failed for {word!r}"

    def test_low_diversity_words(self):
        for word in ("focused", "specific", "exact"):
            result = QueryUnderstanding.parse(f"{word} search")
            assert result["diversity_hint"] == "low", f"failed for {word!r}"

    def test_no_hint_by_default(self):
        result = QueryUnderstanding.parse("regular search")
        assert result["diversity_hint"] is None


class TestEndToEndExamples:
    """Smoke tests matching the docstring examples."""

    def test_popular_juq_with_episode_range(self):
        result = QueryUnderstanding.parse("popular juq videos from episode 300-400")
        assert result["intent"] == "popular"
        assert "juq" in result["extracted_codes"]
        assert result["episode_range"] == (300, 400)

    def test_new_mxgs_not_juq(self):
        result = QueryUnderstanding.parse("new mxgs content not juq")
        assert result["intent"] == "recent"
        assert "mxgs" in result["extracted_codes"]
        assert "juq" in result["exclude_codes"]

    def test_similar_but_different(self):
        result = QueryUnderstanding.parse("something like juq-373 but different")
        assert result["intent"] == "similar"
        assert result["diversity_hint"] == "high"

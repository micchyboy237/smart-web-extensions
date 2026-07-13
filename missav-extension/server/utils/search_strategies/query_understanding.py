"""Natural-language query understanding for video search."""

import logging
import re
from typing import ClassVar

from nltk.corpus import stopwords

logger = logging.getLogger(__name__)

# Download NLTK stopwords
# nltk.download('stopwords', quiet=True)


class QueryUnderstanding:
    """
    Parse user queries to extract structured intent and filters.

    Examples:
        "popular juq videos from episode 300-400"
            → intent=popular, codes=[juq], episode_range=[300,400]

        "new mxgs content not juq"
            → intent=recent, codes=[mxgs], exclude_codes=[juq]

        "something like juq-373 but different"
            → intent=similar, diversity_hint=high
    """

    # Compiled regex patterns (shared across instances)
    CODE_PATTERN: ClassVar[re.Pattern] = re.compile(
        r"\b([a-z]{2,5}[a-z0-9]*)\b", re.IGNORECASE
    )
    EPISODE_PATTERN: ClassVar[re.Pattern] = re.compile(r"\b(\d{3,4})\b")
    RANGE_PATTERN: ClassVar[re.Pattern] = re.compile(r"(\d+)\s*[-–]\s*(\d+)")

    # Words excluded from code extraction (use NLTK's English stopwords)
    STOP_WORDS: ClassVar[frozenset[str]] = frozenset(stopwords.words("english"))

    # Intent keywords → intent label
    INTENT_MAP: ClassVar[list[tuple[frozenset[str], str]]] = [
        (frozenset({"popular", "trending", "top"}), "popular"),
        (frozenset({"new", "latest", "recent"}), "recent"),
        (frozenset({"similar to", "like", "related"}), "similar"),
    ]

    # Diversity hint keywords
    HIGH_DIVERSITY_WORDS: ClassVar[frozenset[str]] = frozenset(
        {
            "diverse",
            "variety",
            "different",
            "mix",
        }
    )
    LOW_DIVERSITY_WORDS: ClassVar[frozenset[str]] = frozenset(
        {
            "focused",
            "specific",
            "exact",
        }
    )

    @classmethod
    def parse(cls, query: str) -> dict:
        """
        Extract structured understanding from a natural-language query.

        Returns a dict with keys:
            intent           — "search", "popular", "recent", or "similar"
            extracted_codes  — list of detected series codes (lowercase)
            extracted_episodes — list of episode numbers (int)
            episode_range    — [min, max] tuple or None
            exclude_codes    — codes to exclude
            diversity_hint   — "high", "low", or None
        """
        understanding: dict = {
            "intent": "search",
            "extracted_codes": [],
            "extracted_episodes": [],
            "episode_range": None,
            "exclude_codes": [],
            "diversity_hint": None,
        }

        query_lower = query.lower()

        # ---- intent detection -------------------------------------------
        for keywords, intent_label in cls.INTENT_MAP:
            if any(kw in query_lower for kw in keywords):
                understanding["intent"] = intent_label
                break

        # ---- diversity hint ---------------------------------------------
        if any(w in query_lower for w in cls.HIGH_DIVERSITY_WORDS):
            understanding["diversity_hint"] = "high"
        elif any(w in query_lower for w in cls.LOW_DIVERSITY_WORDS):
            understanding["diversity_hint"] = "low"

        # ---- code extraction (with stop-word removal) -------------------
        codes = cls.CODE_PATTERN.findall(query_lower)
        understanding["extracted_codes"] = [c for c in codes if c not in cls.STOP_WORDS]

        # ---- exclusion codes --------------------------------------------
        if "not " in query_lower or "except" in query_lower:
            separator = "not " if "not " in query_lower else "except"
            tail = query_lower.split(separator)[-1]
            exclude_matches = cls.CODE_PATTERN.findall(tail)
            understanding["exclude_codes"] = [
                c for c in exclude_matches if c not in cls.STOP_WORDS
            ]

        # ---- episode numbers --------------------------------------------
        episodes = cls.EPISODE_PATTERN.findall(query)
        if episodes:
            understanding["extracted_episodes"] = [int(e) for e in episodes]

        # ---- episode range ----------------------------------------------
        range_match = cls.RANGE_PATTERN.search(query)
        if range_match:
            understanding["episode_range"] = (
                int(range_match.group(1)),
                int(range_match.group(2)),
            )

        logger.debug("QueryUnderstanding: parsed %r → %s", query, understanding)
        return understanding

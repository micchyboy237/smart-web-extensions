"""Search strategies package - re-exports for backward compatibility."""

try:
    from utils.search_strategies.diversity import DiversityAwareSearch
    from utils.search_strategies.ensemble import EnsembleSearchStrategy
    from utils.search_strategies.query_understanding import QueryUnderstanding
except ImportError:
    from diversity import DiversityAwareSearch
    from ensemble import EnsembleSearchStrategy
    from query_understanding import QueryUnderstanding

__all__ = [
    "DiversityAwareSearch",
    "EnsembleSearchStrategy",
    "QueryUnderstanding",
]

"""Search strategies package - re-exports for backward compatibility."""

try:
    from utils.search_strategies.diversity import diversity_search
    from utils.search_strategies.query_understanding import QueryUnderstanding
except ImportError:
    from diversity import diversity_search
    from query_understanding import QueryUnderstanding

__all__ = [
    "diversity_search",
    "QueryUnderstanding",
]

# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/routes/preferences.py
"""User preferences endpoints for personalized search."""

import logging

from fastapi import APIRouter
from models.video import UserPreference

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/preferences", tags=["preferences"])


@router.post("")
async def update_preferences(prefs: UserPreference):
    """
    Update user preferences for personalized search.

    Preferences are used to:
    - Boost favorite codes in search results
    - Block unwanted codes
    - Exclude already watched videos
    - Set diversity preferences
    """
    logger.info(f"📝 Updating preferences for user: {prefs.user_id}")
    logger.debug(f"   Favorites: {prefs.favorite_codes}")
    logger.debug(f"   Blocked: {prefs.blocked_codes}")
    logger.debug(f"   Watched: {len(prefs.watched_ids)} videos")
    logger.debug(f"   Episode range: {prefs.preferred_episode_range}")
    logger.debug(f"   Diversity: {prefs.diversity_preference}")

    # TODO: Store in SQLite or JSON file for persistence
    # For now, acknowledge receipt

    return {
        "success": True,
        "user_id": prefs.user_id,
        "preferences": prefs.model_dump(),
    }


@router.get("/{user_id}")
async def get_preferences(user_id: str = "default"):
    """
    Get user preferences by ID.

    Returns stored preferences or sensible defaults for new users.
    """
    logger.info(f"📋 Getting preferences for user: {user_id}")

    # TODO: Retrieve from storage (SQLite/JSON)
    # For now, return default preferences

    default_prefs = UserPreference(user_id=user_id)
    return default_prefs.model_dump()

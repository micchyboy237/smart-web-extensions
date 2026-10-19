// Tracker module - handles favorites and watch status logic
console.log("[AWS] Tracker module loaded");
if (!window.AWSTracker) {
  window.AWSTracker = {};
}

Object.assign(window.AWSTracker, {
  /**
   * Normalize title for consistent matching
   */
  normalizeTitle(title) {
    return title ? title.trim().toLowerCase() : "";
  },

  /**
   * Toggle favorite status for an anime by Title
   */
  async toggleFavorite(title, isFavorite) {
    const normalizedTitle = this.normalizeTitle(title);
    if (!normalizedTitle) return;

    console.log(`[AWS] Toggling favorite for "${title}": ${isFavorite}`);
    const data = await window.AWSStorage.getData();
    let favorites = data.favorites || [];

    if (isFavorite) {
      if (!favorites.includes(normalizedTitle)) {
        favorites.push(normalizedTitle);
      }
    } else {
      favorites = favorites.filter((t) => t !== normalizedTitle);
      // Also clear watch status if removed from favorites
      await this.clearWatchStatus(normalizedTitle);
    }

    await chrome.runtime.sendMessage({
      type: "UPDATE_FAVORITES",
      favorites: favorites,
    });

    return favorites;
  },

  /**
   * Update watch status for a specific episode of an anime
   */
  async updateWatchStatus(title, episodeNumber, isWatched) {
    const normalizedTitle = this.normalizeTitle(title);
    if (!normalizedTitle) return;

    console.log(
      `[AWS] Updating watch status for "${title}" Ep ${episodeNumber}: ${isWatched}`,
    );

    const data = await window.AWSStorage.getData();
    let watchHistory = data.watchHistory || {};

    if (!watchHistory[normalizedTitle]) {
      watchHistory[normalizedTitle] = {};
    }

    if (isWatched) {
      watchHistory[normalizedTitle][episodeNumber] = new Date().toISOString();
    } else {
      delete watchHistory[normalizedTitle][episodeNumber];
    }

    await chrome.runtime.sendMessage({
      type: "UPDATE_WATCH_HISTORY",
      watchHistory: watchHistory,
    });

    return watchHistory;
  },

  /**
   * Clear watch history for an anime
   */
  async clearWatchStatus(normalizedTitle) {
    const data = await window.AWSStorage.getData();
    let watchHistory = data.watchHistory || {};
    delete watchHistory[normalizedTitle];

    await chrome.runtime.sendMessage({
      type: "UPDATE_WATCH_HISTORY",
      watchHistory: watchHistory,
    });
  },

  /**
   * Get progress for a specific anime title
   */
  getProgress(normalizedTitle, allItems, watchHistory) {
    // Find all items matching this title
    const animeItems = allItems.filter(
      (item) => this.normalizeTitle(item.title) === normalizedTitle,
    );

    if (animeItems.length === 0) return { total: 0, watched: 0, nextEp: null };

    const history = watchHistory[normalizedTitle] || {};
    const watchedCount = Object.keys(history).length;

    // Get unique episode numbers to avoid counting duplicates if same ep appears twice
    const uniqueEpisodes = [
      ...new Set(animeItems.map((item) => item.episodeNumber)),
    ].filter((n) => n > 0);
    const totalCount = uniqueEpisodes.length;

    // Calculate watched unique episodes
    const watchedUniqueCount = uniqueEpisodes.filter(
      (ep) => history[ep],
    ).length;

    // Find next unwatched episode number
    const sortedUniqueEps = uniqueEpisodes.sort((a, b) => a - b);
    const nextEpNum = sortedUniqueEps.find((ep) => !history[ep]);

    // Find the display string for the next episode
    let nextEpDisplay = null;
    if (nextEpNum) {
      const epItem = animeItems.find((i) => i.episodeNumber === nextEpNum);
      nextEpDisplay = epItem ? epItem.episode : `Ep ${nextEpNum}`;
    }

    return {
      total: totalCount,
      watched: watchedUniqueCount,
      nextEp: nextEpDisplay,
    };
  },
});

console.log("[AWS] Tracker module initialized on window");

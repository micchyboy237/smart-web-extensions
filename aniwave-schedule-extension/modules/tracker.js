// Tracker module - handles favorites and watch status logic
console.log("[AWS] Tracker module loaded");
if (!window.AWSTracker) {
  window.AWSTracker = {};
}

Object.assign(window.AWSTracker, {
  /**
   * Toggle favorite status for an anime
   */
  async toggleFavorite(href, isFavorite) {
    console.log(`[AWS] Toggling favorite for ${href}: ${isFavorite}`);
    const data = await window.AWSStorage.getData();
    let favorites = data.favorites || [];

    if (isFavorite) {
      if (!favorites.includes(href)) {
        favorites.push(href);
      }
    } else {
      favorites = favorites.filter((h) => h !== href);
      // Also clear watch status if removed from favorites
      await this.clearWatchStatus(href);
    }

    await chrome.runtime.sendMessage({
      type: "UPDATE_FAVORITES",
      favorites: favorites,
    });

    return favorites;
  },

  /**
   * Update watch status for a specific episode
   */
  async updateWatchStatus(href, episodeNumber, isWatched) {
    console.log(
      `[AWS] Updating watch status for ${href} Ep ${episodeNumber}: ${isWatched}`,
    );

    const data = await window.AWSStorage.getData();
    let watchHistory = data.watchHistory || {};

    if (!watchHistory[href]) {
      watchHistory[href] = {};
    }

    if (isWatched) {
      watchHistory[href][episodeNumber] = new Date().toISOString();
    } else {
      delete watchHistory[href][episodeNumber];
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
  async clearWatchStatus(href) {
    const data = await window.AWSStorage.getData();
    let watchHistory = data.watchHistory || {};
    delete watchHistory[href];

    await chrome.runtime.sendMessage({
      type: "UPDATE_WATCH_HISTORY",
      watchHistory: watchHistory,
    });
  },

  /**
   * Get progress for a specific anime
   */
  getProgress(href, allItems, watchHistory) {
    const animeItems = allItems.filter((item) => item.href === href);
    if (animeItems.length === 0) return { total: 0, watched: 0, nextEp: null };

    const history = watchHistory[href] || {};
    const watchedCount = Object.keys(history).length;
    const totalCount = animeItems.length;

    // Find next unwatched episode
    const sortedItems = [...animeItems].sort(
      (a, b) => a.episodeNumber - b.episodeNumber,
    );
    const nextEp = sortedItems.find((item) => !history[item.episodeNumber]);

    return {
      total: totalCount,
      watched: watchedCount,
      nextEp: nextEp ? nextEp.episode : null,
    };
  },
});

console.log("[AWS] Tracker module initialized on window");

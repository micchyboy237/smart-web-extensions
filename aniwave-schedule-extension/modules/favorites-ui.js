// Favorites UI module - handles rendering the favorites dashboard
console.log("[AWS] Favorites UI module loaded");
if (!window.AWSFavoritesUI) {
  window.AWSFavoritesUI = {};
}

Object.assign(window.AWSFavoritesUI, {
  /**
   * Render the favorites dashboard
   */
  renderFavoritesDashboard(items, favorites, watchHistory) {
    const container = document.getElementById("aws-favorites-list");
    const countEl = document.getElementById("aws-favorites-count");

    if (!container || !countEl) return;

    // Group items by normalized title
    const grouped = {};
    items.forEach((item) => {
      const normTitle = window.AWSTracker.normalizeTitle(item.title);
      if (!normTitle) return;

      if (!grouped[normTitle]) {
        grouped[normTitle] = {
          title: item.title, // Keep original casing for display
          normalizedTitle: normTitle,
          episodes: [],
          latestDate: item.date,
        };
      }

      // Avoid duplicate episodes in the group
      const exists = grouped[normTitle].episodes.some(
        (e) => e.episodeNumber === item.episodeNumber && e.date === item.date,
      );
      if (!exists) {
        grouped[normTitle].episodes.push(item);
      }

      if (item.date > grouped[normTitle].latestDate) {
        grouped[normTitle].latestDate = item.date;
      }
    });

    // Filter to only show favorites
    const favoriteKeys = Object.keys(grouped).filter((key) =>
      favorites.includes(key),
    );
    const animeList = favoriteKeys.map((key) => grouped[key]);

    // Sort by latest date
    animeList.sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate));

    countEl.textContent = animeList.length;

    if (animeList.length === 0) {
      container.innerHTML =
        '<p class="aws-empty">No favorites added yet. Click ⭐ on an item to add it.</p>';
      return;
    }

    container.innerHTML = animeList
      .map((anime) => {
        const progress = window.AWSTracker.getProgress(
          anime.normalizedTitle,
          items,
          watchHistory,
        );
        const percent =
          progress.total > 0
            ? Math.round((progress.watched / progress.total) * 100)
            : 0;

        return `
        <div class="aws-favorite-item">
          <div class="aws-favorite-header">
            <div class="aws-favorite-title">${this.escapeHtml(anime.title)}</div>
            <button class="aws-remove-fav-btn" data-title="${anime.normalizedTitle}" title="Remove from favorites">❌</button>
          </div>
          <div class="aws-progress-bar">
            <div class="aws-progress-fill" style="width: ${percent}%"></div>
          </div>
          <div class="aws-favorite-meta">
            <span>${progress.watched}/${progress.total} Episodes</span>
            ${progress.nextEp ? `<span class="aws-next-ep">Next: ${progress.nextEp}</span>` : '<span class="aws-completed">✅ Completed</span>'}
          </div>
        </div>
      `;
      })
      .join("");

    // Add event listeners for remove buttons
    container.querySelectorAll(".aws-remove-fav-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const normTitle = e.target.dataset.title;
        // Find original title for logging
        const originalTitle =
          items.find(
            (i) => window.AWSTracker.normalizeTitle(i.title) === normTitle,
          )?.title || normTitle;

        await window.AWSTracker.toggleFavorite(originalTitle, false);
        window.AWSPanel.loadAndDisplayData();
      });
    });
  },

  /**
   * Escape HTML helper
   */
  escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },
});

console.log("[AWS] Favorites UI module initialized on window");

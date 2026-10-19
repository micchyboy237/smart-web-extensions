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

    // Filter items that are favorites
    const favoriteItems = items.filter((item) => favorites.includes(item.href));

    // Group by title
    const grouped = {};
    favoriteItems.forEach((item) => {
      if (!grouped[item.title]) {
        grouped[item.title] = {
          title: item.title,
          href: item.href,
          episodes: [],
          latestDate: item.date,
        };
      }
      grouped[item.title].episodes.push(item);
      if (item.date > grouped[item.title].latestDate) {
        grouped[item.title].latestDate = item.date;
      }
    });

    const animeList = Object.values(grouped);
    countEl.textContent = animeList.length;

    if (animeList.length === 0) {
      container.innerHTML =
        '<p class="aws-empty">No favorites added yet. Click ⭐ on an item to add it.</p>';
      return;
    }

    container.innerHTML = animeList
      .map((anime) => {
        const progress = window.AWSTracker.getProgress(
          anime.href,
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
            <button class="aws-remove-fav-btn" data-href="${anime.href}" title="Remove from favorites">❌</button>
          </div>
          <div class="aws-progress-bar">
            <div class="aws-progress-fill" style="width: ${percent}%"></div>
          </div>
          <div class="aws-favorite-meta">
            <span>${progress.watched}/${progress.total} Episodes</span>
            ${progress.nextEp ? `<span class="aws-next-ep">Next: Ep ${progress.nextEp}</span>` : '<span class="aws-completed">✅ Completed</span>'}
          </div>
        </div>
      `;
      })
      .join("");

    // Add event listeners for remove buttons
    container.querySelectorAll(".aws-remove-fav-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const href = e.target.dataset.href;
        await window.AWSTracker.toggleFavorite(href, false);
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

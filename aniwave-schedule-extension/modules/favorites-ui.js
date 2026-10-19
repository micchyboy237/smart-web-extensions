// Favorites UI module - handles rendering the favorites dashboard
console.log("[AWS] Favorites UI module loaded");
if (!window.AWSFavoritesUI) {
  window.AWSFavoritesUI = {};
}

Object.assign(window.AWSFavoritesUI, {
  /**
   * Render the favorites timeline dashboard
   */
  renderFavoritesDashboard(items, favorites, watchHistory) {
    const container = document.getElementById("aws-favorites-list");
    const countEl = document.getElementById("aws-favorites-count");

    if (!container || !countEl) return;

    // 1. Filter items that are favorites
    const favoriteItems = items.filter((item) => {
      const normTitle = window.AWSTracker.normalizeTitle(item.title);
      return favorites.includes(normTitle);
    });

    // 2. Sort by Date (Newest first) then Time
    favoriteItems.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.time.localeCompare(a.time);
    });

    // 3. Group by Date
    const groupedByDate = {};
    favoriteItems.forEach((item) => {
      if (!groupedByDate[item.date]) {
        groupedByDate[item.date] = [];
      }
      groupedByDate[item.date].push(item);
    });

    const dates = Object.keys(groupedByDate).sort().reverse(); // Newest dates first
    countEl.textContent = favoriteItems.length;

    if (favoriteItems.length === 0) {
      container.innerHTML =
        '<p class="aws-empty">No favorites added yet. Click ⭐ on an item to add it.</p>';
      return;
    }

    // 4. Generate Timeline HTML
    let html = "";

    dates.forEach((date) => {
      const dayItems = groupedByDate[date];
      const dateObj = new Date(date);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let dateLabel = dateObj.toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      if (date === today.toISOString().split("T")[0]) dateLabel = "Today";
      else if (date === yesterday.toISOString().split("T")[0])
        dateLabel = "Yesterday";

      html += `<div class="aws-timeline-date-header">${dateLabel}</div>`;

      dayItems.forEach((item) => {
        const normTitle = window.AWSTracker.normalizeTitle(item.title);
        const history = watchHistory[normTitle] || {};
        const isWatched = !!history[item.episodeNumber];

        // Calculate series progress for context
        const allSeriesItems = items.filter(
          (i) => window.AWSTracker.normalizeTitle(i.title) === normTitle,
        );
        const uniqueEps = [
          ...new Set(allSeriesItems.map((i) => i.episodeNumber)),
        ]
          .filter((n) => n > 0)
          .sort((a, b) => a - b);
        const currentEpIndex = uniqueEps.indexOf(item.episodeNumber);
        const progressText =
          uniqueEps.length > 0
            ? `${currentEpIndex + 1}/${uniqueEps.length}`
            : "";

        html += `
          <div class="aws-timeline-card ${isWatched ? "aws-watched" : ""}" data-href="${item.href}">
            <div class="aws-card-left">
              <input type="checkbox" 
                     class="aws-watch-checkbox" 
                     ${isWatched ? "checked" : ""} 
                     data-title="${normTitle}" 
                     data-ep="${item.episodeNumber}" 
                     title="Mark as watched" />
            </div>
            <div class="aws-card-content" onclick="window.open('${item.href}', '_blank')">
              <div class="aws-card-header">
                <span class="aws-card-time">${item.time}</span>
                <span class="aws-card-episode">${item.episode}</span>
                ${progressText ? `<span class="aws-card-progress">(${progressText})</span>` : ""}
              </div>
              <div class="aws-card-title">${this.escapeHtml(item.title)}</div>
              ${item.japaneseTitle ? `<div class="aws-card-jp">${this.escapeHtml(item.japaneseTitle)}</div>` : ""}
            </div>
            <div class="aws-card-actions">
              <button class="aws-fav-btn aws-star-active" data-title="${normTitle}" title="Remove from favorites">⭐</button>
            </div>
          </div>
        `;
      });
    });

    container.innerHTML = html;

    // 5. Attach Event Listeners

    // Watch Checkboxes
    container.querySelectorAll(".aws-watch-checkbox").forEach((checkbox) => {
      checkbox.addEventListener("change", async (e) => {
        e.stopPropagation(); // Prevent card click
        const normTitle = e.target.dataset.title;
        const epNum = parseInt(e.target.dataset.ep);
        const isWatched = e.target.checked;

        // Find original title for logging
        const card = e.target.closest(".aws-timeline-card");
        const titleEl = card.querySelector(".aws-card-title");
        const originalTitle = titleEl ? titleEl.textContent : normTitle;

        await window.AWSTracker.updateWatchStatus(
          originalTitle,
          epNum,
          isWatched,
        );
        window.AWSPanel.loadAndDisplayData();
      });
    });

    // Remove Favorite Buttons
    container.querySelectorAll(".aws-fav-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // Prevent card click
        const normTitle = e.target.dataset.title;
        const card = e.target.closest(".aws-timeline-card");
        const titleEl = card.querySelector(".aws-card-title");
        const originalTitle = titleEl ? titleEl.textContent : normTitle;

        await window.AWSTracker.toggleFavorite(originalTitle, false);
        window.AWSPanel.loadAndDisplayData();
      });
    });
  },

  escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },
});

console.log("[AWS] Favorites UI module initialized on window");

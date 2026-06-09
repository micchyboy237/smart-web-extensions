// card-manager.js - Video Card Creation and Management
// Handles DOM card creation, updates, and cleanup for the floating panel
(function () {
  "use strict";
  console.log("[CardManager] Module loading...");

  let cardVisibilityObserver = null;

  /**
   * Create a video card DOM element for the floating panel
   */
  function createVideoCard(entry) {
    window.__log(`Creating stable card DOM for ${entry.id}`);

    const card = document.createElement("div");
    card.className = "video-card";
    card.dataset.videoId = entry.id;

    card.innerHTML = `
      <div class="preview-container">
        <div class="thumb-placeholder"></div>
      </div>
      <button class="gallery-btn" title="Open preview gallery">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zm-9 9h7v7H4v-7zm9 0h7v7h-7v-7z" 
                fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
      <div class="video-info-row">
        <div class="video-id-meta">
          <span class="video-id">${entry.id}</span>
          <span class="video-meta">${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s</span>
        </div>
        <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
          ${entry.info.paused ? "⏸ Paused" : "▶ Playing"}
        </span>
      </div>
    `;

    // Card click handler
    card.addEventListener("click", (e) => {
      if (e.target.closest(".gallery-btn")) return;
      e.stopImmediatePropagation();

      const videoEl = entry.element;
      if (!videoEl) return;

      if (videoEl.dataset.clickInProgress === "true") return;
      videoEl.dataset.clickInProgress = "true";
      setTimeout(() => {
        delete videoEl.dataset.clickInProgress;
      }, 300);

      if (videoEl.paused) {
        window.__enforceSinglePlayback(videoEl);
        window.__showVideoOverlay(videoEl, entry);
        videoEl.play().catch((err) => {
          console.warn("[Overlay] Play failed on card click:", err);
        });
      } else {
        if (window.__isOverlayShowingVideo(videoEl)) {
          window.__closeVideoOverlay();
        } else {
          window.__showVideoOverlay(videoEl, entry);
        }
      }

      videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // Gallery button handler
    const galleryBtn = card.querySelector(".gallery-btn");
    if (galleryBtn) {
      galleryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.__openGallery(entry);
      });
    }

    // Observe card for scroll visibility
    if (cardVisibilityObserver) {
      cardVisibilityObserver.observe(card);
    }

    console.log(`[CardManager] Created card for ${entry.id}`);
    return card;
  }

  /**
   * Update an existing card with new video information.
   * SAFELY replaces placeholder without destroying preview elements.
   */
  function updateExistingCard(card, entry) {
    const statusEl = card.querySelector(".video-status");
    if (statusEl) {
      statusEl.className = `video-status ${entry.info.paused ? "paused" : "playing"}`;
      statusEl.textContent = entry.info.paused ? "⏸ Paused" : "▶ Playing";
    }
    const timeEl = card.querySelector(".video-meta");
    if (timeEl) {
      timeEl.textContent = `${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s`;
    }
    // Replace placeholder with real preview - SAFELY (don't destroy existing previews)
    const placeholder = card.querySelector(".thumb-placeholder");
    if (placeholder && entry.preview) {
      window.__log(`Replacing placeholder with real preview for ${entry.id}`);
      const container = card.querySelector(".preview-container");
      if (container) {
        // Remove the placeholder div (NOT innerHTML = "" which destroys all children)
        placeholder.remove();
        // Only append preview if it's not already in this container
        if (entry.preview.parentElement !== container) {
          container.appendChild(entry.preview);
          console.log(
            `[CardManager] 🖼️ Attached preview to card for ${entry.id}`,
          );

          // ✅ NEW: Add loading class to card until preview metadata loads
          if (entry.preview.dataset.previewReady !== "true") {
            card.classList.add("preview-loading");
            console.log(
              `[CardManager] ⏳ Preview loading for ${entry.id}, added loading state`,
            );

            // Listen for preview ready
            const checkReady = () => {
              if (
                entry.preview.dataset.previewReady === "true" ||
                entry.preview.readyState >= 1
              ) {
                card.classList.remove("preview-loading");
                console.log(
                  `[CardManager] ✅ Preview ready for ${entry.id}, removed loading state`,
                );
                entry.preview.removeEventListener("loadedmetadata", checkReady);
              }
            };

            if (entry.preview.dataset.previewReady === "true") {
              card.classList.remove("preview-loading");
            } else {
              entry.preview.addEventListener("loadedmetadata", checkReady, {
                once: true,
              });
              // Fallback: remove loading state after 10 seconds
              setTimeout(() => {
                card.classList.remove("preview-loading");
              }, 10000);
            }
          }
        } else {
          console.log(
            `[CardManager] 🖼️ Preview already in card for ${entry.id}`,
          );
        }
      }
    }
  }

  /**
   * Clean up a video entry and free resources
   */
  function cleanupVideoEntry(entry) {
    if (!entry) return;
    window.__log(`Cleaning up video entry for RAM optimization: ${entry.id}`);

    // Clean up boost
    if (entry.boostCleanup) {
      entry.boostCleanup();
      entry.boostCleanup = null;
    }

    delete entry.cacheKeySrc;

    // Clean up preview
    if (entry.preview) {
      window.BufferManager.unregister(entry.preview);

      if (window.BoostEngine) {
        window.BoostEngine.cleanupPreviewBoost(entry.preview);
      }

      if (typeof entry.preview._stopPreviewLoop === "function") {
        entry.preview._stopPreviewLoop();
        delete entry.preview._stopPreviewLoop;
      }

      entry.preview.pause();

      const currentlyPlaying = window.__getCurrentlyPlaying();
      if (currentlyPlaying === entry.preview) {
        window.__setCurrentlyPlaying(null);
      }

      // Remove from DOM if attached
      if (entry.preview.parentElement) {
        entry.preview.remove();
      }

      entry.preview.src = "";
      entry.preview.load();
      entry.preview = null;
    }

    // Clean up event listeners
    if (entry.cleanups && entry.cleanups.length > 0) {
      entry.cleanups.forEach((cleanupFn) => cleanupFn());
      entry.cleanups = null;
    }

    const currentlyPlaying = window.__getCurrentlyPlaying();
    if (entry.element && entry.element === currentlyPlaying) {
      window.__setCurrentlyPlaying(null);
    }

    // Stop observing the card
    const card = window.__getVideoCards().get(entry.element);
    if (card && cardVisibilityObserver) {
      cardVisibilityObserver.unobserve(card);
    }

    console.log(`[CardManager] Cleaned up entry for ${entry.id}`);
  }

  /**
   * Perform a full panel update with current video entries
   */
  function performPanelUpdate() {
    const panel = document.getElementById("video-observer-panel");
    if (!panel) return;

    const videos = window.__getVideosMap();
    const videoCards = window.__getVideoCards();
    const list = panel.querySelector("#videos-list");
    const countEl = panel.querySelector("#video-count");
    const empty = panel.querySelector("#empty-videos");

    countEl.textContent = videos.size;

    if (videos.size === 0) {
      empty.style.display = "block";
      console.log("[CardManager] No videos to display");
      return;
    }

    empty.style.display = "none";

    // Create or update cards
    let newCardsCreated = 0;
    let cardsUpdated = 0;

    Array.from(videos.values()).forEach((entry) => {
      let card;
      if (!videoCards.has(entry.element)) {
        // New card needed
        card = createVideoCard(entry);
        videoCards.set(entry.element, card);
        list.appendChild(card);
        newCardsCreated++;
        console.log(`[CardManager] Added new card for ${entry.id}`);
      }
      // Always update existing cards (handles both new and existing)
      card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
      cardsUpdated++;
    });

    // Remove cards for detached videos
    for (let [videoEl, entry] of Array.from(videos.entries())) {
      if (!document.body.contains(videoEl)) {
        cleanupVideoEntry(entry);
        videos.delete(videoEl);
        const card = videoCards.get(videoEl);
        if (card) {
          card.remove();
          videoCards.delete(videoEl);
          console.log(
            `[CardManager] Removed card for detached video ${entry.id}`,
          );
        }
      }
    }

    console.log(
      `[CardManager] Panel updated: ${videos.size} videos, ${videoCards.size} cards ` +
        `(${newCardsCreated} new, ${cardsUpdated} updated)`,
    );
  }

  /**
   * Perform a targeted single-card update for one video.
   * Creates and inserts a card immediately without re-processing all existing cards.
   * Used when a new video is tracked — provides instant visual feedback.
   *
   * @param {string} videoId - The video ID (e.g., "video-5") to create/update a card for
   */
  function performSingleCardUpdate(videoId) {
    const panel = document.getElementById("video-observer-panel");
    if (!panel) {
      console.warn(
        `[CardManager] ⚠️ Panel not found for single card update: ${videoId}`,
      );
      return false;
    }

    const videos = window.__getVideosMap();
    const videoCards = window.__getVideoCards();
    const list = panel.querySelector("#videos-list");
    const countEl = panel.querySelector("#video-count");
    const empty = panel.querySelector("#empty-videos");

    // Find the entry for this videoId
    let targetEntry = null;
    let targetVideoEl = null;
    for (const [videoEl, entry] of videos.entries()) {
      if (entry.id === videoId) {
        targetEntry = entry;
        targetVideoEl = videoEl;
        break;
      }
    }

    if (!targetEntry) {
      console.warn(
        `[CardManager] ⚠️ No entry found for single card update: ${videoId}`,
      );
      return false;
    }

    // Hide empty state if we have videos
    if (videos.size > 0) {
      empty.style.display = "none";
    }

    // Update count
    countEl.textContent = videos.size;

    let card;
    let isNew = false;

    if (!videoCards.has(targetVideoEl)) {
      // Create new card
      card = createVideoCard(targetEntry);
      videoCards.set(targetVideoEl, card);
      list.appendChild(card);
      isNew = true;
      console.log(`[CardManager] 🆕 Created + inserted card for ${videoId}`);
    } else {
      // Update existing card
      card = videoCards.get(targetVideoEl);
      console.log(`[CardManager] 🔄 Updating existing card for ${videoId}`);
    }

    // Always run updateExistingCard to refresh status, time, and attach preview
    updateExistingCard(card, targetEntry);

    console.log(
      `[CardManager] 📋 Single card ${isNew ? "inserted" : "updated"} for ${videoId} ` +
        `(total: ${videos.size} videos, ${videoCards.size} cards)`,
    );

    return true;
  }

  /**
   * Initialize scroll-based card visibility tracking
   */
  function initCardVisibilityObserver() {
    if (cardVisibilityObserver) return;

    const rootEl =
      document.getElementById("videos-list") ||
      document.getElementById("videos-tab") ||
      document.getElementById("video-observer-panel");

    cardVisibilityObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const card = entry.target;
          const entryId = card.dataset.videoId;

          // Find corresponding video entry
          let targetEntry = null;
          const videos = window.__getVideosMap();
          for (const ent of videos.values()) {
            if (ent.id === entryId) {
              targetEntry = ent;
              break;
            }
          }

          if (!targetEntry || !targetEntry.preview) return;

          const preview = targetEntry.preview;
          const info = window.BufferManager.managedVideos.get(preview);
          if (!info) return;

          // Don't interfere with active hovering
          if (info.strategy === window.RAM_CONFIG.BUFFER_STRATEGY.ACTIVE)
            return;

          if (entry.isIntersecting) {
            if (
              info.strategy === window.RAM_CONFIG.BUFFER_STRATEGY.METADATA ||
              info.strategy === window.RAM_CONFIG.BUFFER_STRATEGY.NONE
            ) {
              // Only upgrade to INITIAL if metadata is ready
              if (preview.readyState >= 1 && preview.duration > 0) {
                console.log(
                  `[CardManager] 👁️ Card visible: ${entryId} → INITIAL`,
                );
                window.BufferManager.setStrategy(
                  preview,
                  window.RAM_CONFIG.BUFFER_STRATEGY.INITIAL,
                );
              }
              // If metadata not ready, stay at METADATA until it loads
            }
          } else {
            if (info.strategy === window.RAM_CONFIG.BUFFER_STRATEGY.INITIAL) {
              console.log(
                `[CardManager] 🙈 Card scrolled out of view: ${entryId} → METADATA`,
              );
              window.BufferManager.setStrategy(
                preview,
                window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
              );
            }
          }
        });
      },
      {
        root: rootEl,
        threshold: 0.1,
      },
    );

    console.log(
      `[CardManager] 📜 Scroll tracking observer initialized (root: ${rootEl?.id || "viewport"})`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════
  window.CardManager = {
    createVideoCard,
    updateExistingCard,
    cleanupVideoEntry,
    performPanelUpdate,
    performSingleCardUpdate, // ← NEW: targeted single-card update
    initCardVisibilityObserver,
    getObserver: () => cardVisibilityObserver,
  };

  console.log("[CardManager] Module loaded successfully ✅");
})();

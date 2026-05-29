/**
 * Player tracking module - discovers and manages shreddit-player elements
 */
import { AppState } from "../core/state.js";
import { DOM_CONFIG } from "../core/config.js";
import { DebugLogger as debug } from "../core/debug.js";
import {
  getVideoFromPlayer,
  getPlayerId,
  getVideoInfo,
} from "../engine/video-utils.js";
import { BoostEngine } from "../engine/boost-engine.js";
import { PlaybackController } from "../controllers/playback-controller.js";

let scanRetryCount = 0;
let scanRetryTimer = null;
let initialAutoSelectDone = false; // ✅ Track if we've auto-selected

/**
 * ✅ Auto-select the first available video
 * Sets volume, unmutes, and prepares for playback
 */
function autoSelectFirstVideo() {
  if (initialAutoSelectDone) return;

  const entries = AppState.getPlayerEntries();
  if (entries.length === 0) return;

  // Get the first player (top of feed)
  const [firstPlayer, firstEntry] = entries[0];
  const video = getVideoFromPlayer(firstPlayer);

  if (!video || video.readyState < 1) {
    debug.log("INFO", "First video not ready yet, waiting...");
    return; // Will retry on next scan
  }

  initialAutoSelectDone = true;

  debug.log("INFO", `Auto-selecting first video: ${firstEntry.id}`);

  // ✅ Set volume to 50% of max
  video.volume = 0.5;

  // ✅ Unmute if muted
  if (video.muted) {
    video.muted = false;
    debug.log("INFO", `Unmuted ${firstEntry.id}`);
  }

  // ✅ Verify settings
  debug.log("INFO", `Audio settings for ${firstEntry.id}:`, {
    volume: video.volume,
    muted: video.muted,
    readyState: video.readyState,
  });

  // Scroll the player into view
  firstPlayer.scrollIntoView({ behavior: "smooth", block: "center" });

  // Set as currently playing (triggers boost priority)
  AppState.setCurrentlyPlaying(video);

  // Don't autoplay - user should click to play
  // But the video is now "selected" and boost-prioritized
}

/**
 * Track a single shreddit-player element
 */
export function trackPlayer(player) {
  if (AppState.hasPlayer(player)) {
    return;
  }

  const video = getVideoFromPlayer(player);
  if (!video) {
    debug.log(
      "DOM",
      `No video in player ${getPlayerId(player)} yet (shadow DOM may not be ready)`,
    );
    return;
  }

  const id = AppState.getNextVideoId();
  video.dataset.videoObserverId = id;

  // ✅ Set initial audio: muted but volume at 50% ready
  video.muted = true;
  video.volume = 0.5;

  const entry = {
    id,
    player,
    info: getVideoInfo(video),
    boostCleanup: null,
    cleanups: [],
  };

  // Attach boost engine
  entry.boostCleanup = BoostEngine.attach(video);

  // Watch for video element changes in shadow DOM
  if (player.shadowRoot) {
    const shadowObserver = new MutationObserver(() => {
      const newVideo = getVideoFromPlayer(player);
      if (newVideo && newVideo.dataset.boostAttached !== "true") {
        entry.boostCleanup?.();
        newVideo.dataset.videoObserverId = id;
        newVideo.muted = true;
        newVideo.volume = 0.5;
        entry.boostCleanup = BoostEngine.attach(newVideo);
        entry.info = getVideoInfo(newVideo);
        debug.log("DOM", `Video element changed in ${id}, reattached boost`);
      }
    });
    shadowObserver.observe(player.shadowRoot, {
      childList: true,
      subtree: true,
    });
    entry.cleanups.push(() => shadowObserver.disconnect());
  }

  // ✅ Updated unmute handler with volume check
  const unmuteHandler = () => {
    const currentVideo = getVideoFromPlayer(player);
    if (currentVideo) {
      // Set volume to 50% if it's at 0 or 100
      if (currentVideo.volume === 0 || currentVideo.volume === 1) {
        currentVideo.volume = 0.5;
      }
      if (currentVideo.muted) {
        currentVideo.muted = false;
        debug.log("INFO", `Unmuted ${id} on interaction`);
      }
    }
  };
  player.addEventListener("click", unmuteHandler, { once: true });

  AppState.addPlayer(player, entry);

  debug.log("DOM", `Tracked: ${id} (player: ${getPlayerId(player)})`, {
    src: (video.currentSrc || video.src || "").substring(0, 50) + "...",
    totalTracked: AppState.getPlayerCount(),
    hasShadowRoot: !!player.shadowRoot,
    videoReadyState: video.readyState,
  });

  return entry;
}

/**
 * Remove tracking for a player and clean up
 */
export function untrackPlayer(player, entry) {
  // Guard against duplicate cleanup
  if (!AppState.hasPlayer(player)) {
    debug.log(
      "CLEANUP",
      `Player ${entry?.id || "unknown"} already removed, skipping`,
    );
    return;
  }

  debug.log("CLEANUP", `Cleaning: ${entry.id}`);

  const video = getVideoFromPlayer(player);
  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }
  if (entry.cleanups) {
    entry.cleanups.forEach((fn) => fn());
    entry.cleanups = null;
  }

  // Check currently playing
  if (video === AppState.getCurrentlyPlaying()) {
    AppState.setCurrentlyPlaying(null);
  }

  AppState.removePlayer(player);
}

/**
 * Scan DOM for all players and track new ones
 * Returns stats about the scan
 */
export function scanForPlayers() {
  debug.log("DOM", "Scanning for players...");

  const allPlayers = document.querySelectorAll("shreddit-player");
  debug.log(
    "DOM",
    `Found ${allPlayers.length} shreddit-player elements in DOM`,
  );

  let newCount = 0;
  let existingCount = 0;
  let noVideoCount = 0;

  allPlayers.forEach((player) => {
    const video = getVideoFromPlayer(player);
    if (video) {
      if (!AppState.hasPlayer(player)) {
        trackPlayer(player);
        newCount++;
      } else {
        existingCount++;
        // Update info for existing players
        AppState.updateEntry(player, { info: getVideoInfo(video) });
      }
    } else {
      noVideoCount++;
      debug.log(
        "DOM",
        `Player ${getPlayerId(player)} has no video element yet`,
      );
    }
  });

  debug.log(
    "DOM",
    `Scan complete: ${newCount} new, ${existingCount} existing, ${noVideoCount} no-video, ${AppState.getPlayerCount()} total tracked`,
  );

  // ✅ Try to auto-select first video after tracking
  if (!initialAutoSelectDone && AppState.getPlayerCount() > 0) {
    // Small delay to let videos initialize
    setTimeout(() => {
      autoSelectFirstVideo();
      // If still not done, try again after another delay
      if (!initialAutoSelectDone) {
        setTimeout(autoSelectFirstVideo, 2000);
      }
    }, 500);
  }

  // Retry logic: if no players found, schedule retries (Reddit loads async)
  if (
    AppState.getPlayerCount() === 0 &&
    scanRetryCount < DOM_CONFIG.MAX_SCAN_RETRIES
  ) {
    scanRetryCount++;
    debug.log(
      "DOM",
      `No players tracked yet - retry ${scanRetryCount}/${DOM_CONFIG.MAX_SCAN_RETRIES} in ${DOM_CONFIG.SCAN_RETRY_DELAY}ms`,
    );
    clearTimeout(scanRetryTimer);
    scanRetryTimer = setTimeout(scanForPlayers, DOM_CONFIG.SCAN_RETRY_DELAY);
  } else if (AppState.getPlayerCount() > 0) {
    // Reset retry count once we find players
    scanRetryCount = 0;
  }

  return { newCount, existingCount, noVideoCount };
}

/**
 * ✅ Reset auto-select state (for testing or when feed refreshes)
 */
export function resetAutoSelect() {
  initialAutoSelectDone = false;
}

/**
 * Clean up players no longer in DOM
 */
export function cleanupStalePlayers() {
  const toRemove = [];
  for (const [player, entry] of AppState.getPlayerEntries()) {
    if (!document.contains(player)) {
      debug.log("CLEANUP", `Player ${entry.id} removed from DOM`);
      toRemove.push({ player, entry });
    }
  }

  // Deduplicate before processing
  const uniqueToRemove = [];
  const seen = new Set();
  for (const item of toRemove) {
    if (!seen.has(item.entry.id)) {
      seen.add(item.entry.id);
      uniqueToRemove.push(item);
    }
  }

  uniqueToRemove.forEach(({ player, entry }) => {
    untrackPlayer(player, entry);
    // Remove associated card
    const card = AppState.removeCard(player);
    card?.remove();
  });

  // ✅ If the auto-selected video was removed, allow re-select
  if (uniqueToRemove.length > 0 && initialAutoSelectDone) {
    const remainingEntries = AppState.getPlayerEntries();
    const stillHasSelected = remainingEntries.some(([player]) => {
      const video = getVideoFromPlayer(player);
      return video === AppState.getCurrentlyPlaying();
    });
    if (!stillHasSelected) {
      resetAutoSelect();
    }
  }

  return uniqueToRemove.length;
}

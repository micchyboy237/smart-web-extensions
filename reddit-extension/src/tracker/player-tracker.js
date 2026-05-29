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

let scanRetryCount = 0;
let scanRetryTimer = null;

/**
 * Track a single shreddit-player element
 */
export function trackPlayer(player) {
  if (AppState.hasPlayer(player)) {
    debug.log("DOM", `Player ${getPlayerId(player)} already tracked, skipping`);
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
    debug.log("DOM", `Setting up shadow DOM observer for ${id}`);
    const shadowObserver = new MutationObserver(() => {
      const newVideo = getVideoFromPlayer(player);
      if (newVideo && newVideo.dataset.boostAttached !== "true") {
        debug.log("DOM", `Video element changed in ${id}, reattaching boost`);
        entry.boostCleanup?.();
        newVideo.dataset.videoObserverId = id;
        newVideo.muted = true;
        newVideo.volume = 0.5;
        entry.boostCleanup = BoostEngine.attach(newVideo);
        entry.info = getVideoInfo(newVideo);
      }
    });
    shadowObserver.observe(player.shadowRoot, {
      childList: true,
      subtree: true,
    });
    entry.cleanups.push(() => shadowObserver.disconnect());
  } else {
    debug.log(
      "DOM",
      `No shadowRoot for player ${getPlayerId(player)} - may not be a web component`,
    );
  }

  // Unmute on first interaction
  const unmuteHandler = () => {
    const currentVideo = getVideoFromPlayer(player);
    if (currentVideo?.muted) {
      currentVideo.muted = false;
      currentVideo.volume = 0.5;
      debug.log("INFO", `Unmuted ${id}`);
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
  // ✅ Guard against duplicate cleanup
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

  // ✅ Deduplicate before processing
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

  return uniqueToRemove.length;
}

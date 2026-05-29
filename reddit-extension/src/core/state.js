/**
 * Centralized state management with pub/sub pattern
 * Single source of truth for all extension state
 */
import { DebugLogger as debug } from "./debug.js";

export const AppState = (() => {
  // Private state
  const players = new Map(); // shreddit-player → PlayerEntry
  const videoCards = new Map(); // shreddit-player → card DOM
  let currentlyPlaying = null;
  let isPanelVisible = true;
  let tabIsVisible = !document.hidden;
  let videoCounter = 0;

  // Observer pattern for state changes
  const listeners = new Map();

  function notify(event, data) {
    const subs = listeners.get(event);
    if (subs) {
      subs.forEach((callback) => {
        try {
          callback(data);
        } catch (e) {
          debug.error(`Listener error for ${event}`, e);
        }
      });
    }
  }

  return {
    // --- Getters ---
    getPlayers() {
      return new Map(players);
    },
    getPlayerEntries() {
      return Array.from(players.entries());
    },
    getPlayerCount() {
      return players.size;
    },
    hasPlayer(player) {
      return players.has(player);
    },
    getEntry(player) {
      return players.get(player);
    },
    getCurrentlyPlaying() {
      return currentlyPlaying;
    },
    isPanelVisible() {
      return isPanelVisible;
    },
    isTabVisible() {
      return tabIsVisible;
    },
    getNextVideoId() {
      return `video-${++videoCounter}`;
    },

    // --- Setters ---
    addPlayer(player, entry) {
      players.set(player, entry);
      debug.log("STATE", `Added: ${entry.id} | Total: ${players.size}`);
      notify("player:added", { player, entry });
      notify("players:changed", { count: players.size, action: "add" });
    },
    removePlayer(player) {
      const entry = players.get(player);
      players.delete(player);
      if (entry) {
        debug.log("STATE", `Removed: ${entry.id} | Total: ${players.size}`);
        notify("player:removed", { player, entry });
      }
      notify("players:changed", { count: players.size, action: "remove" });
      return entry;
    },
    updateEntry(player, updates) {
      const entry = players.get(player);
      if (entry) {
        Object.assign(entry, updates);
        notify("player:updated", { player, entry });
      }
    },
    setCurrentlyPlaying(video) {
      currentlyPlaying = video;
      notify("playback:changed", { video });
    },
    togglePanel() {
      isPanelVisible = !isPanelVisible;
      notify("panel:visibility", { visible: isPanelVisible });
    },
    setTabVisible(visible) {
      tabIsVisible = visible;
      notify("tab:visibility", { visible });
    },

    // ✅ NEW: Public method to trigger panel refresh
    notifyPlayersChanged() {
      notify("players:changed", { count: players.size, action: "scan" });
    },

    // --- Card Management ---
    getCard(player) {
      return videoCards.get(player);
    },
    setCard(player, card) {
      videoCards.set(player, card);
    },
    removeCard(player) {
      const card = videoCards.get(player);
      videoCards.delete(player);
      return card;
    },

    // --- Subscriptions ---
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback);
    },

    reset() {
      players.clear();
      videoCards.clear();
      currentlyPlaying = null;
      videoCounter = 0;
    },
  };
})();

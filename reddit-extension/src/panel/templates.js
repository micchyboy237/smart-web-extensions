/**
 * HTML templates for panel and cards
 * Keeping markup separate from logic
 */

export function getPanelTemplate() {
  return `
    <header>
      🎥 Reddit Videos
      <button class="close-btn" id="toggle-panel">✕</button>
    </header>
    <div class="tabs">
      <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>
    <div id="videos-tab" class="content">
      <div id="videos-list"></div>
      <div id="empty-videos">No videos detected yet<br><small>Scroll to load posts</small></div>
    </div>
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <div class="status">shreddit-player • ${new Date().toLocaleTimeString()}</div>
  `;
}

export function createCardHTML(entry) {
  const info = entry.info;
  const buffPercent = info.duration
    ? Math.round((info.bufferAhead / info.duration) * 100)
    : 0;
  return `
    <div class="preview-container">
      <video src="${escapeHtml(info.src)}" muted preload="metadata"
        style="width:100%;height:100%;object-fit:cover;border-radius:4px;background:#1a1a2e;"></video>
    </div>
    <div class="video-info-row">
      <div class="video-id-meta">
        <span class="video-id">${escapeHtml(entry.id)}</span>
        <span class="video-meta">${Math.floor(info.currentTime)}/${Math.floor(info.duration)}s</span>
      </div>
      <span class="video-status ${info.paused ? "paused" : "playing"}">
        ${info.paused ? "⏸ Paused" : "▶ Playing"}
      </span>
    </div>
    <div class="boost-indicator" style="display:none;">
      🚀 Boost 1.00x | Buffer: ${buffPercent}%
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

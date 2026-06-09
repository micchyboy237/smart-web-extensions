/**
 * HTML templates for panel and cards
 * UPDATED: 2-row grid header, info bar, auto-scroll checkbox
 */
export function getPanelTemplate() {
  return `
    <!-- Row 1: Title + Controls -->
    <div class="panel-header-row panel-header-top">
      <div class="panel-title-group">
        <span class="panel-title">🎥 Reddit Videos</span>
        <span class="panel-video-counter" id="panel-video-counter">0/0</span>
      </div>
      <div class="panel-controls-group">
        <label class="panel-checkbox-label" title="Auto-scroll body to currently playing video">
          <input type="checkbox" id="auto-scroll-checkbox" checked>
          <span class="panel-checkbox-text">📌 Follow</span>
        </label>
        <button class="close-btn" id="toggle-panel">✕</button>
      </div>
    </div>
    <!-- Row 2: Info Bar -->
    <div class="panel-header-row panel-header-info">
      <span class="panel-info-item" id="panel-info-status">⏸ Idle</span>
      <span class="panel-info-item" id="panel-info-position">—</span>
      <span class="panel-info-item" id="panel-info-boost">🚀 0 boosts</span>
      <span class="panel-info-item" id="panel-info-chunks">🎞 0 chunks</span>
    </div>
    <!-- Tabs -->
    <div class="tabs">
      <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>
    <!-- Video List -->
    <div id="videos-tab" class="content">
      <div id="videos-list"></div>
      <div id="empty-videos">No videos detected yet<br><small>Scroll to load posts</small></div>
    </div>
    <!-- Logs -->
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <!-- Status bar -->
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

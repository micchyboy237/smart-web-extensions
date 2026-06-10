/**
 * popup.js - Extension Popup Controller
 * Shows real-time CORS status and stream monitoring
 */

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const openPlayerBtn = document.getElementById("openPlayerBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const statRequests = document.getElementById("statRequests");
  const statCorsFixed = document.getElementById("statCorsFixed");
  const statDomains = document.getElementById("statDomains");
  const statRules = document.getElementById("statRules");
  const domainListContent = document.getElementById("domainListContent");
  const domainList = document.getElementById("domainList");
  const corsModeBadge = document.getElementById("corsModeBadge");

  // Check for active player and get stats
  checkActivePlayer();
  getBackgroundStats();

  // Refresh stats every 3 seconds
  setInterval(getBackgroundStats, 3000);

  // Open player button
  openPlayerBtn.addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("player/player.html"),
    });
  });

  /**
   * Check if player tab is open
   */
  function checkActivePlayer() {
    chrome.tabs.query(
      {
        url: chrome.runtime.getURL("player/player.html"),
      },
      (tabs) => {
        if (tabs.length > 0) {
          statusDot.classList.add("active");
          statusText.textContent = `Player active (Tab #${tabs[0].id})`;
        } else {
          statusDot.classList.remove("active");
          statusText.textContent = "Player not open";
        }
      },
    );
  }

  /**
   * Get stats from background service worker
   */
  function getBackgroundStats() {
    chrome.runtime.sendMessage({ action: "getStats" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Stats error:", chrome.runtime.lastError.message);
        updateStatsDisplay({
          requestsIntercepted: 0,
          corsHeadersAdded: 0,
          activeStreams: [],
          recentRequests: [],
          corsRules: { totalRules: 0, domains: [] },
        });
        corsModeBadge.textContent = "Connecting...";
        corsModeBadge.style.background = "#ff444422";
        corsModeBadge.style.color = "#ff4444";
        corsModeBadge.style.border = "1px solid #ff444444";
        return;
      }

      if (response && response.success) {
        updateStatsDisplay(response.stats);
        corsModeBadge.textContent = "Auto-Fix Active";
        corsModeBadge.style.background = "#00ff8822";
        corsModeBadge.style.color = "#00ff88";
        corsModeBadge.style.border = "1px solid #00ff8844";
      }
    });
  }

  /**
   * Update the stats display
   */
  function updateStatsDisplay(stats) {
    // Update counters
    statRequests.textContent = stats.requestsIntercepted || 0;
    statCorsFixed.textContent = stats.corsHeadersAdded || 0;
    statDomains.textContent = (stats.activeStreams || []).length;
    statRules.textContent = stats.corsRules?.totalRules || 0;

    // Update domain list
    if (stats.activeStreams && stats.activeStreams.length > 0) {
      domainList.style.display = "block";

      const recentDomains = stats.recentRequests || [];
      const domainCorsStatus = {};

      // Determine CORS status per domain
      recentDomains.forEach((req) => {
        if (!domainCorsStatus[req.domain]) {
          domainCorsStatus[req.domain] = req.hasCORS;
        }
      });

      // Check which domains have active rules
      const rulesDomains = new Set(stats.corsRules?.domains || []);

      domainListContent.innerHTML = stats.activeStreams
        .map((domain) => {
          let badgeClass = "ok";
          let badgeText = "OK";

          if (rulesDomains.has(domain)) {
            badgeClass = "fixed";
            badgeText = "Fixed";
          } else if (domainCorsStatus[domain] === false) {
            badgeClass = "error";
            badgeText = "Blocked";
          }

          return `
                  <div class="domain-item">
                      <span class="domain-name" title="${domain}">${domain}</span>
                      <span class="cors-badge ${badgeClass}">${badgeText}</span>
                  </div>
              `;
        })
        .join("");
    } else {
      domainList.style.display = "none";
    }
  }
});

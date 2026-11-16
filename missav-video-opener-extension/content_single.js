// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/content_single.js
(function () {
  "use strict";
  const SINGLE_VIDEO_PATH_RE =
    /^\/(?:dm\d+\/)?en\/([a-z0-9]+-\d+(?:-[a-z0-9-]+)?)$/i;
  if (!SINGLE_VIDEO_PATH_RE.test(window.location.pathname)) {
    return;
  }
  window.__missavSingleRan = true;
  window.__missavSingleLastLog = `injected @ ${new Date().toISOString()} ${location.href}`;
  console.log("[MissAV-Single] 🚀 CONTENT SCRIPT INJECTED", location.href);
  const LOG_PREFIX = "[MissAV-Single]";
  const DEBUG = true;
  const MAX_DOM_WAIT_MS = 8000;
  const POLL_INTERVAL_MS = 500;
  const SETTLE_DELAY_MS = 1500;
  function log(...args) {
    window.__missavSingleLastLog = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
      .slice(0, 300);
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }
  function logObj(label, obj) {
    if (!DEBUG) return;
    window.__missavSingleLastLog = `${label}: ${JSON.stringify(obj).slice(0, 300)}`;
    console.groupCollapsed(`${LOG_PREFIX} ${label}`);
    try {
      console.table(obj);
    } catch (_) {}
    console.log("raw:", obj);
    console.groupEnd();
  }
  function isSingleVideoPage() {
    return SINGLE_VIDEO_PATH_RE.test(window.location.pathname);
  }
  function isValidMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    const t = url.trim();
    if (!t) return false;
    if (/[()?:]/.test(t) && /\s/.test(t)) return false;
    if (
      t.startsWith("javascript:") ||
      t.startsWith("blob:") ||
      t.startsWith("data:")
    )
      return false;
    if (!/^https?:\/\//i.test(t)) return false;
    return true;
  }
  function getSrcOrDataSrc(el) {
    if (!el) return null;
    if (el.currentSrc) {
      const cs = el.currentSrc.trim();
      if (isValidMediaUrl(cs)) return cs;
    }
    const s = el.getAttribute("src");
    if (s && isValidMediaUrl(s)) return s.trim();
    const d = el.getAttribute("data-src");
    if (d && isValidMediaUrl(d)) return d.trim();
    if (el.tagName === "VIDEO") {
      const so = el.querySelector("source");
      if (so) {
        const ss = so.getAttribute("src");
        if (ss && isValidMediaUrl(ss)) return ss.trim();
      }
      const p = el.getAttribute("poster");
      if (p && isValidMediaUrl(p)) return p.trim();
    }
    return null;
  }
  function generatePreviewUrl(thumb) {
    if (!thumb || typeof thumb !== "string") return null;
    if (thumb.endsWith("/preview.mp4")) return thumb;
    const i = thumb.lastIndexOf("/");
    if (i === -1) return null;
    return thumb.substring(0, i + 1) + "preview.mp4";
  }
  function generateIdFromUrl(url, videoId) {
    const input = url || videoId;
    if (!input) return "unknown-" + Date.now();
    let normalized;
    try {
      const u = new URL(input);
      normalized = u.origin + u.pathname;
    } catch (_) {
      normalized = input;
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return "jav-" + hash.toString(36);
  }
  function deriveVideoIdentifiers(seg) {
    const s = String(seg || "").toLowerCase();
    const m = s.match(/^([a-z0-9]+)-(\d+)/);
    if (!m) return { videoId: null, code: null, episode: null };
    return { videoId: s, code: m[1], episode: m[2] };
  }
  function waitForDomReady(
    isReady,
    timeoutMs = MAX_DOM_WAIT_MS,
    intervalMs = POLL_INTERVAL_MS,
  ) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let ready = false;
        try {
          ready = !!isReady();
        } catch (_) {
          ready = false;
        }
        if (ready) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }
  function isPageLikelyReady() {
    return (
      !!document.querySelector("h1") ||
      (!!document.querySelector("video") &&
        !!document.querySelector(
          ".order-first, .mt-4.text-secondary, .text-secondary",
        ))
    );
  }
  function pickFirst(label, selectors) {
    for (const sel of selectors) {
      let v = null;
      try {
        if (sel.startsWith("meta")) {
          const el = document.querySelector(sel);
          v = el?.getAttribute("content")?.trim() || null;
        } else {
          const el = document.querySelector(sel);
          v = el?.innerText?.trim() || null;
        }
      } catch (e) {
        log(`  [${label}] selector error "${sel}":`, e?.message);
      }
      if (v) {
        log(`  matched [${label}] via "${sel}" →`, v.slice(0, 120));
        return v;
      }
    }
    log(`  no match [${label}]`);
    return null;
  }
  function extractVideoMetadata() {
    const t0 = performance.now();
    const url = window.location.href.split("#")[0];
    log("──────────────────────────────────────────────────────────────");
    log("extractVideoMetadata()", { url, pathname: window.location.pathname });
    const pathMatch = window.location.pathname.match(SINGLE_VIDEO_PATH_RE);
    if (!pathMatch) {
      log("✗ path regex no match");
      return null;
    }
    const rawSegment = pathMatch[1];
    const { videoId, code, episode } = deriveVideoIdentifiers(rawSegment);
    log("  identifiers:", { videoId, code, episode });
    if (!videoId) return null;
    log("Extracting title…");
    const title = pickFirst("title", [
      "h1.text-base.lg\\:text-lg",
      "h1.lg\\:text-lg",
      "h1.text-base",
      "h1",
      ".text-base.text-secondary",
      "meta[property='og:title']",
    ]);
    log("Extracting details…");
    let details = pickFirst("details", [
      ".order-first .text-secondary.break-all",
      ".mt-4.text-secondary.break-all",
      ".text-secondary.break-all",
      "meta[name='description']",
      "meta[property='og:description']",
    ]);
    if (details && details.length <= 10) details = null;
    log("Extracting release date…");
    let releaseDate = null,
      src = null;
    const timeEl = document.querySelector(
      ".order-first time[datetime], time[datetime]",
    );
    if (timeEl) {
      releaseDate = timeEl.getAttribute("datetime");
      src = "time[datetime]";
    }
    if (!releaseDate) {
      for (const n of document.querySelectorAll(
        ".text-secondary, .order-first",
      )) {
        const m = (n.textContent || "").match(
          /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/,
        );
        if (m) {
          releaseDate = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
          src = "text fallback";
          break;
        }
      }
    }
    log("  releaseDate:", releaseDate, src ? `(${src})` : "(none)");
    log("Extracting genres…");
    let genres = [];
    for (const c of document.querySelectorAll(".text-secondary")) {
      const span = c.querySelector("span");
      if (span && /genre/i.test(span.textContent)) {
        genres = Array.from(c.querySelectorAll("a.font-medium"))
          .map((l) => l.textContent.trim())
          .filter(Boolean);
        if (genres.length) break;
      }
    }
    if (!genres.length) {
      genres = Array.from(document.querySelectorAll("a.font-medium"))
        .map((a) => a.textContent.trim())
        .filter((t) => t && t.length < 40);
    }
    log(`  genres (${genres.length}):`, genres);
    log("Extracting thumbnail/preview…");
    let thumbnail = null,
      thumbSrc = null;
    const player = document.querySelector("video.player");
    if (player) {
      thumbnail =
        player.getAttribute("data-poster") || player.getAttribute("poster");
      if (thumbnail) thumbSrc = "video.player";
    }
    if (!thumbnail) {
      const fb = document.querySelector(".order-first img, img[src*='cover']");
      if (fb) {
        thumbnail = getSrcOrDataSrc(fb);
        if (thumbnail) thumbSrc = "fallback img";
      }
    }
    if (!thumbnail) {
      const og = document.querySelector("meta[property='og:image']");
      if (og) {
        thumbnail = og.getAttribute("content");
        if (thumbnail) thumbSrc = "og:image";
      }
    }
    const preview = thumbnail ? generatePreviewUrl(thumbnail) : null;
    log("  thumbnail:", thumbnail, thumbSrc ? `(${thumbSrc})` : "(none)");
    log("  preview:", preview);
    const id = generateIdFromUrl(url, videoId);
    const result = {
      id,
      url,
      code,
      episode,
      video_id: videoId,
      title: title || null,
      thumbnail: thumbnail || null,
      preview: preview || null,
      details: details || null,
      release_date: releaseDate || null,
      genres: genres || [],
    };
    logObj(
      `Extracted object (${(performance.now() - t0).toFixed(1)}ms)`,
      result,
    );
    return result;
  }
  function isMetadataComplete(meta) {
    if (!meta) return false;
    if (
      !meta.title ||
      meta.title === "Unknown Title" ||
      meta.title.trim() === ""
    ) {
      log("isMetadataComplete: ✗ missing title");
      return false;
    }
    log("isMetadataComplete: ✓ complete");
    return true;
  }
  function reportIncomplete(metadata) {
    console.warn(`${LOG_PREFIX} ⚠️ Incomplete extraction`);
    console.groupCollapsed(`${LOG_PREFIX} incomplete metadata (expand)`);
    console.table(metadata);
    console.log("raw:", metadata);
    console.log("presence:", {
      id: !!metadata?.id,
      url: !!metadata?.url,
      code: !!metadata?.code,
      episode: !!metadata?.episode,
      video_id: !!metadata?.video_id,
      title: !!metadata?.title,
      thumbnail: !!metadata?.thumbnail,
      preview: !!metadata?.preview,
      details: !!metadata?.details,
      release_date: !!metadata?.release_date,
      genres: Array.isArray(metadata?.genres)
        ? metadata.genres.length
        : "not array",
    });
    console.groupEnd();
    chrome.runtime.sendMessage({
      action: "markVideoIncomplete",
      videoId: metadata?.id || null,
      url: metadata?.url || window.location.href,
    });
  }
  function reportCompleted(metadata) {
    log(`✅ Complete extraction for ${metadata.video_id}`);
    logObj("Sending videoCompleted payload", metadata);
    chrome.runtime.sendMessage({ action: "videoCompleted", metadata });
  }
  async function run() {
    log("run()", {
      href: window.location.href,
      isSingle: isSingleVideoPage(),
      readyState: document.readyState,
    });
    if (!isSingleVideoPage()) {
      log("→ not single, bail");
      return;
    }
    const ready = await waitForDomReady(isPageLikelyReady);
    if (!ready)
      console.warn(`${LOG_PREFIX} DOM not ready in ${MAX_DOM_WAIT_MS}ms`);
    await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));
    let metadata = extractVideoMetadata();
    if (!metadata) {
      console.warn(`${LOG_PREFIX} no metadata on single page`);
      return;
    }
    if (isMetadataComplete(metadata)) {
      reportCompleted(metadata);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    const retry = extractVideoMetadata();
    if (retry && isMetadataComplete(retry)) {
      reportCompleted(retry);
      return;
    }
    reportIncomplete(retry || metadata);
  }
  let _navTimer = null;
  function scheduleRun(label) {
    log(`scheduleRun via ${label}`);
    clearTimeout(_navTimer);
    _navTimer = setTimeout(run, 500);
  }
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    log("document already ready — scheduling immediate run");
    setTimeout(() => scheduleRun("readyState-at-inject"), 0);
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => scheduleRun("DOMContentLoaded"),
    { once: true },
  );
  window.addEventListener("load", () => scheduleRun("window.load"));
  window.addEventListener("popstate", () => scheduleRun("popstate"));
  (function watchPathChanges() {
    let last = window.location.href;
    setInterval(() => {
      if (window.location.href !== last) {
        log("URL changed:", last, "→", window.location.href);
        last = window.location.href;
        scheduleRun("url-change");
      }
    }, 1000);
  })();
})();

/**
 * Video DOM utility functions
 * Shadow DOM-aware helpers for accessing Reddit video elements
 */
export function getVideoFromPlayer(player) {
  if (!player) return null;
  if (player.shadowRoot) {
    return player.shadowRoot.querySelector("video");
  }
  return player.querySelector("video");
}

export function getPlayerId(player) {
  const post = player.closest("shreddit-post");
  if (post) {
    return post.getAttribute("post-id") || post.id || `player-unknown`;
  }
  return player.id || `player-unknown`;
}

export function getBufferAhead(video) {
  if (!video?.buffered?.length) return 0;
  const ahead =
    video.buffered.end(video.buffered.length - 1) - video.currentTime;
  return Math.max(0, ahead);
}

export function getEffectiveBufferRatio(video) {
  if (!video?.buffered?.length) return 0;
  let totalBuffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    totalBuffered += video.buffered.end(i) - video.buffered.start(i);
  }
  const ahead = getBufferAhead(video);
  return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
}

export function getVideoInfo(video) {
  if (!video) {
    return {
      id: "no-video",
      src: "No source",
      currentTime: 0,
      duration: 0,
      paused: true,
      playbackRate: 1,
      bufferAhead: 0,
      muted: true,
      readyState: 0,
    };
  }
  return {
    id: video.dataset.videoObserverId || "unknown",
    src: video.currentSrc || video.src || "No source",
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    paused: video.paused,
    playbackRate: video.playbackRate || 1.0,
    bufferAhead: getBufferAhead(video),
    muted: video.muted,
    readyState: video.readyState,
  };
}

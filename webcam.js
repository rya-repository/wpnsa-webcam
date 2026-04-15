const video = document.getElementById('video');
const status = document.getElementById('status');
const src = 'https://camsecure.co/HLS/weymouthsailing.m3u8';
let hls;
const hardReloadMs = 3 * 60 * 1000;
const recoveryTargetMs = 10000;
const freezeReloadMs = 15000;
const startupGraceMs = 8000;
const stuckStartupReloadMs = 15000;
const minReconnectGapMs = 7000;
const frameSignatureFreezeMs = 20000;
const stallWindowMs = 8000;
const stallReconnectThreshold = 2;
const bufferStallBurstWindowMs = 6000;
const bufferStallReconnectThreshold = 2;
const liveCatchupLagSec = 2.5;
const liveCatchupOffsetSec = 0.2;
const pageStartedAtMs = Date.now();
let lastAdvanceAtMs = Date.now();
let lastObservedTimeSec = 0;
let freezeReloadArmed = false;
let commonRecoveryBound = false;
let recentStallCount = 0;
let stallWindowStartedAtMs = Date.now();
let connectStartedAtMs = Date.now();
let lastReconnectAtMs = 0;
let mediaFatalRecoveryCount = 0;
let lastDecodedFrameCount = -1;
let decodedStallStartedAtMs = 0;
let lastFrameSignature = '';
let frameSignatureStallStartedAtMs = 0;
let greenCorruptionStartedAtMs = 0;
const greenCorruptionTriggerMs = 6000;
let bufferStallBurstCount = 0;
let lastBufferStallAtMs = 0;
let lastHealthSignalAtMs = Date.now();
let reconnectTimerId = 0;
let reconnectPendingReason = '';
let frameProbeCanvas;
let frameProbeCtx;

function markHealthyNow() {
  lastHealthSignalAtMs = Date.now();
}

function clearReconnectTimer() {
  if (reconnectTimerId) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = 0;
  }
}

function scheduleReconnect(reason, delayMs) {
  reconnectPendingReason = reason || reconnectPendingReason || 'Reconnecting stream...';
  if (reconnectTimerId) {
    return;
  }

  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = 0;
    const pendingReason = reconnectPendingReason;
    reconnectPendingReason = '';
    reconnectStream(pendingReason || 'Reconnecting stream...');
  }, Math.max(0, delayMs));
}

function getFrameSignature() {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return '';
  }

  if (!frameProbeCanvas) {
    frameProbeCanvas = document.createElement('canvas');
    frameProbeCanvas.width = 64;
    frameProbeCanvas.height = 36;
    frameProbeCtx = frameProbeCanvas.getContext('2d', { willReadFrequently: true });
  }

  if (!frameProbeCtx) {
    return '';
  }

  try {
    frameProbeCtx.drawImage(video, 0, 0, frameProbeCanvas.width, frameProbeCanvas.height);
    const pixels = frameProbeCtx.getImageData(0, 0, frameProbeCanvas.width, frameProbeCanvas.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    // Sample every 16th pixel to keep this lightweight on kiosk browsers.
    for (let i = 0; i < pixels.length; i += 64) {
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
    }
    return r + '|' + g + '|' + b;
  } catch (_) {
    return '';
  }
}

function getDecodedFrameCount() {
  if (typeof video.getVideoPlaybackQuality === 'function') {
    const quality = video.getVideoPlaybackQuality();
    if (quality && Number.isFinite(quality.totalVideoFrames)) {
      return quality.totalVideoFrames;
    }
  }

  if (Number.isFinite(video.webkitDecodedFrameCount)) {
    return video.webkitDecodedFrameCount;
  }

  if (Number.isFinite(video.mozDecodedFrames)) {
    return video.mozDecodedFrames;
  }

  return -1;
}

function isLikelyGreenCorruption() {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return false;
  }

  if (!frameProbeCanvas) {
    frameProbeCanvas = document.createElement('canvas');
    frameProbeCanvas.width = 64;
    frameProbeCanvas.height = 36;
    frameProbeCtx = frameProbeCanvas.getContext('2d', { willReadFrequently: true });
  }

  if (!frameProbeCtx) {
    return false;
  }

  try {
    frameProbeCtx.drawImage(video, 0, 0, frameProbeCanvas.width, frameProbeCanvas.height);
    const pixels = frameProbeCtx.getImageData(0, 0, frameProbeCanvas.width, frameProbeCanvas.height).data;
    let greenDominantCount = 0;
    const pixelCount = pixels.length / 4;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      if (g > 80 && g > r * 1.6 && g > b * 1.6) {
        greenDominantCount += 1;
      }
    }

    return greenDominantCount / pixelCount > 0.55;
  } catch (_) {
    // If frame sampling fails in a kiosk browser, skip corruption detection.
    return false;
  }
}

function resetStallWindowIfNeeded(nowMs) {
  if (nowMs - stallWindowStartedAtMs > stallWindowMs) {
    stallWindowStartedAtMs = nowMs;
    recentStallCount = 0;
  }
}

function markStallAndMaybeReconnect(reason) {
  const nowMs = Date.now();
  resetStallWindowIfNeeded(nowMs);
  recentStallCount += 1;

  if (recentStallCount >= stallReconnectThreshold) {
    reconnectStream(reason || 'Repeated stalls detected. Reconnecting stream...');
    return true;
  }

  return false;
}

function setStatus(message) {
  status.textContent = message;
}

function catchUpToLiveEdge() {
  if (!hls || !Number.isFinite(video.currentTime) || video.readyState < 2) {
    return false;
  }

  const liveSyncPos = hls.liveSyncPosition;
  if (!Number.isFinite(liveSyncPos)) {
    return false;
  }

  const lagSec = liveSyncPos - video.currentTime;
  if (lagSec <= liveCatchupLagSec) {
    return false;
  }

  video.currentTime = Math.max(0, liveSyncPos - liveCatchupOffsetSec);
  markHealthyNow();
  return true;
}

function tryPlay() {
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      // UC Cast/kiosk browsers can temporarily reject autoplay; retry shortly.
      setTimeout(() => video.play().catch(() => {}), 1000);
    });
  }
}

window.addEventListener('error', (event) => {
  setStatus('JS error: ' + event.message);
});

video.addEventListener('error', () => {
  const code = video.error ? video.error.code : 'unknown';
  setStatus('Video error code: ' + code);

  // MEDIA_ERR_DECODE (3) commonly appears on kiosk browsers after long runs.
  if (code === 3) {
    reconnectStream('Video decode error (code 3). Reconnecting stream...');
  }
});

video.addEventListener('timeupdate', () => {
  if (!Number.isFinite(video.currentTime)) {
    return;
  }
  if (video.currentTime > lastObservedTimeSec + 0.05) {
    markHealthyNow();
    lastObservedTimeSec = video.currentTime;
    lastAdvanceAtMs = Date.now();
    freezeReloadArmed = true;
  }
});

video.addEventListener('playing', markHealthyNow);

function attachCommonRecovery() {
  if (commonRecoveryBound) {
    return;
  }
  commonRecoveryBound = true;

  video.addEventListener('stalled', () => {
    if (markStallAndMaybeReconnect('Video stalled repeatedly. Reconnecting stream...')) {
      return;
    }

    if (hls && Number.isFinite(video.currentTime)) {
      hls.startLoad();
      video.currentTime = Math.max(0, video.currentTime - 0.1);
      tryPlay();
    } else if (!hls && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS fallback: reload media element without reloading the page.
      video.load();
      tryPlay();
    }
  });

  video.addEventListener('pause', () => {
    // Keep playback alive for unattended display playback.
    if (!video.ended) {
      tryPlay();
    }
  });

  video.addEventListener('waiting', () => {
    if (markStallAndMaybeReconnect('Playback waiting repeatedly. Reconnecting stream...')) {
      return;
    }

    if (hls) {
      hls.startLoad();
    }
    tryPlay();
  });
}

function destroyHlsInstance() {
  if (hls) {
    hls.destroy();
    hls = undefined;
  }
}

function reconnectStream(reason) {
  const nowMs = Date.now();
  const msSinceReconnect = nowMs - lastReconnectAtMs;
  if (msSinceReconnect < minReconnectGapMs) {
    const waitMs = minReconnectGapMs - msSinceReconnect;
    setStatus('Reconnect cooldown active (' + Math.ceil(waitMs / 1000) + 's), retry queued...');
    scheduleReconnect(reason || 'Reconnect queued after cooldown...', waitMs + 50);
    return;
  }
  clearReconnectTimer();
  reconnectPendingReason = '';
  lastReconnectAtMs = nowMs;

  setStatus(reason || 'Reconnecting stream...');
  freezeReloadArmed = false;
  lastObservedTimeSec = 0;
  lastAdvanceAtMs = nowMs;
  recentStallCount = 0;
  stallWindowStartedAtMs = nowMs;
  connectStartedAtMs = nowMs;
  mediaFatalRecoveryCount = 0;
  lastDecodedFrameCount = -1;
  decodedStallStartedAtMs = 0;
  lastFrameSignature = '';
  frameSignatureStallStartedAtMs = 0;
  greenCorruptionStartedAtMs = 0;
  bufferStallBurstCount = 0;
  lastBufferStallAtMs = 0;
  lastHealthSignalAtMs = nowMs;
  destroyHlsInstance();
  video.pause();
  video.removeAttribute('src');
  video.load();
  connectStream();
}

function connectStream() {
  connectStartedAtMs = Date.now();
  lastHealthSignalAtMs = connectStartedAtMs;

  if (window.Hls && Hls.isSupported()) {
    setStatus('HLS.js supported. Connecting stream...');
    const nextHls = new Hls({
      enableWorker: false,
      startPosition: -1,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      maxLiveSyncPlaybackRate: 1.2,
      backBufferLength: 0,
      liveBackBufferLength: 0,
      maxBufferLength: 8,
      maxBufferHole: 0.5,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 8,
      lowLatencyMode: false
    });
    hls = nextHls;

    nextHls.attachMedia(video);
    nextHls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (hls !== nextHls) {
        return;
      }
      setStatus('Media attached. Loading manifest...');
      nextHls.loadSource(src);
    });

    nextHls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (hls !== nextHls) {
        return;
      }
      markHealthyNow();
      mediaFatalRecoveryCount = 0;
      setStatus('Manifest parsed. Playing...');
      tryPlay();
      setTimeout(() => {
        if (hls === nextHls) {
          catchUpToLiveEdge();
        }
      }, 400);
    });

    nextHls.on(Hls.Events.LEVEL_UPDATED, () => {
      if (hls !== nextHls) {
        return;
      }
      catchUpToLiveEdge();
    });

    nextHls.on(Hls.Events.ERROR, (_, data) => {
      if (hls !== nextHls) {
        return;
      }
      setStatus('HLS error: ' + data.type + ' / ' + data.details + (data.fatal ? ' (fatal)' : ''));
      if (!data.fatal) {
        if (data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall') {
          const nowMs = Date.now();
          if (nowMs - lastBufferStallAtMs > bufferStallBurstWindowMs) {
            bufferStallBurstCount = 0;
          }
          lastBufferStallAtMs = nowMs;
          bufferStallBurstCount += 1;

          if (bufferStallBurstCount >= bufferStallReconnectThreshold) {
            reconnectStream('Buffer stalled repeatedly. Reconnecting stream...');
            return;
          }

          if (markStallAndMaybeReconnect('Repeated buffer stall. Reconnecting stream...')) {
            return;
          }

          if (!catchUpToLiveEdge() && Number.isFinite(video.currentTime)) {
            video.currentTime = Math.max(0, video.currentTime - 0.05);
          }
          nextHls.startLoad();
          tryPlay();
        }
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        nextHls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        mediaFatalRecoveryCount += 1;
        if (mediaFatalRecoveryCount <= 2) {
          nextHls.recoverMediaError();
        } else {
          reconnectStream('Repeated fatal media error. Reconnecting stream...');
        }
      } else {
        reconnectStream('Fatal player error. Reconnecting stream...');
      }
    });

    attachCommonRecovery();
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    setStatus('Native HLS detected. Loading stream...');
    video.onloadedmetadata = tryPlay;
    video.src = src;
    video.load();
    attachCommonRecovery();
    return;
  }

  setStatus('This browser does not support HLS playback.');
}

connectStream();
setInterval(() => {
  reconnectStream('Scheduled stream reconnect...');
}, hardReloadMs);

setInterval(() => {
  const nowMs = Date.now();

  if (
    nowMs - pageStartedAtMs > startupGraceMs &&
    nowMs - connectStartedAtMs > recoveryTargetMs &&
    nowMs - lastHealthSignalAtMs > recoveryTargetMs &&
    !video.ended
  ) {
    reconnectStream('No health signal for 10s. Reconnecting stream...');
    return;
  }

  if (
    nowMs - pageStartedAtMs > startupGraceMs &&
    !freezeReloadArmed &&
    video.readyState <= 1 &&
    (video.networkState === 1 || video.networkState === 2) &&
    nowMs - connectStartedAtMs > stuckStartupReloadMs
  ) {
    reconnectStream('Startup stuck (readyState <= 1). Reconnecting stream...');
    return;
  }

  if (
    freezeReloadArmed &&
    nowMs - pageStartedAtMs > startupGraceMs &&
    Number.isFinite(video.currentTime) &&
    !video.paused &&
    !video.ended &&
    video.readyState >= 2 &&
    nowMs - lastAdvanceAtMs > freezeReloadMs
  ) {
    reconnectStream('Playback stalled. Reconnecting stream...');
    return;
  }

  if (
    freezeReloadArmed &&
    !video.paused &&
    !video.ended &&
    video.readyState >= 2
  ) {
    const decodedFrameCount = getDecodedFrameCount();
    if (decodedFrameCount >= 0) {
      if (decodedFrameCount === lastDecodedFrameCount) {
        if (decodedStallStartedAtMs === 0) {
          decodedStallStartedAtMs = nowMs;
        } else if (nowMs - decodedStallStartedAtMs > freezeReloadMs) {
          reconnectStream('Decoded frames stuck. Reconnecting stream...');
          return;
        }
      } else {
        lastDecodedFrameCount = decodedFrameCount;
        decodedStallStartedAtMs = 0;
      }
    }

    const frameSignature = getFrameSignature();
    if (frameSignature) {
      if (frameSignature === lastFrameSignature) {
        if (frameSignatureStallStartedAtMs === 0) {
          frameSignatureStallStartedAtMs = nowMs;
        } else if (nowMs - frameSignatureStallStartedAtMs > frameSignatureFreezeMs) {
          reconnectStream('Displayed frame unchanged too long. Reconnecting stream...');
          return;
        }
      } else {
        lastFrameSignature = frameSignature;
        frameSignatureStallStartedAtMs = 0;
      }
    }

    if (isLikelyGreenCorruption()) {
      if (greenCorruptionStartedAtMs === 0) {
        greenCorruptionStartedAtMs = nowMs;
      } else if (nowMs - greenCorruptionStartedAtMs > greenCorruptionTriggerMs) {
        reconnectStream('Green frame corruption detected. Reconnecting stream...');
        return;
      }
    } else {
      greenCorruptionStartedAtMs = 0;
    }

    catchUpToLiveEdge();
  }

  setStatus(
    'readyState=' + video.readyState +
    ' networkState=' + video.networkState +
    ' stalledFor=' + Math.floor((nowMs - lastAdvanceAtMs) / 1000) + 's' +
    ' unhealthyFor=' + Math.floor((nowMs - lastHealthSignalAtMs) / 1000) + 's' +
    (reconnectTimerId ? ' reconnectQueued=1' : ' reconnectQueued=0')
  );
}, 2000);

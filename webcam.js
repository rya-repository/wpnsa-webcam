const video = document.getElementById('video');
const status = document.getElementById('status');
const src = 'https://camsecure.co/HLS/weymouthsailing.m3u8';
let hls;
const hardReloadMs = 10000;
const freezeReloadMs = 60000;
const startupGraceMs = 30000;
const pageStartedAtMs = Date.now();
let lastAdvanceAtMs = Date.now();
let lastObservedTimeSec = 0;
let freezeReloadArmed = false;
let commonRecoveryBound = false;

function setStatus(message) {
  status.textContent = message;
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
  setStatus('Video error code: ' + (video.error ? video.error.code : 'unknown'));
});

video.addEventListener('timeupdate', () => {
  if (!Number.isFinite(video.currentTime)) {
    return;
  }
  if (video.currentTime > lastObservedTimeSec + 0.05) {
    lastObservedTimeSec = video.currentTime;
    lastAdvanceAtMs = Date.now();
    freezeReloadArmed = true;
  }
});

function attachCommonRecovery() {
  if (commonRecoveryBound) {
    return;
  }
  commonRecoveryBound = true;

  video.addEventListener('stalled', () => {
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
}

function destroyHlsInstance() {
  if (hls) {
    hls.destroy();
    hls = undefined;
  }
}

function reconnectStream(reason) {
  setStatus(reason || 'Reconnecting stream...');
  freezeReloadArmed = false;
  lastObservedTimeSec = 0;
  lastAdvanceAtMs = Date.now();
  destroyHlsInstance();
  video.pause();
  video.removeAttribute('src');
  video.load();
  connectStream();
}

function connectStream() {
  if (window.Hls && Hls.isSupported()) {
    setStatus('HLS.js supported. Connecting stream...');
    const nextHls = new Hls({
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      maxLiveSyncPlaybackRate: 1.2,
      backBufferLength: 30,
      maxBufferLength: 20,
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
      setStatus('Manifest parsed. Playing...');
      tryPlay();
    });

    nextHls.on(Hls.Events.ERROR, (_, data) => {
      if (hls !== nextHls) {
        return;
      }
      setStatus('HLS error: ' + data.type + ' / ' + data.details + (data.fatal ? ' (fatal)' : ''));
      if (!data.fatal) {
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        nextHls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        nextHls.recoverMediaError();
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

  setStatus(
    'readyState=' + video.readyState +
    ' networkState=' + video.networkState +
    ' stalledFor=' + Math.floor((nowMs - lastAdvanceAtMs) / 1000) + 's'
  );
}, 4000);

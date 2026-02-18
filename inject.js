// VidSniff - Page-context script (inject.js)
// Intercepts fetch/XHR to catch dynamically loaded stream URLs
// This runs in the PAGE context (not content script context)

(function () {
  "use strict";

  const STREAM_PATTERN =
    /\.(m3u8|mpd|mp4|webm|mkv|avi|mov|flv|wmv|mp3|aac|ogg|flac|m4a|ts)(\?|#|$)/i;

  const BLOCKED = [
    "stripe.com", "stripe.network", "paypal.com",
    "googlesyndication.com", "doubleclick.net",
    "google-analytics.com", "googletagmanager.com",
    "facebook.net", "sentry.io", "hotjar.com",
    "intercom.io", "newrelic.com", "nr-data.net",
    "segment.io", "segment.com", "mixpanel.com",
  ];

  function isBlocked(hostname) {
    return BLOCKED.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  }

  function reportUrl(url, source) {
    try {
      const absolute = new URL(url, document.baseURI).href;
      const hostname = new URL(absolute).hostname.toLowerCase();
      if (isBlocked(hostname)) return;
      if (STREAM_PATTERN.test(absolute)) {
        window.postMessage(
          {
            type: "VIDSNIFF_DETECTED",
            url: absolute,
            source,
          },
          "*"
        );
      }
    } catch {}
  }

  // --- Intercept fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (url) reportUrl(url, "fetch");
    } catch {}
    return originalFetch.apply(this, arguments);
  };

  // --- Intercept XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url) reportUrl(String(url), "xhr");
    } catch {}
    return originalOpen.apply(this, arguments);
  };

  // --- Intercept Media Source Extensions ---
  if (window.MediaSource) {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      try {
        window.postMessage(
          {
            type: "VIDSNIFF_MSE",
            mime: mimeType,
          },
          "*"
        );
      } catch {}
      return originalAddSourceBuffer.apply(this, arguments);
    };
  }

  // --- Intercept HTMLMediaElement.src setter ---
  const videoProto = HTMLVideoElement.prototype;
  const audioProto = HTMLAudioElement.prototype;

  for (const proto of [videoProto, audioProto]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src") ||
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (descriptor && descriptor.set) {
      const originalSet = descriptor.set;
      Object.defineProperty(proto, "src", {
        ...descriptor,
        set(value) {
          try {
            if (value) reportUrl(String(value), "media-src");
          } catch {}
          return originalSet.call(this, value);
        },
      });
    }
  }
})();

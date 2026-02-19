// VidSniff - Page-context script (inject.js)
// Intercepts fetch/XHR to catch dynamically loaded stream URLs
// Also scans response bodies (JSON/text) for video URLs hidden in API responses
// This runs in the PAGE context (not content script context)

(function () {
  "use strict";

  const log = (...args) => console.debug("[VidSniff:inject]", ...args);

  // Only match actual video/audio/stream file extensions
  const STREAM_PATTERN =
    /\.(m3u8|mpd|mp4|webm|mkv|avi|mov|flv|wmv|mp3|aac|ogg|flac|m4a)(\?|#|$)/i;

  // NON-video extensions to explicitly reject
  const NON_VIDEO_PATTERN =
    /\.(json|js|css|html|htm|xml|txt|svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|vtt|srt|map)(\?|#|$)/i;

  // Video extensions we look for in response bodies
  const VIDEO_EXT_LIST = ["m3u8", "mpd", "mp4", "webm", "mkv", "mov", "flv"];

  // Blocked domain suffixes — kept in sync with background.js
  const BLOCKED_SUFFIXES = [
    ".stripe.com", ".stripe.network",
    ".paypal.com",
    ".googlesyndication.com", ".doubleclick.net",
    ".google-analytics.com", ".googletagmanager.com",
    ".facebook.net",
    ".sentry.io",
    ".hotjar.com",
    ".intercom.io", ".crisp.chat", ".tawk.to",
    ".newrelic.com", ".nr-data.net",
    ".segment.io", ".segment.com",
    ".mixpanel.com", ".amplitude.com",
    ".heapanalytics.com", ".fullstory.com",
    ".mouseflow.com", ".clarity.ms",
    ".adroll.com", ".adsrvr.org",
  ];

  function isBlocked(hostname) {
    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname.endsWith(suffix) || hostname === suffix.substring(1)) {
        return true;
      }
    }
    return false;
  }

  // Track which URLs we already reported to avoid duplicates
  const reportedUrls = new Set();

  function reportUrl(url, source) {
    try {
      const absolute = new URL(url, document.baseURI).href;
      if (reportedUrls.has(absolute)) return;

      const hostname = new URL(absolute).hostname.toLowerCase();
      if (isBlocked(hostname)) return;

      // ONLY report if it matches stream/video pattern
      // AND does NOT match non-video pattern
      if (STREAM_PATTERN.test(absolute) && !NON_VIDEO_PATTERN.test(absolute)) {
        reportedUrls.add(absolute);
        log("detected:", source, absolute);
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

  // --- Scan response body for hidden video URLs ---
  function scanResponseBody(text, requestUrl, source) {
    try {
      if (!text || text.length < 20) return;
      // Don't scan huge responses (>2MB)
      if (text.length > 2 * 1024 * 1024) return;

      // --- LOOM GRAPHQL: Parse structured JSON for the MAIN video URL ---
      // Loom's GetVideoSource returns the real video in data.getVideo.nullableRawCdnUrl.url
      // We must use ONLY that field — blind URL scanning picks up intro/preview URLs too
      if (requestUrl && requestUrl.includes("/graphql")) {
        try {
          const json = JSON.parse(text);
          // GetVideoSource response
          const rawCdnUrl = json?.data?.getVideo?.nullableRawCdnUrl?.url;
          if (rawCdnUrl) {
            reportUrl(rawCdnUrl, source + "-graphql");
            return; // Don't scan generically — we got the authoritative URL
          }
          // Also check array responses (batched GraphQL)
          if (Array.isArray(json)) {
            for (const item of json) {
              const url = item?.data?.getVideo?.nullableRawCdnUrl?.url;
              if (url) {
                reportUrl(url, source + "-graphql");
                return;
              }
            }
          }
        } catch {} // Not valid JSON or different structure, fall through
      }

      // --- GENERIC: Scan for video URLs in response text ---
      // Unescape JSON encoding first
      let cleaned = text;
      cleaned = cleaned.replace(/\\u002[Ff]/g, "/");
      cleaned = cleaned.replace(/\\\//g, "/");

      // Find all http(s) URLs in the cleaned text
      const urlPattern = /https?:\/\/[^\s"'<>\]},]+/gi;
      const allUrls = cleaned.match(urlPattern);
      if (!allUrls) return;

      const seen = new Set();
      for (let rawUrl of allUrls) {
        // Remove trailing quotes or punctuation
        rawUrl = rawUrl.replace(/[\\",;)\]}>]+$/, "");

        // Check if URL has a video extension
        const hasVideoExt = VIDEO_EXT_LIST.some((ext) => {
          const re = new RegExp("\\." + ext + "([?#]|$)", "i");
          return re.test(rawUrl);
        });
        if (!hasVideoExt) continue;

        if (seen.has(rawUrl)) continue;
        seen.add(rawUrl);

        try {
          const absolute = new URL(rawUrl, document.baseURI).href;
          // Skip .ts segments to avoid noise
          if (/\.ts(\?|#|$)/i.test(absolute)) continue;
          reportUrl(absolute, source);
        } catch {}
      }
    } catch {}
  }

  // Check if a request URL is a known video API endpoint worth scanning
  function isVideoApiEndpoint(url) {
    try {
      const urlObj = new URL(url);
      const host = urlObj.hostname.toLowerCase();
      const path = urlObj.pathname.toLowerCase();

      // GraphQL endpoints (Loom, etc.)
      if (path.includes("/graphql")) return true;
      // oEmbed endpoints
      if (path.includes("/oembed")) return true;
      // Player config endpoints
      if (path.includes("/player/config")) return true;
      // Loom-specific API endpoints
      if (host.includes("loom.com") && path.includes("/v1/")) return true;
      // Vimeo config
      if (host.includes("vimeo.com") && path.includes("/video/")) return true;
      // Wistia
      if (host.includes("wistia.com") && path.includes("/embed/")) return true;

      return false;
    } catch {
      return false;
    }
  }

  // --- Intercept fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let reqUrl;
    try {
      reqUrl = typeof input === "string" ? input : input?.url;
      if (reqUrl) reportUrl(reqUrl, "fetch");
    } catch {}

    const result = originalFetch.apply(this, arguments);

    // Scan response body for video URLs — ONLY for specific API endpoints
    try {
      if (reqUrl && isVideoApiEndpoint(reqUrl)) {
        result.then((response) => {
          try {
            if (response.ok) {
              const clone = response.clone();
              clone.text().then((body) => {
                scanResponseBody(body, reqUrl, "fetch-response");
              }).catch(() => {});
            }
          } catch {}
        }).catch(() => {});
      }
    } catch {}

    return result;
  };

  // --- Intercept XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url) {
        this._vidsniffUrl = String(url);
        reportUrl(String(url), "xhr");
      }
    } catch {}
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    const xhrUrl = xhr._vidsniffUrl;

    // Scan response body ONLY for specific API endpoints
    try {
      if (xhrUrl && isVideoApiEndpoint(xhrUrl)) {
        xhr.addEventListener("load", function () {
          try {
            if (xhr.status >= 200 && xhr.status < 300) {
              const body = xhr.responseText;
              if (body) {
                scanResponseBody(body, xhrUrl, "xhr-response");
              }
            }
          } catch {}
        });
      }
    } catch {}

    return originalXHRSend.apply(this, arguments);
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

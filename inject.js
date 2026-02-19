// VidSniff - Page-context script (inject.js)
// Intercepts fetch/XHR to catch dynamically loaded stream URLs
// Also scans response bodies (JSON/text) for video URLs hidden in API responses
// This runs in the PAGE context (not content script context)

(function () {
  "use strict";

  const STREAM_PATTERN =
    /\.(m3u8|mpd|mp4|webm|mkv|avi|mov|flv|wmv|mp3|aac|ogg|flac|m4a|ts)(\?|#|$)/i;

  // Pattern to find video URLs inside JSON/text response bodies
  const URL_IN_BODY_PATTERN =
    /https?:\/\/[^\s"'\\<>]+?\.(m3u8|mpd|mp4|webm|mkv|mov|flv|mp3|aac|ogg|flac|m4a)(?:[?#][^\s"'\\<>]*)?/gi;

  // Known API endpoints that return video URLs in their response body
  const API_ENDPOINTS = [
    "/graphql",       // Loom, many modern sites
    "/api/",          // Generic REST APIs
    "/v1/",           // Versioned APIs
    "/v2/",
    "/v3/",
    "/oembed",        // oEmbed endpoints
    "/embed/",        // Embed endpoints
    "/player/",       // Player config endpoints
  ];

  // Known video CDN domains — URLs from these are always worth reporting
  const VIDEO_CDN_DOMAINS = [
    "loom.com", "cdn.loom.com", "luna.loom.com", "loomcdn.com",
    "vimeo.com", "vimeocdn.com", "player.vimeo.com",
    "googlevideo.com",
    "cloudfront.net", "d2eebagvwr542c.cloudfront.net",
    "akamaized.net", "fastly.net",
    "mux.com", "stream.mux.com",
    "cloudflarestream.com",
    "wistia.com", "fast.wistia.com",
    "brightcove.com", "brightcovecdn.com",
    "jwplayer.com", "jwpcdn.com", "jwplatform.com",
    "vidyard.com",
    "flowplayer.com",
    "bitmovin.com",
    "s3.amazonaws.com", "s3-accelerate.amazonaws.com",
  ];

  function isBlocked(hostname) {
    return (
      hostname.endsWith(".stripe.com") || hostname === "stripe.com" ||
      hostname.endsWith(".stripe.network") || hostname === "stripe.network" ||
      hostname.endsWith(".paypal.com") ||
      hostname.endsWith(".doubleclick.net") ||
      hostname.endsWith(".googlesyndication.com") ||
      hostname.endsWith(".google-analytics.com") ||
      hostname.endsWith(".sentry.io") ||
      hostname.endsWith(".nr-data.net") ||
      hostname.endsWith(".newrelic.com")
    );
  }

  function isVideoCdnUrl(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return VIDEO_CDN_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d)
      );
    } catch {
      return false;
    }
  }

  // Track which URLs we already reported to avoid duplicates
  const reportedUrls = new Set();

  function reportUrl(url, source) {
    try {
      const absolute = new URL(url, document.baseURI).href;
      if (reportedUrls.has(absolute)) return;

      const hostname = new URL(absolute).hostname.toLowerCase();
      if (isBlocked(hostname)) return;

      // Report if it matches stream pattern OR is from a known video CDN
      if (STREAM_PATTERN.test(absolute) || isVideoCdnUrl(absolute)) {
        reportedUrls.add(absolute);
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
      // Don't scan huge responses (>2MB) — likely not API responses
      if (text.length > 2 * 1024 * 1024) return;

      // Find all URLs that look like video streams
      const matches = text.match(URL_IN_BODY_PATTERN);
      if (!matches) return;

      const seen = new Set();
      for (let rawUrl of matches) {
        // Clean up escaped URLs from JSON
        rawUrl = rawUrl.replace(/\\u002F/g, "/");
        rawUrl = rawUrl.replace(/\\\//g, "/");
        rawUrl = rawUrl.replace(/\\"/g, "");
        // Remove trailing punctuation that might have been captured
        rawUrl = rawUrl.replace(/[,;)\]}>]+$/, "");

        if (seen.has(rawUrl)) continue;
        seen.add(rawUrl);

        try {
          const absolute = new URL(rawUrl, document.baseURI).href;
          // Skip .ts segments to avoid noise — we want manifests and full files
          if (/\.ts(\?|#|$)/i.test(absolute)) continue;
          reportUrl(absolute, source);
        } catch {}
      }
    } catch {}
  }

  // Check if a request URL looks like an API endpoint worth scanning
  function isApiEndpoint(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.toLowerCase();
      return API_ENDPOINTS.some((ep) => path.includes(ep));
    } catch {
      return false;
    }
  }

  // Check if response content-type is JSON or text
  function isJsonOrTextResponse(contentType) {
    if (!contentType) return false;
    return (
      contentType.includes("application/json") ||
      contentType.includes("text/") ||
      contentType.includes("application/javascript")
    );
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

    // Scan response body for video URLs
    try {
      if (reqUrl) {
        result.then((response) => {
          try {
            // Only scan API responses or same/video-CDN domain responses
            const ct = response.headers?.get("content-type") || "";
            const shouldScan =
              isApiEndpoint(reqUrl) ||
              isJsonOrTextResponse(ct);

            if (shouldScan && response.ok) {
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

    // Add load listener to scan response body
    try {
      if (xhrUrl) {
        xhr.addEventListener("load", function () {
          try {
            const ct = xhr.getResponseHeader("content-type") || "";
            const shouldScan =
              isApiEndpoint(xhrUrl) ||
              isJsonOrTextResponse(ct);

            if (shouldScan && xhr.status >= 200 && xhr.status < 300) {
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

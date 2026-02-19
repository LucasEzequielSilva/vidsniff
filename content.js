// VidSniff - Content Script (content.js)
// DOM scanning + JS hooking bridge + metadata extraction

(function () {
  "use strict";

  const STREAM_PATTERN =
    /\.(m3u8|mpd|mp4|webm|mkv|avi|mov|flv|wmv|mp3|aac|ogg|flac|m4a)(\?|#|$)/i;

  function isBlockedUrl(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      // Block stripe and other non-video domains
      if (
        hostname.endsWith(".stripe.com") || hostname === "stripe.com" ||
        hostname.endsWith(".stripe.network") || hostname === "stripe.network" ||
        hostname.endsWith(".paypal.com") ||
        hostname.endsWith(".doubleclick.net") ||
        hostname.endsWith(".googlesyndication.com") ||
        hostname.endsWith(".google-analytics.com") ||
        hostname.endsWith(".sentry.io") ||
        hostname.endsWith(".hotjar.com") ||
        hostname.endsWith(".intercom.io") ||
        hostname.endsWith(".nr-data.net") ||
        hostname.endsWith(".newrelic.com")
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  let reportedUrls = new Set();
  let pageMetadata = null;
  let lastUrl = location.href;

  // --- SPA URL change detection ---
  // Skool and similar SPAs change URL via pushState without full navigation

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Reset everything for the new "page"
      reportedUrls = new Set();
      pageMetadata = null;
      // Give the new page content time to load
      setTimeout(scanMediaElements, 1000);
      setTimeout(scanMediaElements, 3000);
    }
  }

  // Poll for URL changes (catches pushState, replaceState, and hash changes)
  setInterval(checkUrlChange, 800);
  window.addEventListener("popstate", checkUrlChange);

  // --- Extract page metadata for meaningful names ---

  function getPageMetadata() {
    if (pageMetadata && pageMetadata.pageUrl === location.href) {
      return pageMetadata;
    }

    // Force re-read for current page
    const title =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title ||
      "Untitled";

    const thumbnail =
      document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[name="twitter:image"]')?.content ||
      document.querySelector('meta[property="og:image:secure_url"]')?.content ||
      null;

    const siteName =
      document.querySelector('meta[property="og:site_name"]')?.content ||
      location.hostname.replace(/^www\./, "");

    pageMetadata = {
      title: title.substring(0, 120),
      thumbnail,
      siteName,
      pageUrl: location.href,
    };

    return pageMetadata;
  }

  // --- Extract thumbnail from video elements ---

  function getVideoThumbnail(videoEl) {
    if (!videoEl) return null;

    // Check poster attribute
    if (videoEl.poster) return videoEl.poster;

    // Check parent containers for background images
    const container = videoEl.closest(
      "[data-poster], [style*='background-image']"
    );
    if (container) {
      const bg = getComputedStyle(container).backgroundImage;
      const match = bg?.match(/url\(["']?(.+?)["']?\)/);
      if (match) return match[1];
    }

    // Try to capture a frame from the video itself
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(videoEl.videoWidth, 320);
        canvas.height = Math.round(
          (canvas.width * videoEl.videoHeight) / videoEl.videoWidth
        );
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.6);
      }
    } catch {}

    return null;
  }

  // --- Get duration from video element ---

  function getVideoDuration(videoEl) {
    if (!videoEl) return null;
    const dur = videoEl.duration;
    // Only return if it's a real duration (> 1 second, finite)
    if (dur && isFinite(dur) && dur > 1) {
      return Math.round(dur);
    }
    return null;
  }

  function reportUrl(url, source, extraMeta) {
    if (!url || reportedUrls.has(url)) return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (isBlockedUrl(url)) return;

    reportedUrls.add(url);

    const meta = getPageMetadata();

    chrome.runtime.sendMessage({
      action: "addStream",
      url,
      source,
      pageTitle: meta.title,
      pageThumbnail: meta.thumbnail,
      siteName: meta.siteName,
      pageUrl: meta.pageUrl,
      ...(extraMeta || {}),
    });
  }

  // --- DOM Scanning ---

  function scanMediaElements() {
    // Always re-read metadata fresh
    pageMetadata = null;
    getPageMetadata();

    const selectors = "video, audio, video source, audio source";
    const elements = document.querySelectorAll(selectors);

    for (const el of elements) {
      const src = el.currentSrc || el.src || el.getAttribute("src");
      if (src && STREAM_PATTERN.test(src)) {
        try {
          const absolute = new URL(src, document.baseURI).href;
          if (isBlockedUrl(absolute)) continue;

          const videoEl =
            el.tagName === "VIDEO"
              ? el
              : el.tagName === "SOURCE"
                ? el.closest("video")
                : null;

          const extraMeta = {};
          if (videoEl) {
            const thumb = getVideoThumbnail(videoEl);
            if (thumb) extraMeta.videoThumbnail = thumb;
            const dur = getVideoDuration(videoEl);
            if (dur) extraMeta.duration = dur;
          }

          reportUrl(absolute, "dom", extraMeta);
        } catch {}
      }
    }

    // Check <video>/<audio> elements with currentSrc
    for (const video of document.querySelectorAll("video, audio")) {
      if (video.currentSrc && STREAM_PATTERN.test(video.currentSrc)) {
        try {
          const absolute = new URL(video.currentSrc, document.baseURI).href;
          if (isBlockedUrl(absolute)) continue;

          const extraMeta = {};
          if (video.tagName === "VIDEO") {
            const thumb = getVideoThumbnail(video);
            if (thumb) extraMeta.videoThumbnail = thumb;
            const dur = getVideoDuration(video);
            if (dur) extraMeta.duration = dur;
          }
          reportUrl(absolute, "dom", extraMeta);
        } catch {}
      }
    }

    // Send thumbnail/duration update for streams detected via network
    sendThumbnailUpdate();
  }

  // --- Send thumbnail update for streams detected via network ---

  function sendThumbnailUpdate() {
    const meta = getPageMetadata();
    const videos = document.querySelectorAll("video");
    let bestThumb = meta.thumbnail;
    let bestDuration = null;

    for (const v of videos) {
      const t = getVideoThumbnail(v);
      if (t) {
        bestThumb = t;
        break;
      }
    }

    for (const v of videos) {
      const d = getVideoDuration(v);
      if (d) {
        bestDuration = d;
        break;
      }
    }

    chrome.runtime.sendMessage({
      action: "updateTabMetadata",
      thumbnail: bestThumb,
      duration: bestDuration,
      pageTitle: meta.title,
      siteName: meta.siteName,
    });
  }

  // --- MutationObserver for SPA/dynamic content ---

  let scanTimeout = null;
  function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(scanMediaElements, 500);
  }

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (
            node.tagName === "VIDEO" ||
            node.tagName === "AUDIO" ||
            node.tagName === "SOURCE" ||
            node.querySelector?.("video, audio, source")
          ) {
            shouldScan = true;
            break;
          }
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) debouncedScan();
  });

  // --- Inject page-context script for fetch/XHR interception ---

  function injectPageScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(
      script
    );
  }

  // --- Listen for messages from injected page script ---

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "VIDSNIFF_DETECTED") {
      reportUrl(event.data.url, event.data.source || "inject");
    }
  });

  // --- Listen for messages from popup/background ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "captureVideoThumbnail") {
      const videos = document.querySelectorAll("video");
      let thumbnail = null;

      for (const v of videos) {
        thumbnail = getVideoThumbnail(v);
        if (thumbnail) break;
      }

      if (!thumbnail) {
        thumbnail = getPageMetadata().thumbnail;
      }

      sendResponse({ thumbnail });
    }

    if (message.action === "getPageMetadata") {
      pageMetadata = null; // Force fresh read
      const meta = getPageMetadata();
      const videos = document.querySelectorAll("video");
      let thumb = meta.thumbnail;
      let duration = null;

      for (const v of videos) {
        const t = getVideoThumbnail(v);
        if (t) {
          thumb = t;
          break;
        }
      }

      for (const v of videos) {
        const d = getVideoDuration(v);
        if (d) {
          duration = d;
          break;
        }
      }

      sendResponse({
        ...meta,
        thumbnail: thumb,
        duration,
      });
    }
  });

  // --- Init ---

  if (document.documentElement) {
    injectPageScript();
  } else {
    const domObserver = new MutationObserver(() => {
      if (document.documentElement) {
        domObserver.disconnect();
        injectPageScript();
      }
    });
    domObserver.observe(document, { childList: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanMediaElements();
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  } else {
    scanMediaElements();
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // Re-scan periodically for lazy-loaded content
  setTimeout(scanMediaElements, 3000);
  setTimeout(scanMediaElements, 8000);
  setTimeout(scanMediaElements, 15000);
})();

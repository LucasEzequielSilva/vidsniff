// VidSniff - Service Worker (background.js)
// Network request monitoring for video/audio stream detection

importScripts("hls-downloader.js");

// Debug logging — visible in DevTools when "Verbose" log level is enabled
const log = (...args) => console.debug("[VidSniff:bg]", ...args);

const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|flv|wmv)(\?|#|$)/i;
const HLS_EXTENSIONS = /\.(m3u8)(\?|#|$)/i;
const DASH_EXTENSIONS = /\.(mpd)(\?|#|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|aac|ogg|flac|m4a|opus|wav)(\?|#|$)/i;
const SEGMENT_EXTENSIONS = /\.(ts|m4s)(\?|#|$)/i;

const VIDEO_MIMES = /^video\//i;
const AUDIO_MIMES = /^audio\//i;
const HLS_MIMES = /^application\/(vnd\.apple\.mpegurl|x-mpegurl)/i;
const DASH_MIMES = /^application\/dash\+xml/i;

// Minimum size to filter out tracking pixels and tiny files (10KB)
const MIN_SIZE_BYTES = 10240;

// Max cached request headers per tab (oldest evicted first)
const MAX_HEADERS_CACHE = 500;

// --- Domain blocklist ---
// These domains serve non-video content that happens to match video patterns
// (Stripe uses .m3u8 internally for their fraud detection JS, etc.)
const BLOCKED_DOMAINS = new Set([
  "js.stripe.com",
  "m.stripe.network",
  "r.stripe.com",
  "q.stripe.com",
  "api.stripe.com",
  "checkout.stripe.com",
  "hooks.stripe.com",
  "errors.stripe.com",
]);

// Partial matches (any subdomain under these)
const BLOCKED_DOMAIN_SUFFIXES = [
  ".stripe.com",
  ".stripe.network",
  ".paypal.com",
  ".googlesyndication.com",
  ".doubleclick.net",
  ".google-analytics.com",
  ".googletagmanager.com",
  ".facebook.net",
  ".sentry.io",
  ".hotjar.com",
  ".intercom.io",
  ".crisp.chat",
  ".tawk.to",
  ".newrelic.com",
  ".nr-data.net",
  ".segment.io",
  ".segment.com",
  ".mixpanel.com",
  ".amplitude.com",
  ".heapanalytics.com",
  ".fullstory.com",
  ".mouseflow.com",
  ".clarity.ms",
  ".adroll.com",
  ".adsrvr.org",
];

// Whitelist: CDN domains that ARE legitimate video hosts
const VIDEO_DOMAIN_WHITELIST = [
  "loom.com",
  "cdn.loom.com",
  "luna.loom.com",
  "loomcdn.com",
  "vimeo.com",
  "player.vimeo.com",
  "vimeocdn.com",
  "youtube.com",
  "googlevideo.com",
  "cloudfront.net",
  "d2eebagvwr542c.cloudfront.net",
  "akamaized.net",
  "fastly.net",
  "cdn.jwplayer.com",
  "bitmovin.com",
  "mux.com",
  "stream.mux.com",
  "cloudflarestream.com",
  "vidyard.com",
  "wistia.com",
  "fast.wistia.com",
  "brightcove.com",
  "brightcovecdn.com",
  "jwpcdn.com",
  "jwplatform.com",
  "flowplayer.com",
  "s3.amazonaws.com",
  "s3-accelerate.amazonaws.com",
];

function isBlockedDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Never block known video hosts
    if (VIDEO_DOMAIN_WHITELIST.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    )) {
      return false;
    }

    // Check exact matches
    if (BLOCKED_DOMAINS.has(hostname)) return true;

    // Check suffix matches
    for (const suffix of BLOCKED_DOMAIN_SUFFIXES) {
      if (hostname.endsWith(suffix) || hostname === suffix.substring(1)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Per-tab detected streams
const tabStreams = new Map();
// Per-tab request headers cache
const tabHeaders = new Map();
// Per-tab metadata (page title, thumbnail, etc.)
const tabMeta = new Map();
// Per-tab URL tracking (to detect SPA navigation)
const tabUrls = new Map();

// --- HLS & DASH Downloaders ---
const hlsDownloader = new HLSDownloader();
const dashDownloader = new DASHDownloader();

// --- Classification ---

function isVideoCdnDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return VIDEO_DOMAIN_WHITELIST.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

function classifyByUrl(url) {
  try {
    const path = new URL(url).pathname;
    if (VIDEO_EXTENSIONS.test(path)) return "video";
    if (HLS_EXTENSIONS.test(path)) return "hls";
    if (DASH_EXTENSIONS.test(path)) return "mpd";
    if (AUDIO_EXTENSIONS.test(path)) return "audio";
    if (SEGMENT_EXTENSIONS.test(path)) return "segment";
  } catch {}
  return null;
}

function classifyByMime(contentType) {
  if (!contentType) return null;
  if (VIDEO_MIMES.test(contentType)) return "video";
  if (HLS_MIMES.test(contentType)) return "hls";
  if (DASH_MIMES.test(contentType)) return "mpd";
  if (AUDIO_MIMES.test(contentType)) return "audio";
  return null;
}

function getExtension(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function getFilename(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/");
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}

// --- Smart naming ---

function deriveStreamName(url, tabId, type) {
  const meta = tabMeta.get(tabId);
  const pageTitle = meta?.pageTitle;

  if (pageTitle && pageTitle !== "Untitled") {
    const cleanTitle = pageTitle
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 80);

    const ext = getExtension(url) || typeToExt(type);
    return `${cleanTitle}.${ext}`;
  }

  return prettifyFilename(getFilename(url));
}

function typeToExt(type) {
  const map = { video: "mp4", hls: "m3u8", mpd: "mpd", audio: "mp3", segment: "ts" };
  return map[type] || "mp4";
}

function prettifyFilename(filename) {
  if (!filename || filename === "unknown") return "Untitled";
  let pretty = filename.replace(/[a-f0-9]{32,}/gi, "");
  pretty = pretty.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    ""
  );
  pretty = pretty.replace(/^[-_.\s]+|[-_.\s]+$/g, "").replace(/[-_]{2,}/g, "-");
  if (!pretty || pretty.length < 3) return filename;
  return pretty;
}

// --- Stream domain helpers ---

function getStreamSiteName(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Map CDN hostnames to friendly names
    if (hostname.includes("loom")) return "Loom";
    if (hostname.includes("vimeo")) return "Vimeo";
    if (hostname.includes("youtube") || hostname.includes("googlevideo")) return "YouTube";
    if (hostname.includes("wistia")) return "Wistia";
    if (hostname.includes("mux.com")) return "Mux";
    return hostname.replace(/^(www|cdn|player)\./, "");
  } catch {
    return "";
  }
}

// --- Stream Storage ---

function getTabData(tabId) {
  if (!tabStreams.has(tabId)) {
    tabStreams.set(tabId, new Map());
  }
  return tabStreams.get(tabId);
}

// Non-video file extensions that should never be treated as streams
const REJECT_EXTENSIONS = /\.(json|js|css|html|htm|xml|txt|svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|vtt|srt|map|php|asp|aspx)(\?|#|$)/i;

function addStream(tabId, streamInfo) {
  const streams = getTabData(tabId);
  const url = streamInfo.url;

  // Skip invalid URLs
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;
  if (url.startsWith("chrome-extension://")) return;
  if (isBlockedDomain(url)) {
    log("blocked domain:", url);
    return;
  }

  // Reject non-video file types
  try {
    const path = new URL(url).pathname;
    if (REJECT_EXTENSIONS.test(path)) return;
  } catch {}

  // Deduplicate
  if (streams.has(url)) {
    const existing = streams.get(url);
    if (streamInfo.videoThumbnail && !existing.thumbnail) {
      existing.thumbnail = streamInfo.videoThumbnail;
    }
    if (streamInfo.duration && !existing.duration) {
      existing.duration = streamInfo.duration;
    }
    // Always update displayName from latest metadata
    const meta = tabMeta.get(tabId);
    if (meta?.pageTitle && meta.pageTitle !== "Untitled") {
      existing.displayName = deriveStreamName(url, tabId, existing.type);
    }
    streams.set(url, existing);
    return;
  }

  // Set display name and site
  streamInfo.displayName = deriveStreamName(url, tabId, streamInfo.type);
  streamInfo.streamSite = streamInfo.streamSite || getStreamSiteName(url);

  // Attach tab metadata
  const meta = tabMeta.get(tabId);
  if (meta) {
    if (!streamInfo.thumbnail) {
      streamInfo.thumbnail = streamInfo.videoThumbnail || meta.thumbnail || null;
    }
  }

  log("new stream:", streamInfo.type, streamInfo.displayName, url);
  streams.set(url, streamInfo);
  updateBadge(tabId);
  persistTabData(tabId);
}

function removeSegments(tabId) {
  const streams = getTabData(tabId);
  const hasManifest = [...streams.values()].some(
    (s) => s.type === "hls" || s.type === "mpd"
  );

  if (hasManifest) {
    for (const [url, info] of streams) {
      if (info.type === "segment") {
        streams.delete(url);
      }
    }
    updateBadge(tabId);
    persistTabData(tabId);
  }
}

async function persistTabData(tabId) {
  try {
    const streams = getTabData(tabId);
    const data = Object.fromEntries(streams);
    const meta = tabMeta.get(tabId) || {};
    await chrome.storage.session.set({
      [`tab_${tabId}`]: data,
      [`meta_${tabId}`]: meta,
    });
  } catch {}
}

async function loadTabData(tabId) {
  try {
    const result = await chrome.storage.session.get([
      `tab_${tabId}`,
      `meta_${tabId}`,
    ]);
    if (result[`tab_${tabId}`]) {
      tabStreams.set(tabId, new Map(Object.entries(result[`tab_${tabId}`])));
    }
    if (result[`meta_${tabId}`]) {
      tabMeta.set(tabId, result[`meta_${tabId}`]);
    }
  } catch {}
}

function clearTabData(tabId) {
  tabStreams.delete(tabId);
  tabHeaders.delete(tabId);
  tabMeta.delete(tabId);
  chrome.storage.session.remove([`tab_${tabId}`, `meta_${tabId}`]).catch(() => {});
  updateBadge(tabId);
}

// --- Badge ---

function updateBadge(tabId) {
  const streams = getTabData(tabId);
  let count = 0;
  for (const s of streams.values()) {
    if (s.type !== "segment") count++;
  }
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#6C5CE7", tabId }).catch(() => {});
}

// --- Header Capture ---

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!tabHeaders.has(details.tabId)) {
      tabHeaders.set(details.tabId, new Map());
    }
    const headers = {};
    for (const h of details.requestHeaders || []) {
      headers[h.name.toLowerCase()] = h.value;
    }
    tabHeaders.get(details.tabId).set(details.requestId, headers);

    const cache = tabHeaders.get(details.tabId);
    if (cache.size > MAX_HEADERS_CACHE) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// --- Network Detection: URL-based ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (isBlockedDomain(details.url)) return;
    const type = classifyByUrl(details.url);
    if (!type) return;

    addStream(details.tabId, {
      url: details.url,
      type,
      ext: getExtension(details.url),
      filename: getFilename(details.url),
      source: "network",
      timestamp: Date.now(),
      tabId: details.tabId,
      frameId: details.frameId,
    });
  },
  { urls: ["<all_urls>"] }
);

// --- Network Detection: MIME-based ---

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (isBlockedDomain(details.url)) return;

    const contentTypeHeader = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentLengthHeader = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === "content-length"
    );

    const contentType = contentTypeHeader ? contentTypeHeader.value : null;
    const contentLength = contentLengthHeader
      ? parseInt(contentLengthHeader.value, 10)
      : null;

    if (contentLength !== null && contentLength < MIN_SIZE_BYTES) return;

    const mimeType = classifyByMime(contentType);
    const urlType = classifyByUrl(details.url);
    const type = mimeType || urlType;

    if (!type) return;

    let requestHeaders = {};
    if (tabHeaders.has(details.tabId)) {
      requestHeaders =
        tabHeaders.get(details.tabId).get(details.requestId) || {};
    }

    addStream(details.tabId, {
      url: details.url,
      type,
      ext:
        getExtension(details.url) ||
        (contentType ? contentType.split("/")[1]?.split(";")[0] : ""),
      filename: getFilename(details.url),
      mime: contentType,
      size: contentLength,
      source: "network",
      timestamp: Date.now(),
      tabId: details.tabId,
      referer: requestHeaders["referer"] || "",
      cookie: requestHeaders["cookie"] || "",
      userAgent: requestHeaders["user-agent"] || "",
    });

    if (type === "hls" || type === "mpd") {
      removeSegments(details.tabId);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

// --- Tab Cleanup ---

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabData(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (
    details.transitionType === "auto_subframe" ||
    details.transitionType === "manual_subframe"
  )
    return;
  clearTabData(details.tabId);
});

// SPA navigation (pushState/replaceState)
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  const tabId = details.tabId;
  const oldUrl = tabUrls.get(tabId);
  const newUrl = details.url;

  // Only clear if the URL actually changed meaningfully
  // (ignore hash-only changes)
  if (oldUrl) {
    try {
      const oldPath = new URL(oldUrl).pathname + new URL(oldUrl).search;
      const newPath = new URL(newUrl).pathname + new URL(newUrl).search;
      if (oldPath === newPath) return; // Same page, different hash
    } catch {}
  }

  tabUrls.set(tabId, newUrl);
  clearTabData(tabId);
});

// Track tab URLs
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabUrls.set(tabId, changeInfo.url);
  }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getStreams") {
    const tabId = message.tabId;
    const streams = tabStreams.get(tabId);
    if (streams) {
      const meta = tabMeta.get(tabId) || {};
      sendResponse({ streams: Object.fromEntries(streams), meta });
    } else {
      loadTabData(tabId).then(() => {
        const loaded = tabStreams.get(tabId);
        const meta = tabMeta.get(tabId) || {};
        sendResponse({
          streams: loaded ? Object.fromEntries(loaded) : {},
          meta,
        });
      });
      return true;
    }
  }

  if (message.action === "addStream") {
    const tabId = sender.tab?.id || message.tabId;
    const frameId = sender.frameId;
    if (tabId && tabId >= 0) {
      // Only update page metadata from the TOP FRAME (frameId=0)
      // Iframes (Loom embeds, etc.) have their own titles that are useless
      if (frameId === 0 && (message.pageTitle || message.pageThumbnail)) {
        if (!tabMeta.has(tabId)) tabMeta.set(tabId, {});
        const meta = tabMeta.get(tabId);
        if (message.pageTitle) meta.pageTitle = message.pageTitle;
        if (message.pageThumbnail) meta.thumbnail = message.pageThumbnail;
        if (message.siteName) meta.siteName = message.siteName;
      }

      const streamType = message.type || classifyByUrl(message.url) || "video";

      addStream(tabId, {
        url: message.url,
        type: streamType,
        ext: getExtension(message.url) || typeToExt(streamType),
        filename: getFilename(message.url),
        source: message.source || "content",
        timestamp: Date.now(),
        tabId,
        videoThumbnail: message.videoThumbnail || null,
        duration: message.duration || null,
      });
    }
    sendResponse({ ok: true });
  }

  if (message.action === "updateTabMetadata") {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId && tabId >= 0) {
      if (!tabMeta.has(tabId)) tabMeta.set(tabId, {});
      const meta = tabMeta.get(tabId);
      // Only accept thumbnail and duration from any frame
      if (message.thumbnail) meta.thumbnail = message.thumbnail;
      if (message.duration) meta.duration = message.duration;
      // Only accept page title and site name from the TOP FRAME
      if (frameId === 0) {
        if (message.pageTitle) meta.pageTitle = message.pageTitle;
        if (message.siteName) meta.siteName = message.siteName;
      }

      // Re-derive names for existing streams with fresh metadata
      const streams = tabStreams.get(tabId);
      if (streams) {
        for (const [url, info] of streams) {
          if (!info.thumbnail && meta.thumbnail) {
            info.thumbnail = meta.thumbnail;
          }
          // Do NOT propagate tab-level duration to individual streams
          // Each stream should only show its own real duration
          info.displayName = deriveStreamName(url, tabId, info.type);
        }
        persistTabData(tabId);
      }
    }
    sendResponse({ ok: true });
  }

  if (message.action === "download") {
    chrome.downloads.download(
      { url: message.url, filename: message.filename || undefined },
      (downloadId) => sendResponse({ downloadId })
    );
    return true;
  }

  if (message.action === "hlsProbe") {
    hlsDownloader
      .probeQualities(message.url, message.referer || "")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message, isMaster: false, variants: [] }));
    return true;
  }

  if (message.action === "hlsDownload") {
    const stream = message.stream;
    hlsDownloader
      .startDownload({
        url: stream.url,
        variantUrl: message.variantUrl || null,
        referer: stream.referer || "",
        cookie: stream.cookie || "",
        userAgent: stream.userAgent || "",
        filename: stream.displayName || stream.filename || "video.mp4",
        tabId: stream.tabId,
      })
      .then((downloadId) => sendResponse({ downloadId }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "dashDownload") {
    const stream = message.stream;
    dashDownloader
      .startDownload({
        url: stream.url,
        referer: stream.referer || "",
        filename: stream.displayName || stream.filename || "video.mp4",
        tabId: stream.tabId,
      })
      .then((downloadId) => sendResponse({ downloadId }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "cancelDownload") {
    if (message.downloadId.startsWith("hls_")) {
      hlsDownloader.cancelDownload(message.downloadId);
    } else if (message.downloadId.startsWith("dash_")) {
      dashDownloader.cancelDownload(message.downloadId);
    }
    sendResponse({ ok: true });
  }

  if (message.action === "getDownloadStates") {
    sendResponse({
      hls: hlsDownloader.getAllDownloads(),
      dash: dashDownloader.getAllDownloads(),
    });
  }
});

// --- Service Worker Startup ---

chrome.tabs.query({}, (tabs) => {
  for (const tab of tabs) {
    if (tab.url) tabUrls.set(tab.id, tab.url);
    loadTabData(tab.id).then(() => updateBadge(tab.id));
  }
});

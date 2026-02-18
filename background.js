// VidSniff - Service Worker (background.js)
// Network request monitoring for video/audio stream detection

importScripts("hls-downloader.js");

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

// Domains that are NOT video sources - payment processors, analytics, ads, etc.
const BLOCKED_DOMAINS = [
  "stripe.com",
  "js.stripe.com",
  "m.stripe.network",
  "stripe.network",
  "paypal.com",
  "googlesyndication.com",
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "facebook.com",
  "analytics.",
  "sentry.io",
  "hotjar.com",
  "intercom.io",
  "crisp.chat",
  "tawk.to",
  "newrelic.com",
  "nr-data.net",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "fullstory.com",
  "mouseflow.com",
  "clarity.ms",
  "adroll.com",
  "adsrvr.org",
];

function isBlockedDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

// Per-tab detected streams: { tabId: { url: streamInfo } }
const tabStreams = new Map();
// Per-tab request headers cache: { tabId: { requestId: headers } }
const tabHeaders = new Map();
// Per-tab metadata (page title, thumbnail, etc.)
const tabMeta = new Map();

// --- HLS & DASH Downloaders ---
const hlsDownloader = new HLSDownloader();
const dashDownloader = new DASHDownloader();

// --- Classification ---

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
    const last = parts[parts.length - 1];
    return last || "unknown";
  } catch {
    return "unknown";
  }
}

// --- Smart naming ---

function deriveStreamName(url, tabId, type) {
  const meta = tabMeta.get(tabId);
  const pageTitle = meta?.pageTitle;

  if (pageTitle) {
    const ext = getExtension(url) || type;
    const cleanTitle = pageTitle
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 80);

    if (type === "hls") return `${cleanTitle}.m3u8`;
    if (type === "mpd") return `${cleanTitle}.mpd`;
    if (type === "audio") return `${cleanTitle}.${ext || "mp3"}`;
    return `${cleanTitle}.${ext || "mp4"}`;
  }

  return prettifyFilename(getFilename(url));
}

function prettifyFilename(filename) {
  if (!filename || filename === "unknown") return "Untitled";

  let pretty = filename.replace(/[a-f0-9]{32,}/gi, "");
  pretty = pretty.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    ""
  );
  pretty = pretty
    .replace(/^[-_.\s]+|[-_.\s]+$/g, "")
    .replace(/[-_]{2,}/g, "-");

  if (!pretty || pretty.length < 3) return filename;
  return pretty;
}

// --- Stream Storage ---

function getTabData(tabId) {
  if (!tabStreams.has(tabId)) {
    tabStreams.set(tabId, new Map());
  }
  return tabStreams.get(tabId);
}

function addStream(tabId, streamInfo) {
  const streams = getTabData(tabId);
  const url = streamInfo.url;

  if (streams.has(url)) {
    const existing = streams.get(url);
    if (streamInfo.pageTitle && !existing.pageTitle) {
      existing.pageTitle = streamInfo.pageTitle;
      existing.displayName = deriveStreamName(url, tabId, existing.type);
    }
    if (streamInfo.videoThumbnail && !existing.thumbnail) {
      existing.thumbnail = streamInfo.videoThumbnail;
    }
    if (streamInfo.duration && !existing.duration) {
      existing.duration = streamInfo.duration;
    }
    streams.set(url, existing);
    persistTabData(tabId);
    return;
  }

  if (url.startsWith("data:") || url.startsWith("blob:")) return;
  if (url.startsWith("chrome-extension://")) return;
  if (isBlockedDomain(url)) return;

  streamInfo.displayName = deriveStreamName(url, tabId, streamInfo.type);

  const meta = tabMeta.get(tabId);
  if (meta) {
    if (!streamInfo.thumbnail) {
      streamInfo.thumbnail =
        streamInfo.videoThumbnail || meta.thumbnail || null;
    }
    if (!streamInfo.pageTitle) {
      streamInfo.pageTitle = meta.pageTitle;
    }
    if (!streamInfo.siteName) {
      streamInfo.siteName = meta.siteName;
    }
  }

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
  const streams = getTabData(tabId);
  const data = Object.fromEntries(streams);
  const meta = tabMeta.get(tabId) || {};
  await chrome.storage.session.set({
    [`tab_${tabId}`]: data,
    [`meta_${tabId}`]: meta,
  });
}

async function loadTabData(tabId) {
  const result = await chrome.storage.session.get([
    `tab_${tabId}`,
    `meta_${tabId}`,
  ]);
  const data = result[`tab_${tabId}`];
  const meta = result[`meta_${tabId}`];
  if (data) {
    tabStreams.set(tabId, new Map(Object.entries(data)));
  }
  if (meta) {
    tabMeta.set(tabId, meta);
  }
}

// --- Badge ---

function updateBadge(tabId) {
  const streams = getTabData(tabId);
  let count = 0;
  for (const s of streams.values()) {
    if (s.type !== "segment") count++;
  }
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#6C5CE7", tabId });
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
    if (cache.size > 500) {
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
  tabStreams.delete(tabId);
  tabHeaders.delete(tabId);
  tabMeta.delete(tabId);
  chrome.storage.session.remove([`tab_${tabId}`, `meta_${tabId}`]);
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

// SPA navigation (pushState/replaceState) - critical for sites like Skool
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTabData(details.tabId);
});

function clearTabData(tabId) {
  tabStreams.delete(tabId);
  tabHeaders.delete(tabId);
  tabMeta.delete(tabId);
  chrome.storage.session.remove([`tab_${tabId}`, `meta_${tabId}`]);
  updateBadge(tabId);
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- Get streams for popup ---
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

  // --- Add stream from content script ---
  if (message.action === "addStream") {
    const tabId = sender.tab?.id || message.tabId;
    if (tabId && tabId >= 0) {
      if (message.pageTitle || message.pageThumbnail) {
        if (!tabMeta.has(tabId)) tabMeta.set(tabId, {});
        const meta = tabMeta.get(tabId);
        if (message.pageTitle) meta.pageTitle = message.pageTitle;
        if (message.pageThumbnail) meta.thumbnail = message.pageThumbnail;
        if (message.siteName) meta.siteName = message.siteName;
      }

      addStream(tabId, {
        url: message.url,
        type: message.type || classifyByUrl(message.url) || "video",
        ext: getExtension(message.url),
        filename: getFilename(message.url),
        source: message.source || "content",
        timestamp: Date.now(),
        tabId,
        videoThumbnail: message.videoThumbnail || null,
        duration: message.duration || null,
        pageTitle: message.pageTitle || null,
        siteName: message.siteName || null,
      });
    }
    sendResponse({ ok: true });
  }

  // --- Update tab metadata ---
  if (message.action === "updateTabMetadata") {
    const tabId = sender.tab?.id;
    if (tabId && tabId >= 0) {
      if (!tabMeta.has(tabId)) tabMeta.set(tabId, {});
      const meta = tabMeta.get(tabId);
      if (message.thumbnail) meta.thumbnail = message.thumbnail;
      if (message.duration) meta.duration = message.duration;
      if (message.pageTitle) meta.pageTitle = message.pageTitle;
      if (message.siteName) meta.siteName = message.siteName;

      const streams = tabStreams.get(tabId);
      if (streams) {
        for (const [url, info] of streams) {
          if (!info.thumbnail && meta.thumbnail) {
            info.thumbnail = meta.thumbnail;
          }
          if (!info.duration && meta.duration) {
            info.duration = meta.duration;
          }
          if (!info.displayName || info.displayName === "Untitled") {
            info.displayName = deriveStreamName(url, tabId, info.type);
          }
        }
        persistTabData(tabId);
      }
    }
    sendResponse({ ok: true });
  }

  // --- Direct download ---
  if (message.action === "download") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename || undefined,
      },
      (downloadId) => {
        sendResponse({ downloadId });
      }
    );
    return true;
  }

  // --- HLS Probe (quality selection) ---
  if (message.action === "hlsProbe") {
    hlsDownloader
      .probeQualities(message.url, message.referer || "")
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        sendResponse({ error: err.message, isMaster: false, variants: [] });
      });
    return true;
  }

  // --- HLS Download ---
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
      .then((downloadId) => {
        sendResponse({ downloadId });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  // --- DASH Download ---
  if (message.action === "dashDownload") {
    const stream = message.stream;
    dashDownloader
      .startDownload({
        url: stream.url,
        referer: stream.referer || "",
        filename: stream.displayName || stream.filename || "video.mp4",
        tabId: stream.tabId,
      })
      .then((downloadId) => {
        sendResponse({ downloadId });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  // --- Cancel download ---
  if (message.action === "cancelDownload") {
    if (message.downloadId.startsWith("hls_")) {
      hlsDownloader.cancelDownload(message.downloadId);
    } else if (message.downloadId.startsWith("dash_")) {
      dashDownloader.cancelDownload(message.downloadId);
    }
    sendResponse({ ok: true });
  }

  // --- Get download states ---
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
    loadTabData(tab.id).then(() => updateBadge(tab.id));
  }
});

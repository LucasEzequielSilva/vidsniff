// VidSniff - Popup Script (popup.js)

const streamsContainer = document.getElementById("streams");
const emptyState = document.getElementById("empty");
const copyAllBtn = document.getElementById("copyAll");
const refreshBtn = document.getElementById("refresh");
const toast = document.getElementById("toast");

let currentStreams = {};
let currentTab = null;
let activeDownloads = {}; // { downloadId: { state, progress, ... } }

// --- Init ---

async function init() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) return;
  currentTab = tab;

  // Get active download states
  chrome.runtime.sendMessage({ action: "getDownloadStates" }, (dlStates) => {
    if (dlStates) {
      Object.assign(activeDownloads, dlStates.hls || {});
      Object.assign(activeDownloads, dlStates.dash || {});
    }
  });

  chrome.runtime.sendMessage(
    { action: "getStreams", tabId: tab.id },
    (response) => {
      if (response && response.streams) {
        currentStreams = response.streams;
        render(currentStreams, response.meta || {});
      } else {
        showEmpty();
      }
    }
  );
}

// --- Listen for download progress ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "hlsProgress" || message.action === "dashProgress") {
    activeDownloads[message.downloadId] = message;
    // Update the progress bar in the UI
    updateProgressUI(message.downloadId, message);
  }
});

function updateProgressUI(downloadId, state) {
  const progressEl = document.querySelector(
    `[data-download-id="${downloadId}"]`
  );
  if (!progressEl) return;

  const bar = progressEl.querySelector(".progress-fill");
  const text = progressEl.querySelector(".progress-text");
  const cancelBtn = progressEl.querySelector(".btn-cancel");

  if (bar) bar.style.width = `${state.progress}%`;

  if (text) {
    if (state.state === "parsing") {
      text.textContent = "Parsing playlist...";
    } else if (state.state === "downloading") {
      const pct = state.progress;
      const mb = (state.totalBytes / (1024 * 1024)).toFixed(1);
      text.textContent = `Downloading ${state.downloadedSegments}/${state.totalSegments} segments (${mb} MB) - ${pct}%`;
    } else if (state.state === "merging") {
      text.textContent = "Merging segments...";
    } else if (state.state === "done") {
      text.textContent = "Download complete!";
      bar.style.width = "100%";
      bar.classList.add("done");
      if (cancelBtn) cancelBtn.hidden = true;
      // Remove progress after delay
      setTimeout(() => {
        progressEl.classList.add("fade-out");
        setTimeout(() => progressEl.remove(), 300);
      }, 3000);
    } else if (state.state === "error") {
      text.textContent = `Error: ${state.error}`;
      bar.classList.add("error");
      if (cancelBtn) cancelBtn.hidden = true;
    } else if (state.state === "cancelled") {
      text.textContent = "Cancelled";
      if (cancelBtn) cancelBtn.hidden = true;
      setTimeout(() => progressEl.remove(), 1000);
    }
  }
}

// --- Render ---

function render(streams, meta) {
  const entries = Object.values(streams);

  const hasManifest = entries.some(
    (s) => s.type === "hls" || s.type === "mpd"
  );
  const filtered = hasManifest
    ? entries.filter((s) => s.type !== "segment")
    : entries;

  if (filtered.length === 0) {
    showEmpty();
    return;
  }

  emptyState.hidden = true;
  copyAllBtn.style.display = "";
  streamsContainer.innerHTML = "";

  const groups = {
    video: { title: "Video", items: [] },
    hls: { title: "HLS Streams", items: [] },
    mpd: { title: "DASH Streams", items: [] },
    audio: { title: "Audio", items: [] },
    segment: { title: "Segments", items: [] },
  };

  for (const stream of filtered) {
    const group = groups[stream.type] || groups.video;
    group.items.push(stream);
  }

  for (const [type, group] of Object.entries(groups)) {
    if (group.items.length === 0) continue;

    const groupEl = document.createElement("div");
    groupEl.className = "group";

    const titleEl = document.createElement("div");
    titleEl.className = "group-title";
    titleEl.textContent = `${group.title} (${group.items.length})`;
    groupEl.appendChild(titleEl);

    for (const stream of group.items) {
      groupEl.appendChild(createStreamItem(stream, type, meta));
    }

    streamsContainer.appendChild(groupEl);
  }
}

function createStreamItem(stream, type, meta) {
  const item = document.createElement("div");
  item.className = "stream-item";

  // --- Thumbnail ---
  const thumbEl = document.createElement("div");
  thumbEl.className = "stream-thumb";

  const thumbnail = stream.thumbnail || meta?.thumbnail;
  if (thumbnail) {
    const img = document.createElement("img");
    img.src = thumbnail;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => {
      img.remove();
      thumbEl.appendChild(createThumbPlaceholder(type));
    };
    thumbEl.appendChild(img);
  } else {
    thumbEl.appendChild(createThumbPlaceholder(type));
  }

  // Type overlay on thumbnail
  const typeOverlay = document.createElement("span");
  typeOverlay.className = `type-overlay ${type}`;
  typeOverlay.textContent = stream.ext?.toUpperCase() || type.toUpperCase();
  thumbEl.appendChild(typeOverlay);

  // Duration badge
  const duration = stream.duration || meta?.duration;
  if (duration) {
    const durBadge = document.createElement("span");
    durBadge.className = "duration-badge";
    durBadge.textContent = formatDuration(duration);
    thumbEl.appendChild(durBadge);
  }

  item.appendChild(thumbEl);

  // --- Info column ---
  const infoEl = document.createElement("div");
  infoEl.className = "stream-info";

  // Title
  const titleEl = document.createElement("div");
  titleEl.className = "stream-title";
  const displayName =
    stream.displayName ||
    stream.pageTitle ||
    prettifyFilename(stream.filename) ||
    "Untitled";
  titleEl.textContent = displayName;
  titleEl.title = stream.url;
  infoEl.appendChild(titleEl);

  // Meta row
  const metaRow = document.createElement("div");
  metaRow.className = "stream-meta-row";

  const site = stream.streamSite || extractDomain(stream.url);
  if (site) {
    const siteEl = document.createElement("span");
    siteEl.className = "stream-site";
    siteEl.textContent = site;
    metaRow.appendChild(siteEl);
  }

  if (stream.size) {
    const sizeEl = document.createElement("span");
    sizeEl.className = "stream-size";
    sizeEl.textContent = formatSize(stream.size);
    metaRow.appendChild(sizeEl);
  }

  infoEl.appendChild(metaRow);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "stream-actions";

  // Download button - works for ALL types now
  if (type === "video" || type === "audio") {
    actions.appendChild(
      createButton("Download", "btn-download", () => downloadDirect(stream))
    );
  } else if (type === "hls") {
    actions.appendChild(
      createButton("Download", "btn-download", () =>
        downloadHLS(stream, item)
      )
    );
  } else if (type === "mpd") {
    actions.appendChild(
      createButton("Download", "btn-download", () =>
        downloadDASH(stream, item)
      )
    );
  }

  // Copy URL
  actions.appendChild(
    createButton("Copy URL", "btn-copy", () => {
      copyToClipboard(stream.url);
      showToast("URL copied!");
    })
  );

  // yt-dlp
  actions.appendChild(
    createButton("yt-dlp", "btn-ytdlp", () => {
      copyToClipboard(buildYtdlpCommand(stream));
      showToast("yt-dlp command copied!");
    })
  );

  // ffmpeg
  if (type === "hls" || type === "mpd" || type === "video") {
    actions.appendChild(
      createButton("ffmpeg", "btn-ffmpeg", () => {
        copyToClipboard(buildFfmpegCommand(stream));
        showToast("ffmpeg command copied!");
      })
    );
  }

  infoEl.appendChild(actions);
  item.appendChild(infoEl);

  return item;
}

function createButton(text, className, onClick) {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function createThumbPlaceholder(type) {
  const div = document.createElement("div");
  div.className = "thumb-placeholder";

  const icon =
    type === "audio"
      ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`
      : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

  div.innerHTML = icon;
  return div;
}

// --- Progress bar element ---

function createProgressBar(downloadId) {
  const container = document.createElement("div");
  container.className = "download-progress";
  container.setAttribute("data-download-id", downloadId);

  container.innerHTML = `
    <div class="progress-bar">
      <div class="progress-fill" style="width: 0%"></div>
    </div>
    <div class="progress-row">
      <span class="progress-text">Starting download...</span>
      <button class="btn-cancel" title="Cancel">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `;

  container.querySelector(".btn-cancel").addEventListener("click", () => {
    chrome.runtime.sendMessage({
      action: "cancelDownload",
      downloadId,
    });
  });

  return container;
}

// --- Download handlers ---

function downloadDirect(stream) {
  const name = stream.displayName || stream.filename;
  const filename = name !== "unknown" ? name : undefined;
  chrome.runtime.sendMessage({
    action: "download",
    url: stream.url,
    filename,
  });
  showToast("Download started!");
}

function downloadHLS(stream, itemEl) {
  const existingProgress = itemEl.querySelector(".download-progress");
  if (existingProgress) return;

  // First probe for quality variants
  const dlBtn = itemEl.querySelector(".btn-download");
  if (dlBtn) {
    dlBtn.textContent = "Loading...";
    dlBtn.disabled = true;
  }

  chrome.runtime.sendMessage(
    { action: "hlsProbe", url: stream.url, referer: stream.referer },
    (result) => {
      if (dlBtn) {
        dlBtn.textContent = "Download";
        dlBtn.disabled = false;
      }

      if (result?.isMaster && result.variants?.length > 1) {
        // Show quality picker
        showQualityPicker(stream, itemEl, result.variants);
      } else {
        // Single quality or media playlist - download directly
        startHLSDownload(stream, itemEl, null);
      }
    }
  );
}

function showQualityPicker(stream, itemEl, variants) {
  // Remove existing picker if any
  const existing = itemEl.querySelector(".quality-picker");
  if (existing) existing.remove();

  const picker = document.createElement("div");
  picker.className = "quality-picker";

  const label = document.createElement("div");
  label.className = "quality-label";
  label.textContent = "Select quality:";
  picker.appendChild(label);

  const options = document.createElement("div");
  options.className = "quality-options";

  for (const variant of variants) {
    const btn = document.createElement("button");
    btn.className = "quality-btn";
    btn.textContent = variant.label;
    btn.title = variant.codecs || "";
    btn.addEventListener("click", () => {
      picker.remove();
      startHLSDownload(stream, itemEl, variant.url);
    });
    options.appendChild(btn);
  }

  picker.appendChild(options);
  itemEl.appendChild(picker);
}

function startHLSDownload(stream, itemEl, variantUrl) {
  chrome.runtime.sendMessage(
    { action: "hlsDownload", stream, variantUrl },
    (response) => {
      if (response?.error) {
        showToast(`Error: ${response.error}`);
        return;
      }
      if (response?.downloadId) {
        const progressEl = createProgressBar(response.downloadId);
        itemEl.appendChild(progressEl);
        showToast("HLS download started!");
      }
    }
  );
}

function downloadDASH(stream, itemEl) {
  const existingProgress = itemEl.querySelector(".download-progress");
  if (existingProgress) return;

  chrome.runtime.sendMessage(
    { action: "dashDownload", stream },
    (response) => {
      if (response?.error) {
        showToast(`Error: ${response.error}`);
        return;
      }
      if (response?.downloadId) {
        const progressEl = createProgressBar(response.downloadId);
        itemEl.appendChild(progressEl);
        showToast("DASH download started!");
      }
    }
  );
}

// --- Pretty filename ---

function prettifyFilename(filename) {
  if (!filename || filename === "unknown") return null;
  let pretty = filename.replace(/[a-f0-9]{32,}/gi, "");
  pretty = pretty.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    ""
  );
  pretty = pretty
    .replace(/^[-_.\s]+|[-_.\s]+$/g, "")
    .replace(/[-_]{2,}/g, " ");
  if (!pretty || pretty.length < 3) return null;
  return pretty;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// --- Commands ---

function buildYtdlpCommand(stream) {
  let cmd = `yt-dlp "${stream.url}"`;
  if (stream.referer) {
    cmd += ` --referer "${stream.referer}"`;
  }
  cmd += ` --cookies-from-browser chrome`;
  return cmd;
}

function buildFfmpegCommand(stream) {
  const ext = stream.type === "audio" ? "mp3" : "mp4";
  const name = stream.displayName
    ? stream.displayName.replace(/\.[^.]+$/, "")
    : "output";
  const safeName = name.replace(/[<>:"/\\|?*]/g, "").trim();

  if (stream.referer) {
    return `ffmpeg -headers "Referer: ${stream.referer}" -i "${stream.url}" -c copy "${safeName}.${ext}"`;
  }
  return `ffmpeg -i "${stream.url}" -c copy "${safeName}.${ext}"`;
}

// --- Copy ---

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
}

// --- Copy All ---

copyAllBtn.addEventListener("click", () => {
  const urls = Object.values(currentStreams)
    .filter((s) => s.type !== "segment")
    .map((s) => s.url)
    .join("\n");
  if (urls) {
    copyToClipboard(urls);
    showToast("URLs copied!");
  }
});

// --- Refresh ---

refreshBtn.addEventListener("click", () => {
  if (currentTab) {
    chrome.tabs.sendMessage(
      currentTab.id,
      { action: "getPageMetadata" },
      () => {
        setTimeout(init, 300);
      }
    );
  }
  showToast("Rescanning...");
});

// --- Toast ---

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.remove("fade-out");

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove("fade-out");
    }, 300);
  }, 1500);
}

// --- Helpers ---

function showEmpty() {
  emptyState.hidden = false;
  copyAllBtn.style.display = "none";
  streamsContainer.innerHTML = "";
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- Start ---

init();

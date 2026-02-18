// VidSniff - HLS & DASH Downloaders (hls-downloader.js)
// Downloads HLS/DASH streams by fetching manifests, parsing segments, downloading & merging

class HLSDownloader {
  constructor() {
    this.downloads = new Map();
    this.nextId = 1;
  }

  // --- Public API ---

  /**
   * Probe an m3u8 URL for available quality variants
   * @returns { isMaster, variants: [{ bandwidth, resolution, codecs, url }] }
   */
  async probeQualities(url, referer) {
    const headers = {};
    if (referer) headers["Referer"] = referer;

    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parsed = this._parseM3U8(text, url);

    if (parsed.isMaster && parsed.variants.length > 0) {
      // Sort by bandwidth descending
      const variants = [...parsed.variants].sort(
        (a, b) => b.bandwidth - a.bandwidth
      );
      return {
        isMaster: true,
        variants: variants.map((v) => ({
          bandwidth: v.bandwidth,
          resolution: v.resolution,
          codecs: v.codecs,
          url: v.url,
          label: v.resolution
            ? `${v.resolution} (${formatBitrate(v.bandwidth)})`
            : formatBitrate(v.bandwidth),
        })),
      };
    }

    return { isMaster: false, variants: [] };
  }

  /**
   * Start downloading an HLS stream
   * @param {Object} opts - { url, variantUrl?, referer, cookie, userAgent, filename, tabId }
   */
  async startDownload(opts) {
    const id = `hls_${this.nextId++}`;

    const download = {
      id,
      url: opts.url,
      variantUrl: opts.variantUrl || null, // User-selected quality
      referer: opts.referer || "",
      cookie: opts.cookie || "",
      userAgent: opts.userAgent || "",
      filename: opts.filename || "video.mp4",
      tabId: opts.tabId,
      state: "parsing",
      progress: 0,
      totalSegments: 0,
      downloadedSegments: 0,
      totalBytes: 0,
      error: null,
      abortController: new AbortController(),
    };

    this.downloads.set(id, download);
    this._notifyProgress(download);

    this._processDownload(download).catch((err) => {
      if (download.state !== "cancelled") {
        download.state = "error";
        download.error = err.message || "Unknown error";
        this._notifyProgress(download);
      }
    });

    return id;
  }

  cancelDownload(id) {
    const dl = this.downloads.get(id);
    if (dl) {
      dl.abortController.abort();
      dl.state = "cancelled";
      this._notifyProgress(dl);
      this.downloads.delete(id);
    }
  }

  getDownloadState(id) {
    const dl = this.downloads.get(id);
    if (!dl) return null;
    return {
      id: dl.id,
      state: dl.state,
      progress: dl.progress,
      totalSegments: dl.totalSegments,
      downloadedSegments: dl.downloadedSegments,
      totalBytes: dl.totalBytes,
      error: dl.error,
      filename: dl.filename,
    };
  }

  getAllDownloads() {
    const result = {};
    for (const [id, dl] of this.downloads) {
      result[id] = this.getDownloadState(id);
    }
    return result;
  }

  // --- Internal ---

  async _processDownload(dl) {
    dl.state = "parsing";
    this._notifyProgress(dl);

    const m3u8Text = await this._fetch(dl, dl.url);
    const parsed = this._parseM3U8(m3u8Text, dl.url);

    if (parsed.isMaster) {
      // Pick variant: user-selected or best quality
      let variantUrl = dl.variantUrl;
      if (!variantUrl) {
        const best = this._pickBestVariant(parsed.variants);
        if (!best)
          throw new Error("No playable variants found in master playlist");
        variantUrl = best.url;
      }

      const variantText = await this._fetch(dl, variantUrl);
      const variantParsed = this._parseM3U8(variantText, variantUrl);
      parsed.segments = variantParsed.segments;

      if (parsed.audioUrl) {
        const audioText = await this._fetch(dl, parsed.audioUrl);
        const audioParsed = this._parseM3U8(audioText, parsed.audioUrl);
        parsed.audioSegments = audioParsed.segments;
      }
    }

    if (!parsed.segments || parsed.segments.length === 0) {
      throw new Error("No segments found in playlist");
    }

    // Download video segments
    dl.state = "downloading";
    dl.totalSegments =
      parsed.segments.length + (parsed.audioSegments?.length || 0);
    dl.downloadedSegments = 0;
    this._notifyProgress(dl);

    const videoChunks = await this._downloadSegments(dl, parsed.segments);

    // Download audio segments if separate
    let audioChunks = null;
    if (parsed.audioSegments && parsed.audioSegments.length > 0) {
      audioChunks = await this._downloadSegments(dl, parsed.audioSegments);
    }

    if (dl.abortController.signal.aborted) return;

    // Merge
    dl.state = "merging";
    this._notifyProgress(dl);

    const baseName = dl.filename.replace(/\.[^.]+$/, "");

    if (audioChunks) {
      const videoBlob = new Blob(videoChunks, { type: "video/mp2t" });
      const audioBlob = new Blob(audioChunks, { type: "audio/mp2t" });
      await this._saveBlobAsDownload(videoBlob, `${baseName}.ts`, dl);
      await this._saveBlobAsDownload(audioBlob, `${baseName}_audio.ts`, dl);
    } else {
      const finalBlob = new Blob(videoChunks, { type: "video/mp2t" });
      await this._saveBlobAsDownload(finalBlob, `${baseName}.ts`, dl);
    }

    dl.state = "done";
    dl.progress = 100;
    this._notifyProgress(dl);

    setTimeout(() => this.downloads.delete(dl.id), 60000);
  }

  async _downloadSegments(dl, segments) {
    const chunks = [];
    const CONCURRENT = 6;
    let retries = 0;
    const MAX_RETRIES = 3;

    for (let i = 0; i < segments.length; i += CONCURRENT) {
      if (dl.abortController.signal.aborted) {
        throw new Error("Download cancelled");
      }

      const batch = segments.slice(i, i + CONCURRENT);
      try {
        const results = await Promise.all(
          batch.map((seg) => this._fetchBinaryWithRetry(dl, seg.url))
        );

        for (const chunk of results) {
          chunks.push(chunk);
          dl.downloadedSegments++;
          dl.totalBytes += chunk.byteLength;
          dl.progress = Math.round(
            (dl.downloadedSegments / dl.totalSegments) * 95
          );
          this._notifyProgress(dl);
        }
        retries = 0; // Reset on success
      } catch (err) {
        if (retries < MAX_RETRIES) {
          retries++;
          i -= CONCURRENT; // Retry this batch
          await new Promise((r) => setTimeout(r, 1000 * retries));
          continue;
        }
        throw err;
      }
    }

    return chunks;
  }

  async _fetchBinaryWithRetry(dl, url, attempt = 0) {
    try {
      return await this._fetchBinary(dl, url);
    } catch (err) {
      if (attempt < 2 && !dl.abortController.signal.aborted) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        return this._fetchBinaryWithRetry(dl, url, attempt + 1);
      }
      throw err;
    }
  }

  async _saveBlobAsDownload(blob, filename, dl) {
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: sanitizeFilename(filename),
          conflictAction: "uniquify",
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  }

  // --- M3U8 Parser ---

  _parseM3U8(text, baseUrl) {
    const lines = text.split("\n").map((l) => l.trim());
    const result = {
      isMaster: false,
      variants: [],
      segments: [],
      audioSegments: null,
      audioUrl: null,
    };

    if (
      text.includes("#EXT-X-STREAM-INF") ||
      text.includes("#EXT-X-MEDIA:")
    ) {
      result.isMaster = true;

      for (const line of lines) {
        if (
          line.startsWith("#EXT-X-MEDIA:") &&
          line.includes("TYPE=AUDIO")
        ) {
          const uriMatch = line.match(/URI="([^"]+)"/);
          if (uriMatch) {
            result.audioUrl = this._resolveUrl(uriMatch[1], baseUrl);
          }
        }
      }

      let nextVariantInfo = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          const bandwidth = parseInt(
            (line.match(/BANDWIDTH=(\d+)/) || [])[1] || "0"
          );
          const resolution =
            (line.match(/RESOLUTION=([^\s,]+)/) || [])[1] || "";
          const codecs = (line.match(/CODECS="([^"]+)"/) || [])[1] || "";
          nextVariantInfo = { bandwidth, resolution, codecs };
        } else if (nextVariantInfo && line && !line.startsWith("#")) {
          result.variants.push({
            ...nextVariantInfo,
            url: this._resolveUrl(line, baseUrl),
          });
          nextVariantInfo = null;
        }
      }
    }

    // Parse segments
    let duration = 0;
    let nextSegKey = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("#EXTINF:")) {
        duration = parseFloat(line.split(":")[1]) || 0;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const method = (line.match(/METHOD=([^,]+)/) || [])[1];
        const uri = (line.match(/URI="([^"]+)"/) || [])[1];
        const iv = (line.match(/IV=([^,]+)/) || [])[1];
        if (method && method !== "NONE") {
          nextSegKey = {
            method,
            uri: uri ? this._resolveUrl(uri, baseUrl) : null,
            iv,
          };
        } else {
          nextSegKey = null;
        }
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const uri = (line.match(/URI="([^"]+)"/) || [])[1];
        if (uri) {
          result.segments.push({
            url: this._resolveUrl(uri, baseUrl),
            duration: 0,
            isInit: true,
            key: nextSegKey,
          });
        }
      } else if (line && !line.startsWith("#")) {
        result.segments.push({
          url: this._resolveUrl(line, baseUrl),
          duration,
          key: nextSegKey,
        });
        duration = 0;
      }
    }

    return result;
  }

  _pickBestVariant(variants) {
    if (!variants || variants.length === 0) return null;
    const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
    return sorted[0];
  }

  _resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  async _fetch(dl, url) {
    const headers = {};
    if (dl.referer) headers["Referer"] = dl.referer;

    const resp = await fetch(url, {
      headers,
      signal: dl.abortController.signal,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.text();
  }

  async _fetchBinary(dl, url) {
    const headers = {};
    if (dl.referer) headers["Referer"] = dl.referer;

    const resp = await fetch(url, {
      headers,
      signal: dl.abortController.signal,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching segment`);
    return resp.arrayBuffer();
  }

  _notifyProgress(dl) {
    chrome.runtime
      .sendMessage({
        action: "hlsProgress",
        downloadId: dl.id,
        state: dl.state,
        progress: dl.progress,
        totalSegments: dl.totalSegments,
        downloadedSegments: dl.downloadedSegments,
        totalBytes: dl.totalBytes,
        error: dl.error,
        filename: dl.filename,
        tabId: dl.tabId,
      })
      .catch(() => {});
  }
}

// --- DASH Downloader ---

class DASHDownloader {
  constructor() {
    this.downloads = new Map();
    this.nextId = 1;
  }

  async startDownload(opts) {
    const id = `dash_${this.nextId++}`;

    const download = {
      id,
      url: opts.url,
      referer: opts.referer || "",
      filename: opts.filename || "video.mp4",
      tabId: opts.tabId,
      state: "parsing",
      progress: 0,
      totalSegments: 0,
      downloadedSegments: 0,
      totalBytes: 0,
      error: null,
      abortController: new AbortController(),
    };

    this.downloads.set(id, download);
    this._notifyProgress(download);

    this._processDownload(download).catch((err) => {
      if (download.state !== "cancelled") {
        download.state = "error";
        download.error = err.message || "Unknown error";
        this._notifyProgress(download);
      }
    });

    return id;
  }

  cancelDownload(id) {
    const dl = this.downloads.get(id);
    if (dl) {
      dl.abortController.abort();
      dl.state = "cancelled";
      this._notifyProgress(dl);
      this.downloads.delete(id);
    }
  }

  getDownloadState(id) {
    const dl = this.downloads.get(id);
    if (!dl) return null;
    return {
      id: dl.id,
      state: dl.state,
      progress: dl.progress,
      totalSegments: dl.totalSegments,
      downloadedSegments: dl.downloadedSegments,
      totalBytes: dl.totalBytes,
      error: dl.error,
      filename: dl.filename,
    };
  }

  getAllDownloads() {
    const result = {};
    for (const [id, dl] of this.downloads) {
      result[id] = this.getDownloadState(id);
    }
    return result;
  }

  async _processDownload(dl) {
    dl.state = "parsing";
    this._notifyProgress(dl);

    const mpdText = await this._fetch(dl, dl.url);
    const parsed = this._parseMPD(mpdText, dl.url);

    if (!parsed.videoSegments || parsed.videoSegments.length === 0) {
      throw new Error("No video segments found in MPD");
    }

    dl.state = "downloading";
    dl.totalSegments =
      parsed.videoSegments.length + (parsed.audioSegments?.length || 0);
    this._notifyProgress(dl);

    const videoChunks = await this._downloadSegments(
      dl,
      parsed.videoSegments
    );

    let audioChunks = null;
    if (parsed.audioSegments && parsed.audioSegments.length > 0) {
      audioChunks = await this._downloadSegments(dl, parsed.audioSegments);
    }

    if (dl.abortController.signal.aborted) return;

    dl.state = "merging";
    this._notifyProgress(dl);

    const baseName = dl.filename.replace(/\.[^.]+$/, "");
    const videoBlob = new Blob(videoChunks, {
      type: "application/octet-stream",
    });
    const videoName = baseName + (audioChunks ? "_video" : "") + ".mp4";
    await this._saveBlobAsDownload(videoBlob, videoName, dl);

    if (audioChunks) {
      const audioBlob = new Blob(audioChunks, {
        type: "application/octet-stream",
      });
      await this._saveBlobAsDownload(audioBlob, `${baseName}_audio.m4a`, dl);
    }

    dl.state = "done";
    dl.progress = 100;
    this._notifyProgress(dl);

    setTimeout(() => this.downloads.delete(dl.id), 60000);
  }

  _parseMPD(mpdText, baseUrl) {
    const result = { videoSegments: [], audioSegments: [] };

    const adaptations =
      mpdText.match(/<AdaptationSet[\s\S]*?<\/AdaptationSet>/gi) || [];

    for (const adapt of adaptations) {
      const isVideo =
        /mimeType="video/i.test(adapt) ||
        /contentType="video/i.test(adapt);
      const isAudio =
        /mimeType="audio/i.test(adapt) ||
        /contentType="audio/i.test(adapt);

      if (!isVideo && !isAudio) {
        if (/<Representation[^>]*mimeType="video/i.test(adapt)) {
          // video at rep level
        } else if (/<Representation[^>]*mimeType="audio/i.test(adapt)) {
          // audio at rep level
        } else {
          continue;
        }
      }

      const reps = [];
      const repMatches =
        adapt.match(
          /<Representation[\s\S]*?(?:<\/Representation>|\/?>)/gi
        ) || [];

      for (const rep of repMatches) {
        const bandwidth = parseInt(
          (rep.match(/bandwidth="(\d+)"/) || [])[1] || "0"
        );
        const width = parseInt(
          (rep.match(/width="(\d+)"/) || [])[1] || "0"
        );
        const height = parseInt(
          (rep.match(/height="(\d+)"/) || [])[1] || "0"
        );
        const id = (rep.match(/id="([^"]+)"/) || [])[1] || "";

        reps.push({ bandwidth, width, height, id, xml: rep });
      }

      reps.sort((a, b) => b.bandwidth - a.bandwidth);
      const bestRep = reps[0];
      if (!bestRep) continue;

      const segments = this._extractDASHSegments(
        adapt,
        bestRep.xml,
        baseUrl,
        bestRep.id
      );

      if (isVideo || (!isAudio && bestRep.width > 0)) {
        result.videoSegments = segments;
      } else {
        result.audioSegments = segments;
      }
    }

    return result;
  }

  _extractDASHSegments(adaptXml, repXml, baseUrl, repId) {
    const segments = [];
    const combined = adaptXml + repXml;

    const segListMatch = combined.match(
      /<SegmentList[\s\S]*?<\/SegmentList>/i
    );
    if (segListMatch) {
      const initMatch = segListMatch[0].match(
        /<Initialization\s[^>]*sourceURL="([^"]+)"/i
      );
      if (initMatch) {
        segments.push({
          url: this._resolveUrl(initMatch[1], baseUrl),
          isInit: true,
        });
      }

      const segUrls =
        segListMatch[0].match(
          /<SegmentURL\s[^>]*media="([^"]+)"/gi
        ) || [];
      for (const seg of segUrls) {
        const url = (seg.match(/media="([^"]+)"/) || [])[1];
        if (url)
          segments.push({ url: this._resolveUrl(url, baseUrl) });
      }
      return segments;
    }

    const templateMatch = combined.match(
      /<SegmentTemplate[\s\S]*?(?:<\/SegmentTemplate>|\/>)/i
    );
    if (templateMatch) {
      const template = templateMatch[0];
      const initTemplate =
        (template.match(/initialization="([^"]+)"/) || [])[1];
      const mediaTemplate =
        (template.match(/media="([^"]+)"/) || [])[1];
      const startNumber = parseInt(
        (template.match(/startNumber="(\d+)"/) || [])[1] || "1"
      );
      const timescale = parseInt(
        (template.match(/timescale="(\d+)"/) || [])[1] || "1"
      );

      if (initTemplate) {
        const initUrl = initTemplate
          .replace(/\$RepresentationID\$/g, repId)
          .replace(/\$Number[^$]*\$/g, String(startNumber));
        segments.push({
          url: this._resolveUrl(initUrl, baseUrl),
          isInit: true,
        });
      }

      const timelineMatch = template.match(
        /<SegmentTimeline[\s\S]*?<\/SegmentTimeline>/i
      );
      if (timelineMatch && mediaTemplate) {
        const sElements =
          timelineMatch[0].match(/<S\s[^/]*\/>/gi) || [];
        let time = 0;
        let number = startNumber;

        for (const sEl of sElements) {
          const t = parseInt(
            (sEl.match(/t="(\d+)"/) || [])[1] || String(time)
          );
          const d = parseInt(
            (sEl.match(/d="(\d+)"/) || [])[1] || "0"
          );
          const r = parseInt(
            (sEl.match(/r="(\d+)"/) || [])[1] || "0"
          );
          time = t;

          for (let j = 0; j <= r; j++) {
            const url = mediaTemplate
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Number(%\d+d)?\$/g, (_, fmt) => {
                if (fmt) {
                  const width = parseInt(fmt.replace(/%|d/g, ""));
                  return String(number).padStart(width, "0");
                }
                return String(number);
              })
              .replace(/\$Time\$/g, String(time));

            segments.push({ url: this._resolveUrl(url, baseUrl) });
            time += d;
            number++;
          }
        }
      } else if (mediaTemplate) {
        const segDuration = parseInt(
          (template.match(/duration="(\d+)"/) || [])[1] || "0"
        );
        if (segDuration > 0) {
          const durationMatch = combined.match(
            /mediaPresentationDuration="PT([^"]+)"/i
          );
          let totalDuration = 300;
          if (durationMatch) {
            totalDuration = this._parseDuration(durationMatch[1]);
          }
          const numSegments = Math.ceil(
            (totalDuration * timescale) / segDuration
          );

          for (let n = startNumber; n < startNumber + numSegments; n++) {
            const url = mediaTemplate
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Number(%\d+d)?\$/g, (_, fmt) => {
                if (fmt) {
                  const width = parseInt(fmt.replace(/%|d/g, ""));
                  return String(n).padStart(width, "0");
                }
                return String(n);
              });

            segments.push({ url: this._resolveUrl(url, baseUrl) });
          }
        }
      }

      return segments;
    }

    const baseUrlMatch = repXml.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
    if (baseUrlMatch) {
      segments.push({
        url: this._resolveUrl(baseUrlMatch[1], baseUrl),
      });
    }

    return segments;
  }

  _parseDuration(str) {
    let total = 0;
    const h = (str.match(/([\d.]+)H/i) || [])[1];
    const m = (str.match(/([\d.]+)M/i) || [])[1];
    const s = (str.match(/([\d.]+)S/i) || [])[1];
    if (h) total += parseFloat(h) * 3600;
    if (m) total += parseFloat(m) * 60;
    if (s) total += parseFloat(s);
    return total;
  }

  _resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  async _downloadSegments(dl, segments) {
    const chunks = [];
    const CONCURRENT = 6;

    for (let i = 0; i < segments.length; i += CONCURRENT) {
      if (dl.abortController.signal.aborted) throw new Error("Cancelled");

      const batch = segments.slice(i, i + CONCURRENT);
      const results = await Promise.all(
        batch.map((seg) => this._fetchBinaryWithRetry(dl, seg.url))
      );

      for (const chunk of results) {
        chunks.push(chunk);
        dl.downloadedSegments++;
        dl.totalBytes += chunk.byteLength;
        dl.progress = Math.round(
          (dl.downloadedSegments / dl.totalSegments) * 95
        );
        this._notifyProgress(dl);
      }
    }

    return chunks;
  }

  async _fetchBinaryWithRetry(dl, url, attempt = 0) {
    try {
      return await this._fetchBinary(dl, url);
    } catch (err) {
      if (attempt < 2 && !dl.abortController.signal.aborted) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        return this._fetchBinaryWithRetry(dl, url, attempt + 1);
      }
      throw err;
    }
  }

  async _fetch(dl, url) {
    const headers = {};
    if (dl.referer) headers["Referer"] = dl.referer;
    const resp = await fetch(url, {
      headers,
      signal: dl.abortController.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  }

  async _fetchBinary(dl, url) {
    const headers = {};
    if (dl.referer) headers["Referer"] = dl.referer;
    const resp = await fetch(url, {
      headers,
      signal: dl.abortController.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching segment`);
    return resp.arrayBuffer();
  }

  async _saveBlobAsDownload(blob, filename, dl) {
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: sanitizeFilename(filename),
          conflictAction: "uniquify",
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  }

  _notifyProgress(dl) {
    chrome.runtime
      .sendMessage({
        action: "dashProgress",
        downloadId: dl.id,
        state: dl.state,
        progress: dl.progress,
        totalSegments: dl.totalSegments,
        downloadedSegments: dl.downloadedSegments,
        totalBytes: dl.totalBytes,
        error: dl.error,
        filename: dl.filename,
        tabId: dl.tabId,
      })
      .catch(() => {});
  }
}

// --- Shared Utilities ---

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

function formatBitrate(bps) {
  if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`;
  if (bps >= 1000) return `${(bps / 1000).toFixed(0)} Kbps`;
  return `${bps} bps`;
}

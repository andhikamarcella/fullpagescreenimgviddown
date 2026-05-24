/* global chrome, WebCaptureUtils */
(() => {
  let selectMode = false;
  let hoverEl = null;
  let scanPromise = null;

  const SELECT_CLASS = 'wcp-image-hover';
  const SELECT_STYLE_ID = 'wcp-select-style';

  function ensureSelectStyles() {
    if (document.getElementById(SELECT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SELECT_STYLE_ID;
    style.textContent = `
      .${SELECT_CLASS} {
        outline: 3px solid #5db2ff !important;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.28) inset !important;
        cursor: crosshair !important;
        transition: outline .15s ease;
      }
      html.wcp-select-enabled, html.wcp-select-enabled * {
        cursor: crosshair !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function handleMouseOver(event) {
    if (!selectMode) return;
    const img = event.target.closest('img');
    if (!img) return;
    if (hoverEl && hoverEl !== img) hoverEl.classList.remove(SELECT_CLASS);
    hoverEl = img;
    hoverEl.classList.add(SELECT_CLASS);
  }

  function handleClick(event) {
    if (!selectMode) return;
    const img = event.target.closest('img');
    if (!img) return;

    event.preventDefault();
    event.stopPropagation();

    const url = pickBestImageUrl(img);
    if (!url) return;

    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_IMAGE_FROM_CLICK',
      imageUrl: WebCaptureUtils.guessFullSizeUrl(url),
      referer: location.href
    });
  }

  function enableSelectMode() {
    selectMode = true;
    ensureSelectStyles();
    document.documentElement.classList.add('wcp-select-enabled');
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('click', handleClick, true);
  }

  function disableSelectMode() {
    selectMode = false;
    if (hoverEl) hoverEl.classList.remove(SELECT_CLASS);
    hoverEl = null;
    document.documentElement.classList.remove('wcp-select-enabled');
    document.removeEventListener('mouseover', handleMouseOver, true);
    document.removeEventListener('click', handleClick, true);
  }

  function pickBestImageUrl(img) {
    const attrs = ['data-original', 'data-src', 'data-lazy', 'data-url', 'src'];
    for (const attr of attrs) {
      const raw = img.getAttribute(attr);
      const normalized = WebCaptureUtils.normalizeImageUrl(raw, location.href);
      if (normalized) return normalized;
    }

    if (img.srcset) {
      const srcsetUrl = WebCaptureUtils.pickLargestFromSrcSet(img.srcset, location.href);
      if (srcsetUrl) return srcsetUrl;
    }

    return null;
  }

  function getPageDimensions() {
    const body = document.body;
    const html = document.documentElement;
    const totalHeight = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      html ? html.clientHeight : 0,
      html ? html.scrollHeight : 0,
      html ? html.offsetHeight : 0
    );

    return {
      totalHeight,
      totalWidth: Math.max(html.scrollWidth, window.innerWidth),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      initialScrollY: window.scrollY
    };
  }

  async function scrollToY(y) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 120)));
    return window.scrollY;
  }

  async function restoreScroll(y) {
    window.scrollTo({ top: y || 0, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  async function createImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load screenshot segment.'));
      img.src = dataUrl;
    });
  }

  async function stitchFullPage(payload) {
    const { captures, dimensions } = payload;
    if (!captures?.length) throw new Error('No screenshot segments received.');

    const first = await createImage(captures[0].dataUrl);
    const dprScale = dimensions.devicePixelRatio || 1;
    const captureScale = first.width / dimensions.viewportWidth;
    const scale = captureScale || dprScale;

    const maxPixels = 120_000_000;
    const outputWidth = first.width;
    let outputHeight = Math.round(dimensions.totalHeight * scale);
    if (outputWidth * outputHeight > maxPixels) {
      outputHeight = Math.floor(maxPixels / outputWidth);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const part of captures) {
      const img = await createImage(part.dataUrl);
      const drawY = Math.round(part.y * scale);
      if (drawY < canvas.height) {
        const drawHeight = Math.min(img.height, canvas.height - drawY);
        ctx.drawImage(img, 0, 0, img.width, drawHeight, 0, drawY, img.width, drawHeight);
      }

      img.src = '';
      part.dataUrl = null;
    }

    const stitchedDataUrl = canvas.toDataURL('image/png', 1);

    first.src = '';
    canvas.width = 1;
    canvas.height = 1;

    return stitchedDataUrl;
  }

  function collectBackgroundImages(maxNodes = 3500) {
    const urls = [];
    const all = document.querySelectorAll('*');
    const count = Math.min(all.length, maxNodes);

    for (let i = 0; i < count; i += 1) {
      const el = all[i];
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') continue;
      const matches = [...bg.matchAll(/url\(([^)]+)\)/g)];
      matches.forEach((match) => {
        const normalized = WebCaptureUtils.normalizeImageUrl(match[1], location.href);
        if (normalized) urls.push({ url: normalized, source: 'background' });
      });
    }

    return urls;
  }

  async function verifyImageUrl(url) {
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      return true;
    } catch {
      return false;
    }
  }

  async function collectMediaCandidates() {
    const items = [];
    const media = [];

    document.querySelectorAll('img').forEach((img) => {
      const src = pickBestImageUrl(img);
      if (src) {
        items.push({
          url: src,
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          source: 'img'
        });
      }

      ['data-original', 'data-src', 'data-lazy', 'data-image'].forEach((attr) => {
        const fromAttr = WebCaptureUtils.normalizeImageUrl(img.getAttribute(attr), location.href);
        if (fromAttr) {
          items.push({
            url: fromAttr,
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
            source: 'lazy'
          });
        }
      });
    });

    document.querySelectorAll('picture source, source').forEach((source) => {
      const fromSrcSet = WebCaptureUtils.pickLargestFromSrcSet(source.srcset, location.href);
      if (fromSrcSet) items.push({ url: fromSrcSet, width: 0, height: 0, source: 'picture' });

      const fromSrc = WebCaptureUtils.normalizeImageUrl(source.src, location.href);
      if (fromSrc) items.push({ url: fromSrc, width: 0, height: 0, source: 'picture' });
    });

    items.push(...collectBackgroundImages());

    const dedup = new Map();
    for (const item of items) {
      if (!item?.url || item.url.startsWith('data:')) continue;
      const key = item.url;
      if (!dedup.has(key)) {
        dedup.set(key, {
          url: item.url,
          originalUrl: item.url,
          width: item.width || 0,
          height: item.height || 0,
          source: item.source || 'unknown'
        });
      } else {
        const existing = dedup.get(key);
        existing.width = Math.max(existing.width, item.width || 0);
        existing.height = Math.max(existing.height, item.height || 0);
      }
    }

    const candidates = [...dedup.values()];
    const verifyBudget = Math.min(candidates.length, 80);

    for (let i = 0; i < verifyBudget; i += 1) {
      const item = candidates[i];
      const hiRes = WebCaptureUtils.guessFullSizeUrl(item.url);
      if (hiRes === item.url) continue;

      const hiResValid = await verifyImageUrl(hiRes);
      item.url = hiResValid ? hiRes : item.originalUrl;
    }

    const finalMap = new Map();
    candidates.forEach((item) => {
      if (!finalMap.has(item.url)) {
        finalMap.set(item.url, item);
      } else {
        const existing = finalMap.get(item.url);
        existing.width = Math.max(existing.width, item.width);
        existing.height = Math.max(existing.height, item.height);
      }
    });

    const images = [...finalMap.values()].sort((a, b) => (b.width * b.height) - (a.width * a.height));

    document.querySelectorAll('video').forEach((video) => {
      const sources = [];
      const direct = WebCaptureUtils.normalizeImageUrl(video.currentSrc || video.src, location.href);
      if (direct) sources.push({ url: direct, label: 'Auto' });
      video.querySelectorAll('source').forEach((source) => {
        const src = WebCaptureUtils.normalizeImageUrl(source.src, location.href);
        if (!src) return;
        const label = source.getAttribute('label') || source.getAttribute('res') || source.getAttribute('size') || source.getAttribute('data-quality') || source.type || 'Source';
        sources.push({ url: src, label });
      });
      const dedup = [];
      const seen = new Set();
      for (const src of sources) {
        if (seen.has(src.url)) continue;
        seen.add(src.url); dedup.push(src);
      }
      if (!dedup.length) return;
      media.push({
        type: 'video',
        url: dedup[0].url,
        width: video.videoWidth || video.clientWidth || 0,
        height: video.videoHeight || video.clientHeight || 0,
        source: 'video',
        qualities: dedup
      });
    });

    images.forEach((item) => media.push({ ...item, type: 'image' }));
    return media.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  }

  async function runSafeScan() {
    if (scanPromise) return scanPromise;

    scanPromise = (async () => {
      const media = await collectMediaCandidates();
      return { ok: true, media, scannedCount: media.length };
    })();

    try {
      return await scanPromise;
    } finally {
      scanPromise = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'GET_PAGE_DIMENSIONS') {
        sendResponse({ ok: true, data: getPageDimensions() });
        return;
      }

      if (message.type === 'SCROLL_TO') {
        const y = await scrollToY(message.y || 0);
        sendResponse({ ok: true, y });
        return;
      }

      if (message.type === 'RESTORE_SCROLL') {
        await restoreScroll(message.y || 0);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'STITCH_SCREENSHOT') {
        try {
          const dataUrl = await stitchFullPage(message.payload);
          sendResponse({ ok: true, dataUrl });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        return;
      }

      if (message.type === 'SCAN_MEDIA') {
        try {
          const result = await runSafeScan();
          sendResponse(result);
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        return;
      }

      if (message.type === 'SET_SELECT_MODE') {
        if (message.enabled) enableSelectMode();
        else disableSelectMode();
        sendResponse({ ok: true, enabled: !!message.enabled });
      }
    })();

    return true;
  });
})();

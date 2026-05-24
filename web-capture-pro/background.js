/* global chrome, WebCaptureUtils, importScripts */
importScripts('utils.js');

const captureSessions = new Map();
let captureInProgress = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function sendMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function captureVisible(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function captureVisibleWithRetry(windowId) {
  try {
    return await captureVisible(windowId);
  } catch (error) {
    await delay(500);
    return captureVisible(windowId);
  }
}

async function ensureContentScript(tabId) {
  try {
    await sendMessage(tabId, { type: 'PING' });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['utils.js', 'content.js']
    });
  }
}

function buildTimestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'site';
  }
}

function makeImageFilename(url) {
  const domain = getDomain(url);
  return WebCaptureUtils.domainTimestampFilename('png', 'fullpage', domain);
}


function makeDownloadVideoFilename(url, pageUrl, index = 1) {
  const domain = WebCaptureUtils.safeFilename(getDomain(pageUrl || url));
  const extMatch = url.match(/\.(mp4|webm|mov|m4v|m3u8)(?:\?|$)/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
  return `${domain}_${buildTimestamp()}_video_${String(index).padStart(3, '0')}.${ext}`;
}

function buildRequestHeaders(pageUrl) {
  if (!pageUrl) return [];
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch {}
  const headers = [{ name: 'Referer', value: pageUrl }];
  if (origin) headers.push({ name: 'Origin', value: origin });
  return headers;
}

async function downloadVideoWithFallback(url, filename, pageUrl) {
  const headers = buildRequestHeaders(pageUrl);
  try {
    await downloadUrl(url, filename, headers);
    return;
  } catch (e) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', referrer: pageUrl || undefined });
    if (!res.ok) throw new Error(`Failed to fetch video: ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) throw new Error('Server returned HTML instead of video stream.');
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      await downloadUrl(objectUrl, filename);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    }
  }
}

function makeDownloadImageFilename(url, pageUrl, index = 1) {
  const domain = WebCaptureUtils.safeFilename(getDomain(pageUrl || url));
  const ext = (() => {
    const match = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|$)/i);
    return match ? match[1].toLowerCase() : 'jpg';
  })();

  return `${domain}_${buildTimestamp()}_${String(index).padStart(3, '0')}.${ext}`;
}

async function startFullPageCapture() {
  if (captureInProgress) {
    throw new Error('A full page capture is already running.');
  }

  captureInProgress = true;

  let tab;
  try {
    tab = await getActiveTab();
    if (!tab || !tab.id) throw new Error('No active tab found.');

    await ensureContentScript(tab.id);

    const dimRes = await sendMessage(tab.id, { type: 'GET_PAGE_DIMENSIONS' });
    if (!dimRes?.ok) throw new Error(dimRes?.error || 'Unable to read page dimensions.');

    const dimensions = dimRes.data;
    const maxSegments = 120;
    const step = Math.max(200, dimensions.viewportHeight - 120);

    const ys = [];
    for (let y = 0; y < dimensions.totalHeight; y += step) {
      ys.push(y);
      if (ys.length >= maxSegments) break;
    }

    const session = {
      startedAt: Date.now(),
      tabId: tab.id,
      captures: []
    };
    captureSessions.set(tab.id, session);

    for (let i = 0; i < ys.length; i += 1) {
      const y = ys[i];
      const scrolled = await sendMessage(tab.id, { type: 'SCROLL_TO', y });
      if (!scrolled?.ok) throw new Error('Failed to scroll the page for capture.');

      await delay(200);
      const dataUrl = await captureVisibleWithRetry(tab.windowId);
      session.captures.push({ y: scrolled.y, dataUrl });
      await delay(300);

      chrome.runtime.sendMessage({
        type: 'CAPTURE_PROGRESS',
        progress: Math.round(((i + 1) / ys.length) * 100)
      }).catch(() => {});
    }

    await sendMessage(tab.id, { type: 'RESTORE_SCROLL', y: dimensions.initialScrollY });

    const stitched = await sendMessage(tab.id, {
      type: 'STITCH_SCREENSHOT',
      payload: {
        captures: session.captures,
        dimensions
      }
    });

    captureSessions.delete(tab.id);

    if (!stitched?.ok) throw new Error(stitched?.error || 'Failed to stitch screenshot.');

    chrome.runtime.sendMessage({ type: 'TRIGGER_AUTO_SCAN' }).catch(() => {});

    return {
      dataUrl: stitched.dataUrl,
      filename: makeImageFilename(tab.url || 'site')
    };
  } finally {
    if (tab?.id) {
      captureSessions.delete(tab.id);
    }
    captureInProgress = false;
  }
}

async function downloadUrl(url, filename, headers = []) {
  return chrome.downloads.download({
    url,
    filename,
    headers,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'CAPTURE_FULL_PAGE') {
      try {
        const result = await startFullPageCapture();
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === 'DOWNLOAD_DATA_URL') {
      try {
        await downloadUrl(message.dataUrl, message.filename || 'capture.png');
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === 'DOWNLOAD_IMAGE_URL') {
      try {
        const url = WebCaptureUtils.guessFullSizeUrl(message.url);
        const filename = makeDownloadImageFilename(url, sender?.tab?.url, message.index || 1);
        await downloadUrl(url, filename, buildRequestHeaders(sender?.tab?.url));
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === 'DOWNLOAD_VIDEO_URL') {
      try {
        const selected = message.qualities?.[message.qualityIndex] || null;
        const url = selected?.url || message.url;
        const filename = makeDownloadVideoFilename(url, sender?.tab?.url, message.index || 1);
        await downloadVideoWithFallback(url, filename, sender?.tab?.url);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === 'DOWNLOAD_IMAGE_FROM_CLICK') {
      try {
        const url = WebCaptureUtils.guessFullSizeUrl(message.imageUrl);
        const filename = makeDownloadImageFilename(url, message.referer, 1);
        await downloadUrl(url, filename);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
  })();

  return true;
});

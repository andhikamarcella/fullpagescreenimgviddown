/* global chrome, WebCaptureUtils */
(() => {
  const state = {
    captureDataUrl: null,
    captureFilename: 'capture.png',
    images: [],
    selectMode: false,
    scanning: false,
    scanDebounceTimer: null,
    captureRunning: false,
    visibleRenderLimit: 45,
    selectedUrls: new Set(),
    settings: {
      autoDownload: true,
      highRes: true
    }
  };

  const refs = {
    tabs: [...document.querySelectorAll('.tab')],
    panels: {
      screenshot: document.getElementById('screenshot-panel'),
      images: document.getElementById('images-panel'),
      settings: document.getElementById('settings-panel')
    },
    captureBtn: document.getElementById('capture-btn'),
    downloadShotBtn: document.getElementById('download-shot-btn'),
    copyShotBtn: document.getElementById('copy-shot-btn'),
    captureStatus: document.getElementById('capture-status'),
    captureProgress: document.getElementById('capture-progress'),
    scanImagesBtn: document.getElementById('scan-images-btn'),
    imageStatus: document.getElementById('image-status'),
    imageGrid: document.getElementById('image-grid'),
    filter: document.getElementById('filter'),
    downloadAllBtn: document.getElementById('download-all-btn'),
    toggleSelectBtn: document.getElementById('toggle-select-btn'),
    autoDownload: document.getElementById('auto-download'),
    highRes: document.getElementById('high-res'),
    downloadSelectedBtn: null
  };

  function getFilteredImages() {
    const threshold = refs.filter.value;
    const source = [...state.images].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    if (threshold === 'all') return source;
    const min = Number(threshold);
    return source.filter((item) => (item.width || 0) >= min);
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    return tab;
  }

  async function sendToContent(message) {
    const tab = await getActiveTab();
    return chrome.tabs.sendMessage(tab.id, message);
  }

  function setCaptureStatus(text) {
    refs.captureStatus.textContent = text;
  }

  function setImageStatus(text) {
    refs.imageStatus.textContent = text;
  }

  function setProgress(value) {
    refs.captureProgress.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  async function saveSettings() {
    await chrome.storage.sync.set({ wcpSettings: state.settings });
  }

  async function loadSettings() {
    const res = await chrome.storage.sync.get('wcpSettings');
    if (res?.wcpSettings) {
      state.settings = { ...state.settings, ...res.wcpSettings };
    }
    refs.autoDownload.checked = state.settings.autoDownload;
    refs.highRes.checked = state.settings.highRes;
  }

  function setCaptureControls(isRunning) {
    state.captureRunning = isRunning;
    refs.captureBtn.disabled = isRunning;
    if (isRunning) {
      refs.captureBtn.textContent = 'Capturing...';
      refs.downloadShotBtn.disabled = true;
      refs.copyShotBtn.disabled = true;
    } else {
      refs.captureBtn.textContent = 'Capture Full Page';
      refs.downloadShotBtn.disabled = !state.captureDataUrl;
      refs.copyShotBtn.disabled = !state.captureDataUrl;
    }
  }

  async function captureFullPage() {
    if (state.captureRunning) return;

    setCaptureControls(true);
    setProgress(0);
    setCaptureStatus('Capturing page...');

    try {
      const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_FULL_PAGE' });
      if (!response?.ok) throw new Error(response?.error || 'Capture failed');

      state.captureDataUrl = response.dataUrl;
      state.captureFilename = response.filename || 'capture.png';
      setProgress(100);
      setCaptureStatus('Capture complete.');

      if (state.settings.autoDownload) {
        await downloadCapture();
      }

      scheduleAutoScan('Screenshot completed. Auto scanning images...');
    } catch (error) {
      setCaptureStatus(`Error: ${error.message}`);
    } finally {
      setCaptureControls(false);
    }
  }

  async function downloadCapture() {
    if (!state.captureDataUrl) return;
    const response = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_DATA_URL',
      dataUrl: state.captureDataUrl,
      filename: state.captureFilename
    });
    if (!response?.ok) {
      setCaptureStatus(`Download failed: ${response?.error || 'Unknown error'}`);
      return;
    }
    setCaptureStatus('Screenshot downloaded.');
  }

  async function copyCaptureToClipboard() {
    if (!state.captureDataUrl) return;
    const blob = await (await fetch(state.captureDataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setCaptureStatus('Copied to clipboard.');
  }

  function updateBulkButtons() {
    const filtered = getFilteredImages();
    const selectedInFiltered = filtered.filter((item) => state.selectedUrls.has(item.url));

    refs.downloadAllBtn.disabled = filtered.length === 0 || state.scanning;
    refs.downloadSelectedBtn.disabled = selectedInFiltered.length === 0 || state.scanning;
  }

  function createThumb(item, idx) {
    const selected = state.selectedUrls.has(item.url);
    const wrapper = document.createElement('article');
    wrapper.className = 'thumb';
    wrapper.innerHTML = `
      <img src="${item.url}" alt="img-${idx}" loading="lazy" />
      <div class="thumb-info">
        <label style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
          <input type="checkbox" data-select-url="${item.url}" ${selected ? 'checked' : ''} />
          Select
        </label>
        <div>${item.width || '?'} × ${item.height || '?'}</div>
        <button class="btn" data-download-url="${item.url}">Download</button>
      </div>
    `;
    return wrapper;
  }

  function renderImageGrid() {
    const filtered = getFilteredImages();
    refs.imageGrid.innerHTML = '';

    const maxRender = Math.min(filtered.length, 300);
    const batchSize = 20;
    let cursor = 0;

    const renderBatch = () => {
      if (cursor >= Math.min(maxRender, state.visibleRenderLimit)) {
        const selectedCount = filtered.filter((item) => state.selectedUrls.has(item.url)).length;
        const moreNote = maxRender > state.visibleRenderLimit
          ? ` (showing ${state.visibleRenderLimit}/${maxRender})`
          : '';
        setImageStatus(`Found ${state.images.length} images (${filtered.length} shown, ${selectedCount} selected)${moreNote}.`);
        updateBulkButtons();
        return;
      }

      const fragment = document.createDocumentFragment();
      const end = Math.min(cursor + batchSize, state.visibleRenderLimit, maxRender);
      for (let i = cursor; i < end; i += 1) {
        fragment.appendChild(createThumb(filtered[i], i));
      }
      refs.imageGrid.appendChild(fragment);
      cursor = end;
      requestAnimationFrame(renderBatch);
    };

    requestAnimationFrame(renderBatch);
  }

  async function scanImages(reason = 'Scanning page images...') {
    if (state.scanning) return;

    state.scanning = true;
    refs.scanImagesBtn.disabled = true;
    updateBulkButtons();
    setImageStatus(reason);

    try {
      const response = await sendToContent({ type: 'SCAN_IMAGES' });
      if (!response?.ok) throw new Error(response?.error || 'Scan failed');

      const total = response.images?.length || 0;
      setImageStatus(`Scanning ${total} images...`);

      state.images = (response.images || [])
        .map((item) => ({
          ...item,
          url: state.settings.highRes ? WebCaptureUtils.guessFullSizeUrl(item.url) : item.url
        }))
        .filter((item) => !!item.url)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));

      state.selectedUrls = new Set(
        [...state.selectedUrls].filter((url) => state.images.some((item) => item.url === url))
      );

      renderImageGrid();
    } catch (error) {
      setImageStatus(`Error: ${error.message}`);
    } finally {
      state.scanning = false;
      refs.scanImagesBtn.disabled = false;
      updateBulkButtons();
    }
  }

  function scheduleAutoScan(statusText) {
    if (statusText) setImageStatus(statusText);

    if (state.scanDebounceTimer) {
      clearTimeout(state.scanDebounceTimer);
    }

    state.scanDebounceTimer = setTimeout(() => {
      scanImages('Auto scanning images...');
    }, 350);
  }

  async function downloadSingleImageByUrl(url, index) {
    const response = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_IMAGE_URL',
      url,
      index: index + 1
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Unknown download error');
    }
  }

  async function downloadAllImages() {
    const filtered = getFilteredImages();
    if (!filtered.length) return;

    setImageStatus(`Downloading ${filtered.length} images...`);

    for (let i = 0; i < filtered.length; i += 1) {
      await downloadSingleImageByUrl(filtered[i].url, i);
    }

    setImageStatus(`Downloaded ${filtered.length} images.`);
  }

  async function downloadSelectedImages() {
    const filtered = getFilteredImages().filter((item) => state.selectedUrls.has(item.url));
    if (!filtered.length) return;

    setImageStatus(`Downloading ${filtered.length} selected images...`);

    for (let i = 0; i < filtered.length; i += 1) {
      await downloadSingleImageByUrl(filtered[i].url, i);
    }

    setImageStatus(`Downloaded ${filtered.length} selected images.`);
  }

  async function toggleSelectMode() {
    state.selectMode = !state.selectMode;
    try {
      const response = await sendToContent({ type: 'SET_SELECT_MODE', enabled: state.selectMode });
      if (!response?.ok) throw new Error('Failed to toggle mode.');
      refs.toggleSelectBtn.textContent = state.selectMode ? 'Exit Select Mode' : 'Image Select Mode';
      setImageStatus(state.selectMode ? 'Select mode enabled. Click image on page.' : 'Select mode disabled.');
    } catch (error) {
      state.selectMode = false;
      setImageStatus(error.message);
    }
  }

  function switchTab(tabName) {
    refs.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
    Object.entries(refs.panels).forEach(([name, panel]) => {
      panel.classList.toggle('active', name === tabName);
    });
  }

  function ensureDownloadSelectedButton() {
    if (refs.downloadSelectedBtn) return;

    const btn = document.createElement('button');
    btn.id = 'download-selected-btn';
    btn.className = 'btn';
    btn.textContent = 'Download Selected';
    btn.disabled = true;
    refs.downloadAllBtn.insertAdjacentElement('afterend', btn);
    refs.downloadSelectedBtn = btn;
  }

  function bindEvents() {
    ensureDownloadSelectedButton();

    refs.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    refs.captureBtn.addEventListener('click', captureFullPage);
    refs.downloadShotBtn.addEventListener('click', downloadCapture);
    refs.copyShotBtn.addEventListener('click', copyCaptureToClipboard);

    refs.scanImagesBtn.addEventListener('click', () => scanImages('Scanning page images...'));
    refs.downloadAllBtn.addEventListener('click', downloadAllImages);
    refs.downloadSelectedBtn.addEventListener('click', downloadSelectedImages);
    refs.filter.addEventListener('change', renderImageGrid);
    refs.toggleSelectBtn.addEventListener('click', toggleSelectMode);

    refs.imageGrid.addEventListener('click', async (event) => {
      const downloadBtn = event.target.closest('button[data-download-url]');
      if (downloadBtn) {
        try {
          await downloadSingleImageByUrl(downloadBtn.dataset.downloadUrl, 0);
          setImageStatus('Image downloaded.');
        } catch (error) {
          setImageStatus(`Download failed: ${error.message}`);
        }
      }
    });

    refs.imageGrid.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[data-select-url]');
      if (!checkbox) return;

      if (checkbox.checked) {
        state.selectedUrls.add(checkbox.dataset.selectUrl);
      } else {
        state.selectedUrls.delete(checkbox.dataset.selectUrl);
      }

      updateBulkButtons();
    });

    refs.autoDownload.addEventListener('change', async () => {
      state.settings.autoDownload = refs.autoDownload.checked;
      await saveSettings();
    });

    refs.highRes.addEventListener('change', async () => {
      state.settings.highRes = refs.highRes.checked;
      await saveSettings();
      renderImageGrid();
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'CAPTURE_PROGRESS') {
        setProgress(message.progress || 0);
      }

      if (message.type === 'TRIGGER_AUTO_SCAN') {
        scheduleAutoScan('Screenshot completed. Auto scanning images...');
      }
    });
  }

  (async function init() {
    bindEvents();
    await loadSettings();
    scheduleAutoScan('Popup opened. Auto scanning images...');
  })();
})();

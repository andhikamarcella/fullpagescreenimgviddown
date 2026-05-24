/* global chrome, WebCaptureUtils */
(() => {
  const state = {
    captureDataUrl: null,
    captureFilename: 'capture.png',
    media: [],
    selectMode: false,
    scanning: false,
    scanDebounceTimer: null,
    captureRunning: false,
    visibleRenderLimit: 45,
    selectedKeys: new Set(),
    settings: {
      autoDownload: true,
      highRes: true
    }
  };

  const refs = {
    tabs: [...document.querySelectorAll('.tab')],
    panels: { screenshot: document.getElementById('screenshot-panel'), images: document.getElementById('images-panel'), settings: document.getElementById('settings-panel') },
    captureBtn: document.getElementById('capture-btn'), downloadShotBtn: document.getElementById('download-shot-btn'), copyShotBtn: document.getElementById('copy-shot-btn'), captureStatus: document.getElementById('capture-status'), captureProgress: document.getElementById('capture-progress'),
    scanImagesBtn: document.getElementById('scan-images-btn'), imageStatus: document.getElementById('image-status'), imageGrid: document.getElementById('image-grid'), filter: document.getElementById('filter'), downloadAllBtn: document.getElementById('download-all-btn'), toggleSelectBtn: document.getElementById('toggle-select-btn'), autoDownload: document.getElementById('auto-download'), highRes: document.getElementById('high-res'), downloadSelectedBtn: null
  };
  const mediaKey = (item) => `${item.type}:${item.url}`;
  const qualityLabel = (q) => q.label || q.resolution || q.type || 'Default';

  function getFilteredMedia() {
    const threshold = refs.filter.value;
    const source = [...state.media].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    if (threshold === 'all') return source;
    if (threshold === 'video') return source.filter((i) => i.type === 'video');
    if (threshold === 'image') return source.filter((i) => i.type === 'image');
    const min = Number(threshold);
    return source.filter((item) => (item.width || 0) >= min);
  }
  const getActiveTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  async function sendToContent(message) { const tab = await getActiveTab(); return chrome.tabs.sendMessage(tab.id, message); }
  const setCaptureStatus = (t) => { refs.captureStatus.textContent = t; };
  const setImageStatus = (t) => { refs.imageStatus.textContent = t; };
  const setProgress = (v) => { refs.captureProgress.style.width = `${Math.max(0, Math.min(100, v))}%`; };
  const saveSettings = async () => chrome.storage.sync.set({ wcpSettings: state.settings });
  async function loadSettings() { const res = await chrome.storage.sync.get('wcpSettings'); if (res?.wcpSettings) state.settings = { ...state.settings, ...res.wcpSettings }; refs.autoDownload.checked = state.settings.autoDownload; refs.highRes.checked = state.settings.highRes; }
  function setCaptureControls(r) { state.captureRunning = r; refs.captureBtn.disabled = r; refs.captureBtn.textContent = r ? 'Capturing...' : 'Capture Full Page'; refs.downloadShotBtn.disabled = r || !state.captureDataUrl; refs.copyShotBtn.disabled = r || !state.captureDataUrl; }

  async function captureFullPage() { if (state.captureRunning) return; setCaptureControls(true); setProgress(0); setCaptureStatus('Capturing page...'); try { const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_FULL_PAGE' }); if (!response?.ok) throw new Error(response?.error || 'Capture failed'); state.captureDataUrl = response.dataUrl; state.captureFilename = response.filename || 'capture.png'; setProgress(100); setCaptureStatus('Capture complete.'); if (state.settings.autoDownload) await downloadCapture(); scheduleAutoScan('Screenshot completed. Auto scanning media...'); } catch (error) { setCaptureStatus(`Error: ${error.message}`); } finally { setCaptureControls(false); } }
  async function downloadCapture() { if (!state.captureDataUrl) return; const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_DATA_URL', dataUrl: state.captureDataUrl, filename: state.captureFilename }); setCaptureStatus(response?.ok ? 'Screenshot downloaded.' : `Download failed: ${response?.error || 'Unknown error'}`); }
  async function copyCaptureToClipboard() { if (!state.captureDataUrl) return; const blob = await (await fetch(state.captureDataUrl)).blob(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setCaptureStatus('Copied to clipboard.'); }

  function updateBulkButtons() {
    const filtered = getFilteredMedia();
    const selectedInFiltered = filtered.filter((item) => state.selectedKeys.has(mediaKey(item)));
    refs.downloadAllBtn.disabled = filtered.length === 0 || state.scanning;
    refs.downloadSelectedBtn.disabled = selectedInFiltered.length === 0 || state.scanning;
  }

  function createThumb(item, idx) {
    const selected = state.selectedKeys.has(mediaKey(item));
    const wrapper = document.createElement('article'); wrapper.className = 'thumb';
    const preview = item.type === 'video'
      ? `<video src="${item.url}" muted playsinline preload="metadata"></video>`
      : `<img src="${item.url}" alt="img-${idx}" loading="lazy" />`;
    const qualityOptions = item.type === 'video' && item.qualities?.length
      ? `<select class="quality-select" data-quality-for="${item.url}">${item.qualities.map((q, i) => `<option value="${i}">${qualityLabel(q)}</option>`).join('')}</select>` : '';
    wrapper.innerHTML = `${preview}<div class="thumb-info"><label style="display:flex;gap:6px;align-items:center;margin-bottom:4px;"><input type="checkbox" data-select-key="${mediaKey(item)}" ${selected ? 'checked' : ''} />Select</label><div>${item.type.toUpperCase()} • ${item.width || '?'} × ${item.height || '?'}</div>${qualityOptions}<button class="btn" data-download-url="${item.url}" data-download-type="${item.type}">Download</button></div>`;
    return wrapper;
  }
  function renderImageGrid() { const filtered = getFilteredMedia(); refs.imageGrid.innerHTML = ''; const maxRender = Math.min(filtered.length, 300); let cursor = 0; const renderBatch = () => { if (cursor >= Math.min(maxRender, state.visibleRenderLimit)) { const selectedCount = filtered.filter((i) => state.selectedKeys.has(mediaKey(i))).length; setImageStatus(`Found ${state.media.length} media (${filtered.length} shown, ${selectedCount} selected).`); updateBulkButtons(); return; } const fragment = document.createDocumentFragment(); const end = Math.min(cursor + 20, state.visibleRenderLimit, maxRender); for (let i = cursor; i < end; i += 1) fragment.appendChild(createThumb(filtered[i], i)); refs.imageGrid.appendChild(fragment); cursor = end; requestAnimationFrame(renderBatch); }; requestAnimationFrame(renderBatch); }

  async function scanImages(reason = 'Scanning page media...') { if (state.scanning) return; state.scanning = true; refs.scanImagesBtn.disabled = true; updateBulkButtons(); setImageStatus(reason); try { const response = await sendToContent({ type: 'SCAN_MEDIA' }); if (!response?.ok) throw new Error(response?.error || 'Scan failed'); state.media = (response.media || []).map((item) => ({ ...item, url: item.type === 'image' && state.settings.highRes ? WebCaptureUtils.guessFullSizeUrl(item.url) : item.url })).filter((item) => !!item.url); state.selectedKeys = new Set([...state.selectedKeys].filter((key) => state.media.some((item) => mediaKey(item) === key))); renderImageGrid(); } catch (error) { setImageStatus(`Error: ${error.message}`); } finally { state.scanning = false; refs.scanImagesBtn.disabled = false; updateBulkButtons(); } }
  function scheduleAutoScan(statusText) { if (statusText) setImageStatus(statusText); clearTimeout(state.scanDebounceTimer); state.scanDebounceTimer = setTimeout(() => { scanImages('Auto scanning media...'); }, 350); }

  async function downloadItem(item, index, selectedQualityIndex = 0) {
    const payload = item.type === 'video' ? { type: 'DOWNLOAD_VIDEO_URL', url: item.url, index: index + 1, qualityIndex: selectedQualityIndex, qualities: item.qualities || [] } : { type: 'DOWNLOAD_IMAGE_URL', url: item.url, index: index + 1 };
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(response?.error || 'Unknown download error');
  }
  async function downloadAllImages() { const filtered = getFilteredMedia(); if (!filtered.length) return; setImageStatus(`Downloading ${filtered.length} media files...`); for (let i = 0; i < filtered.length; i += 1) await downloadItem(filtered[i], i); setImageStatus(`Downloaded ${filtered.length} media files.`); }
  async function downloadSelectedImages() { const filtered = getFilteredMedia().filter((item) => state.selectedKeys.has(mediaKey(item))); if (!filtered.length) return; setImageStatus(`Downloading ${filtered.length} selected files...`); for (let i = 0; i < filtered.length; i += 1) await downloadItem(filtered[i], i); setImageStatus(`Downloaded ${filtered.length} selected files.`); }

  async function toggleSelectMode() { state.selectMode = !state.selectMode; try { const response = await sendToContent({ type: 'SET_SELECT_MODE', enabled: state.selectMode }); if (!response?.ok) throw new Error('Failed to toggle mode.'); refs.toggleSelectBtn.textContent = state.selectMode ? 'Exit Select Mode' : 'Image Select Mode'; setImageStatus(state.selectMode ? 'Select mode enabled. Click image on page.' : 'Select mode disabled.'); } catch (error) { state.selectMode = false; setImageStatus(error.message); } }
  function switchTab(tabName) { refs.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName)); Object.entries(refs.panels).forEach(([name, panel]) => panel.classList.toggle('active', name === tabName)); }
  function ensureDownloadSelectedButton() { if (refs.downloadSelectedBtn) return; const btn = document.createElement('button'); btn.id = 'download-selected-btn'; btn.className = 'btn'; btn.textContent = 'Download Selected'; btn.disabled = true; refs.downloadAllBtn.insertAdjacentElement('afterend', btn); refs.downloadSelectedBtn = btn; }

  function bindEvents() { ensureDownloadSelectedButton(); refs.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab))); refs.captureBtn.addEventListener('click', captureFullPage); refs.downloadShotBtn.addEventListener('click', downloadCapture); refs.copyShotBtn.addEventListener('click', copyCaptureToClipboard); refs.scanImagesBtn.addEventListener('click', () => scanImages('Scanning page media...')); refs.downloadAllBtn.addEventListener('click', downloadAllImages); refs.downloadSelectedBtn.addEventListener('click', downloadSelectedImages); refs.filter.addEventListener('change', renderImageGrid); refs.toggleSelectBtn.addEventListener('click', toggleSelectMode);
    refs.imageGrid.addEventListener('click', async (event) => { const downloadBtn = event.target.closest('button[data-download-url]'); if (downloadBtn) { const url = downloadBtn.dataset.downloadUrl; const type = downloadBtn.dataset.downloadType || 'image'; const item = state.media.find((x) => x.url === url && x.type === type); try { const qualityEl = downloadBtn.parentElement.querySelector('.quality-select'); await downloadItem(item || { url, type }, 0, Number(qualityEl?.value || 0)); setImageStatus('Media downloaded.'); } catch (error) { setImageStatus(`Download failed: ${error.message}`); } } });
    refs.imageGrid.addEventListener('change', (event) => { const checkbox = event.target.closest('input[data-select-key]'); if (!checkbox) return; if (checkbox.checked) state.selectedKeys.add(checkbox.dataset.selectKey); else state.selectedKeys.delete(checkbox.dataset.selectKey); updateBulkButtons(); });
    refs.autoDownload.addEventListener('change', async () => { state.settings.autoDownload = refs.autoDownload.checked; await saveSettings(); }); refs.highRes.addEventListener('change', async () => { state.settings.highRes = refs.highRes.checked; await saveSettings(); renderImageGrid(); });
    chrome.runtime.onMessage.addListener((message) => { if (message.type === 'CAPTURE_PROGRESS') setProgress(message.progress || 0); if (message.type === 'TRIGGER_AUTO_SCAN') scheduleAutoScan('Screenshot completed. Auto scanning media...'); }); }

  (async function init() { bindEvents(); await loadSettings(); scheduleAutoScan('Popup opened. Auto scanning media...'); })();
})();

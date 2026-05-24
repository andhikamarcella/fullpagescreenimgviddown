# Web Capture Pro (Chrome Extension)

**Web Capture Pro** adalah Chrome Extension (Manifest V3) untuk workflow screenshot dan image scraping/downloading secara cepat.

## Fitur Utama

- ✅ Full page screenshot (scroll + auto stitch)
- ✅ Download PNG hasil capture
- ✅ Copy hasil screenshot ke clipboard
- ✅ Smart image scanner:
  - `img`
  - `picture/source`
  - lazy attributes (`data-src`, `data-original`, dll)
  - `background-image`
- ✅ Filter resolusi (`All`, `>500px`, `>1000px`)
- ✅ Download image satu per satu
- ✅ Download all images
- ✅ Full-size URL extraction (thumbnail/small/size query cleanup)
- ✅ Click-to-download mode (Image Select Mode)
- ✅ Dark dashboard UI (popup 500px)

## Struktur

```bash
web-capture-pro/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.css
├── popup.js
├── utils.js
└── icons/
    └── icon.svg
```

## Cara Install (Developer Mode)

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode**
3. Klik **Load unpacked**
4. Pilih folder: `web-capture-pro`

## Cara Pakai

### 1) Screenshot Full Page
- Buka tab **Screenshot**
- Klik **Capture Full Page**
- Jika setting auto-download aktif, file langsung terunduh
- Atau gunakan tombol:
  - **Download PNG**
  - **Copy to Clipboard**

### 2) Smart Image Downloader
- Buka tab **Images**
- Klik **Scan Images**
- Gunakan filter resolusi sesuai kebutuhan
- Klik **Download** untuk satu image
- Klik **Download All** untuk batch

### 3) Image Select Mode
- Di tab **Images**, klik **Image Select Mode**
- Kembali ke halaman web, hover/click pada gambar
- Gambar akan otomatis di-download
- Klik lagi tombol popup untuk exit mode

## Permissions

Extension menggunakan permissions:

- `storage`
- `activeTab`
- `scripting`
- `downloads`
- `tabs`
- Host permission: `"<all_urls>"`

## Catatan Teknis

- Manifest V3 + service worker (`background.js`)
- Tanpa external library
- Ada guard untuk mencegah overload saat stitching halaman besar
- Desain modular: helper utility di `utils.js`

## Icon

Icon extension disediakan dalam format SVG:

- `web-capture-pro/icons/icon.svg`

> Note: Chrome action icon pada toolbar biasanya optimal memakai PNG size set (16/32/48/128). SVG tetap disertakan sebagai aset utama sesuai request.

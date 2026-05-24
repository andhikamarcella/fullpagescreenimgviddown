/* global self */
(function initUtils(globalScope) {
  const THUMB_PATTERNS = [
    { regex: /([_-])(thumb|thumbnail|small|tiny)(?=[._/-])/gi, replace: '$1large' },
    { regex: /(\b|[_-])(\d{2,4})x(\d{2,4})(?=\b|[_-]|\.)/gi, replace: '$11000x1000' },
    { regex: /([?&])(w|width|h|height)=\d+/gi, replace: '$1' },
    { regex: /([?&])(size|quality)=([^&]+)/gi, replace: '$1' }
  ];

  function safeFilename(value, fallback = 'file') {
    return String(value || fallback)
      .trim()
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 120) || fallback;
  }

  function parseUrl(raw, baseHref) {
    try {
      return new URL(raw, baseHref || location.href);
    } catch (err) {
      return null;
    }
  }

  function normalizeImageUrl(raw, baseHref) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.trim().replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return null;
    const parsed = parseUrl(cleaned, baseHref);
    return parsed ? parsed.href : null;
  }

  function guessFullSizeUrl(inputUrl) {
    const parsed = parseUrl(inputUrl);
    if (!parsed) return inputUrl;

    let updated = parsed.pathname;
    THUMB_PATTERNS.forEach((pattern) => {
      updated = updated.replace(pattern.regex, pattern.replace);
    });
    parsed.pathname = updated;

    const deleteKeys = ['w', 'width', 'h', 'height', 'size', 'quality', 'fit', 'crop'];
    deleteKeys.forEach((key) => parsed.searchParams.delete(key));

    return parsed.href.replace(/[?&]$/, '');
  }

  function parseSrcSet(srcset) {
    if (!srcset) return [];
    return srcset
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [url, descriptor] = entry.split(/\s+/);
        return {
          url,
          descriptor: descriptor || ''
        };
      });
  }

  function pickLargestFromSrcSet(srcset, baseHref) {
    const candidates = parseSrcSet(srcset)
      .map((item) => ({
        href: normalizeImageUrl(item.url, baseHref),
        score: item.descriptor.endsWith('w')
          ? Number.parseInt(item.descriptor, 10)
          : item.descriptor.endsWith('x')
            ? Number.parseFloat(item.descriptor) * 1000
            : 0
      }))
      .filter((item) => item.href);

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].href;
  }

  function domainTimestampFilename(extension, prefix = 'capture', domain = '') {
    const d = new Date();
    const ts = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
      '_',
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0')
    ].join('');
    const safeDomain = safeFilename(domain || 'site', 'site');
    return `${safeFilename(prefix)}_${safeDomain}_${ts}.${extension}`;
  }

  globalScope.WebCaptureUtils = {
    safeFilename,
    normalizeImageUrl,
    guessFullSizeUrl,
    parseSrcSet,
    pickLargestFromSrcSet,
    domainTimestampFilename
  };
})(typeof self !== 'undefined' ? self : window);

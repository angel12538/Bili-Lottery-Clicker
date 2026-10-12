/* Shared by the service worker and content script. Keep IDs as strings. */
globalThis.BiliLottery = Object.freeze({
  normalizeLink(value, supportTLinks = true) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      const pattern = url.hostname === 'www.bilibili.com'
        ? /^\/opus\/(\d+)\/?$/
        : supportTLinks && url.hostname === 't.bilibili.com' ? /^\/(\d+)\/?$/ : null;
      const match = pattern && url.pathname.match(pattern);
      return match ? `https://www.bilibili.com/opus/${match[1]}` : null;
    } catch { return null; }
  },
  isBiliPage(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'));
    } catch { return false; }
  },
  jitter(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
});

// Shared by the isolated content script and the service worker. Never eval RSC.
(() => {
  const MAX_TEXT = 2 * 1024 * 1024;
  function candidates(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) return [];
    // Plain JSON and JSON embedded in Next flight string literals (\" / \\\").
    const pattern = /["']publicAccessToken\\*["']\s*:\s*\\*["'](eyJ[A-Za-z0-9._~-]{20,16384})\\*["']/g;
    const out = [];
    for (const match of text.matchAll(pattern)) {
      if (match[1].split('.').length === 3 && !out.includes(match[1])) out.push(match[1]);
      if (out.length >= 32) break;
    }
    return out;
  }
  globalThis.ArenaPageTokens = {candidates, MAX_TEXT};
})();

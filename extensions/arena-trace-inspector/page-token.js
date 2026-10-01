// Read script payloads, not chat/user-rendered HTML. Candidates stay in memory.
(() => {
  let sent = '',
    timer = 0,
    inFlight = '',
    scanVersion = 0;
  const sessionAt = () => (location.origin === 'https://arena.ai' ? location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] : null);
  const scan = async (force = false) => {
    timer = 0;
    const sessionId = sessionAt();
    if (!sessionId) {
      sent = '';
      return false;
    }
    const pageUrl = location.href,
      options = [];
    let bytes = 0;
    for (const script of document.scripts || []) {
      const text = script.textContent || '';
      bytes += text.length;
      if (bytes > ArenaPageTokens.MAX_TEXT) break;
      for (const token of ArenaPageTokens.candidates(text)) {
        try {
          const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const c = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
          const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
          if (c.pub !== true || c.iss !== 'https://id.trigger.dev' || !aud.includes('https://api.trigger.dev')) continue;
          if (!Array.isArray(c.scopes) || !c.scopes.includes('read:sessions:' + sessionId) || !Number.isFinite(c.exp) || c.exp <= Date.now() / 1000 + 5) continue;
          const runs = c.scopes.filter(s => typeof s === 'string' && s.startsWith('read:runs:'));
          if (runs.length > 1 || runs.some(s => !/^read:runs:run_[a-zA-Z0-9]+$/.test(s))) continue;
          options.push({token, exp: c.exp, run: runs.length === 1});
        } catch {}
      }
    }
    options.sort((a, b) => Number(b.run) - Number(a.run) || b.exp - a.exp);
    const token = options[0]?.token;
    if (!token) return false;
    const key = sessionId + ':' + token;
    if ((!force && sent === key) || inFlight === key) return true;
    const version = ++scanVersion;
    inFlight = key;
    try {
      const result = await chrome.runtime.sendMessage({type: 'ATI_PAGE_TOKEN', token, pageUrl});
      // Failure before listening must not suppress the later explicit rescan.
      if (result?.ok && version === scanVersion && sessionAt() === sessionId) sent = key;
      return result?.ok === true;
    } catch {
      return false;
    } finally {
      if (version === scanVersion) inFlight = '';
    }
  };
  const schedule = () => {
    if (!timer)
      timer = setTimeout(() => {
        void scan();
      }, 250);
  };
  void scan();
  new MutationObserver(schedule).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'ATI_SCAN_PAGE_TOKEN') {
      clearTimeout(timer);
      timer = 0;
      // A previous request may belong to a listener that was stopped/restarted.
      scanVersion++;
      inFlight = '';
      sent = '';
      scan(true).then(
        found => {
          if (reply) reply({found});
        },
        () => {
          if (reply) reply({found: false});
        }
      );
      return true;
    }
  });
})();

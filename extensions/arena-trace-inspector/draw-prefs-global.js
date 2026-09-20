/* Auto-draw preferences (2.0.0): the message text each round sends and the "keep only gpt-6 / fable-5" filter.
   Pure helpers shared by the service worker (draw-prefs.js) and the page scripts (draw-prefs-global.js). Keep both files in sync. */
(() => {
  const DEFAULT_PROMPT = '1+1=';
  const MAX_PROMPT = 200;
  const KEY = 'ati.autoDraw.prefs.v1';
  // Which model names count as "gpt-6 / fable-5"? Major-version match: the prefix must be followed by '.', '-' or the end,
  // so fable-5 covers claude-fable-5, claude-fable-5-1, claude-fable-5.1-high/-max, 5.2… (NOT fable-50 / fable-6), and gpt-6
  // covers gpt-6, gpt-6-astra-low/-medium, gpt-6.1… (NOT gpt-60 / gpt-5.6). Both layers are accepted: the Arena internal
  // name (gpt-6-astra-low, claude-fable-5.1-max) and the server label (gpt-6-astra, claude-fable-5-1). Codenames never match.
  const KEEP = [/^gpt-6(?:[.-]|$)/i, /(?:^|-)fable-5(?:[.-]|$)/i];
  // One line, no control characters, trimmed, bounded; empty falls back to the default.
  function normalizePrompt(v) {
    if (typeof v !== 'string') return DEFAULT_PROMPT;
    const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, MAX_PROMPT);
    return t || DEFAULT_PROMPT;
  }
  function sanitize(value) {
    return {schemaVersion: 1, prompt: normalizePrompt(value?.prompt), keepOnly: value?.keepOnly === true};
  }
  const defaults = () => sanitize(null);
  const name = m => typeof m === 'string' ? m : (m && typeof m === 'object' && typeof m.model === 'string') ? m.model : '';
  // True when the model is one to keep. `models` is the view's models list (each {model, serverLabel?, internal?}) or plain strings.
  function shouldKeep(models) {
    const list = Array.isArray(models) ? models : [models];
    return list.some(m => {
      const candidates = [name(m), m && typeof m === 'object' && typeof m.serverLabel === 'string' ? m.serverLabel : ''].filter(Boolean);
      return candidates.some(c => KEEP.some(re => re.test(c)));
    });
  }
  function createDrawPrefsStore(area, ready = Promise.resolve(true)) {
    let queue = Promise.resolve();
    async function read() { if (!await ready) throw Error('storage unavailable'); return sanitize((await area.get(KEY))[KEY]); }
    return {
      async get() { await queue; return read(); },
      save(input) {
        const work = queue.then(async () => {
          const current = await read();
          const next = sanitize({prompt: typeof input?.prompt === 'string' ? input.prompt : current.prompt, keepOnly: typeof input?.keepOnly === 'boolean' ? input.keepOnly : current.keepOnly});
          await area.set({[KEY]: next}); return next;
        });
        queue = work.catch(() => {}); return work;
      }
    };
  }
  globalThis.ArenaDrawPrefs = {DEFAULT_PROMPT, MAX_PROMPT, KEY, normalizePrompt, sanitize, defaults, shouldKeep, createDrawPrefsStore};
})();

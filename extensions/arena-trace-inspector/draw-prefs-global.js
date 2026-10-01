/* Auto-draw preferences: the message text each round sends.
   Pure helpers shared by the service worker (draw-prefs.js) and the page scripts (draw-prefs-global.js). Keep both files in sync. */
(() => {
  const DEFAULT_PROMPT = '1+1=';
  const MAX_PROMPT = 200;
  const KEY = 'ati.autoDraw.prefs.v1';
  // One line, no control characters, trimmed, bounded; empty falls back to the default.
  function normalizePrompt(v) {
    if (typeof v !== 'string') return DEFAULT_PROMPT;
    const t = v
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .trim()
      .slice(0, MAX_PROMPT);
    return t || DEFAULT_PROMPT;
  }
  function sanitize(value) {
    return {schemaVersion: 1, prompt: normalizePrompt(value?.prompt)};
  }
  const defaults = () => sanitize(null);
  function createDrawPrefsStore(area, ready = Promise.resolve(true)) {
    let queue = Promise.resolve();
    async function read() {
      if (!(await ready)) throw Error('storage unavailable');
      return sanitize((await area.get(KEY))[KEY]);
    }
    return {
      async get() {
        await queue;
        return read();
      },
      save(input) {
        const work = queue.then(async () => {
          const current = await read();
          const next = sanitize({prompt: typeof input?.prompt === 'string' ? input.prompt : current.prompt});
          await area.set({[KEY]: next});
          return next;
        });
        queue = work.catch(() => {});
        return work;
      }
    };
  }
  globalThis.ArenaDrawPrefs = {DEFAULT_PROMPT, MAX_PROMPT, KEY, normalizePrompt, sanitize, defaults, createDrawPrefsStore};
})();

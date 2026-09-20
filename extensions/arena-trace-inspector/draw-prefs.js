/* ESM entry for the service worker and tests; the implementation lives in draw-prefs-global.js (classic script, also loaded on the page). */
import './draw-prefs-global.js';
const P = globalThis.ArenaDrawPrefs;
export const DEFAULT_PROMPT = P.DEFAULT_PROMPT, MAX_PROMPT = P.MAX_PROMPT, DRAW_PREF_KEY = P.KEY;
export const normalizePrompt = P.normalizePrompt, sanitize = P.sanitize, defaults = P.defaults, shouldKeep = P.shouldKeep, createDrawPrefsStore = P.createDrawPrefsStore;

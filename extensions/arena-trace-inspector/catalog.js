(() => {
/* Model catalog parsing for arena.ai's text-route RSC payload. Pure, no I/O, no DOM.
   The payload is the page's own flight text served at /text/side-by-side with header RSC:1;
   it embeds `initialModels`, the same directory the Direct/Side-by-Side pickers present.
   Values are sanitized like every other external read in this extension: strings are
   length-capped and shape-checked, numbers must be finite, the unranked sentinel is tagged. */

const SEG = /^[\w .():+/-]{1,160}$/;
const UNRANKED_SENTINEL = 1e15;
const BOARDS = {webdev: 'Webdev', image: '图像', search: '搜索', video: '视频'};

const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const cleanName = v => (typeof v === 'string' && SEG.test(v) ? v : '');
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cleanRank(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > UNRANKED_SENTINEL) return {rank: null, unranked: true};
    if (value >= 0) return {rank: Math.round(value), unranked: false};
  }
  return {rank: null, unranked: false};
}

// Capability booleans and minimal objects -> stable keys. `table` maps each key to a
// display word, so a capability the client has never seen is skipped rather than shown raw.
const CAP_TABLE = {text: '文本', image: '图像', web: '联网', search: '搜索', file: '文件', video: '视频', code: '代码'};
function cleanCapabilities(value) {
  const out = {input: [], output: []};
  if (!value || typeof value !== 'object') return out;
  for (const side of ['input', 'output']) {
    const section = value[side + 'Capabilities'];
    if (!section || typeof section !== 'object') continue;
    for (const key of ['text', 'image', 'file', 'video', 'web', 'search', 'code']) {
      const v = section[key];
      const on = v === true || (v && typeof v === 'object');
      if (on && CAP_TABLE[key]) out[side].push(key);
    }
  }
  return out;
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanName(raw.name) || cleanName(raw.publicName) || cleanName(raw.displayName);
  if (!name) return null;
  const id = cleanName(raw.id);
  const entry = {
    id: id || '',
    organization: cleanName(raw.organization),
    provider: cleanName(raw.provider),
    publicName: cleanName(raw.publicName) || name,
    name,
    displayName: cleanName(raw.displayName) || name,
    capabilities: cleanCapabilities(raw.capabilities),
    rank: cleanRank(raw.rank).rank,
    unranked: cleanRank(raw.rank).unranked,
    chatRank: null,
    chatUnranked: false,
    boardUnranked: {},
    rankByModality: {},
    userSelectable: typeof raw.userSelectable === 'boolean' ? raw.userSelectable : null
  };
  const rbm = raw.rankByModality && typeof raw.rankByModality === 'object' ? raw.rankByModality : {};
  // Every board the catalogue actually carries (chat 133, webdev 88, video 75, image 45, search 17
  // entries in the live payload). An unknown board is dropped rather than shown raw.
  for (const key of ['chat', 'webdev', 'image', 'search', 'video']) {
    const r = cleanRank(rbm[key]);
    entry.rankByModality[key] = r.rank;
    if (r.rank !== null || r.unranked) entry.boardUnranked[key] = r.unranked;
    if (key === 'chat') { entry.chatRank = r.rank; entry.chatUnranked = r.unranked; }
  }
  return entry;
}

function parseCatalogFlight(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('载荷超限');
  const at = text.indexOf('"initialModels":[');
  if (at < 0) throw new Error('目录不存在');
  let depth = 0;
  const start = text.indexOf('[', at);
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('目录截断');
  let list;
  try { list = JSON.parse(text.slice(start, end)); } catch { throw new Error('目录解析失败'); }
  if (!Array.isArray(list) || !list.length || list.length > 2000) return [];
  return list.map(cleanEntry).filter(Boolean);
}

// Exact-norm match over name > publicName > displayName; a tie across different ids
// resolves to null -- never guess between two catalogue rows.
function findCatalogEntry(catalog, name) {
  if (!Array.isArray(catalog) || typeof name !== 'string' || !name || name.length > 200) return null;
  const n = normName(name);
  if (!n) return null;
  const scoreOf = e => normName(e.name) === n ? 0 : normName(e.publicName) === n ? 1 : normName(e.displayName) === n ? 2 : -1;
  let best = null, bestScore = 99, tie = false;
  for (const entry of catalog) {
    const score = scoreOf(entry);
    if (score < 0) continue;
    if (score < bestScore) { best = entry; bestScore = score; tie = false; }
    else if (score === bestScore && best && entry.id !== best.id) tie = true;
  }
  return tie ? null : best;
}

function capabilityText(side, list) {
  if (!list.length) return '';
  return list.map(key => CAP_TABLE[key] || key).join(' / ');
}

// Rows for one catalogue entry. `translate` lets tests and callers localize without I/O.
function catalogRows(entry, {rankLabel = '#', unrankedText = '未上榜'} = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const rows = [];
  if (entry.organization || entry.provider) {
    rows.push({label: '组织 / 供应商', value: [entry.organization, entry.provider].filter(Boolean).join(' · ')});
  }
  if (entry.publicName && normName(entry.publicName) !== normName(entry.name)) {
    rows.push({label: '公开名', value: entry.publicName});
  }
  // Ranking lives at two levels and "unranked" is a sentinel value, not a missing field -- 179 of
  // the 301 live rows carry no top-level rank at all. The modality-specific chat rank wins; other
  // boards are reported alongside, because a webdev-only model simply has no chat rank to give.
  const chat = entry.chatRank ?? entry.rankByModality?.chat;
  const otherBoards = ['webdev', 'image', 'search', 'video']
    .filter(key => typeof entry.rankByModality?.[key] === 'number')
    .map(key => BOARDS[key] + ' ' + rankLabel + entry.rankByModality[key]);
  const sawSentinel = Object.keys(entry.boardUnranked || {}).length > 0 || entry.unranked;
  if (typeof chat === 'number') rows.push({label: '排行榜 Chat 排名', value: [rankLabel + chat].concat(otherBoards).join(' · ')});
  else if (otherBoards.length) rows.push({label: '排行榜（Chat 未上榜）', value: otherBoards.join(' · ')});
  else if (sawSentinel) rows.push({label: '排行榜 Chat 排名', value: unrankedText});
  const caps = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
  const input = capabilityText('input', Array.isArray(caps.input) ? caps.input : []);
  const output = capabilityText('output', Array.isArray(caps.output) ? caps.output : []);
  if (input || output) {
    rows.push({label: '能力', value: (input ? '输入 ' + input : '') + (input && output ? ' · ' : '') + (output ? '输出 ' + output : '')});
  }
  return rows;
}
const CATALOG_URL = 'https://arena.ai/text/side-by-side';
const CATALOG_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // the directory changes on the order of days
const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 10000;

// Same shape as the balance reader: memory-only, one in-flight request, never persisted.
function createCatalogReader({fetch: doFetch, now = () => Date.now(), minIntervalMs = CATALOG_MIN_INTERVAL_MS, timeoutMs = CATALOG_TIMEOUT_MS} = {}) {
  let cache = null, lastAt = 0, inflight = null, lastError = null;
  async function read({force = false} = {}) {
    if (inflight) return inflight;
    if (!force && cache && now() - lastAt < minIntervalMs) return {catalog: cache, cached: true, error: lastError};
    if (force && cache && now() - lastAt < 5000) return {catalog: cache, cached: true, error: lastError};
    inflight = (async () => {
      // Same wedge hazard as the balance reader: a request that never settles would pin `inflight`
      // for the life of the service worker and every later read would return that dead promise.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await doFetch(CATALOG_URL, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: {RSC: '1', Accept: 'text/x-component'}, signal: abort.signal
        });
        lastAt = now();
        if (res.status === 401 || res.status === 403) { lastError = '未登录或无权限（HTTP ' + res.status + '）'; return {catalog: cache, cached: !!cache, error: lastError}; }
        if (!res.ok) { lastError = '模型目录接口返回 HTTP ' + res.status; return {catalog: cache, cached: !!cache, error: lastError}; }
        const text = await res.text();
        if (text.length > CATALOG_MAX_BYTES) { lastError = '模型目录超过 2 MB，已停止解析'; return {catalog: cache, cached: !!cache, error: lastError}; }
        const parsed = parseCatalogFlight(text);
        if (!parsed.length) { lastError = '模型目录为空或格式不符合预期'; return {catalog: cache, cached: !!cache, error: lastError}; }
        cache = parsed; lastError = null;
        return {catalog: cache, cached: false, error: null};
      } catch (e) {
        lastAt = now(); lastError = '模型目录读取失败：' + (e?.message || '网络错误');
        return {catalog: cache, cached: !!cache, error: lastError};
      } finally { clearTimeout(timer); inflight = null; }
    })();
    return inflight;
  }
  return {read, peek: () => ({catalog: cache, cached: true, error: lastError}), clear: () => { cache = null; lastAt = 0; lastError = null; }};
}
  globalThis.ArenaCatalog = {parseCatalogFlight, findCatalogEntry, catalogRows, createCatalogReader, CATALOG_URL, CATALOG_MIN_INTERVAL_MS, CATALOG_MAX_BYTES, CATALOG_TIMEOUT_MS};
})();

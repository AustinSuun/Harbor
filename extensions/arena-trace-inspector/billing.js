/* Arena account balance (GET https://arena.ai/api/billing/balance, same-origin cookies). Pure helpers + a small cached reader.
   Nothing is persisted: the value lives in service-worker memory only and is re-read on demand (>= 60 s apart). */
export const BALANCE_URL = 'https://arena.ai/api/billing/balance';
export const BALANCE_MIN_INTERVAL_MS = 60000;
export const BALANCE_TIMEOUT_MS = 10000;
const int = v => Number.isSafeInteger(v) && v >= 0 ? v : null;

// Whitelist parse of the JSON body. Unknown keys are dropped; a malformed body yields null.
export function parseBalance(body, receivedAt = new Date().toISOString()) {
  let data = body;
  if (typeof data === 'string') { if (data.length > 4096) return null; try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const remaining = int(data.creditsRemaining), daily = int(data.dailyFreeCredits);
  if (remaining === null && daily === null) return null;
  const refreshedAt = typeof data.refreshedAt === 'string' && data.refreshedAt.length <= 40 && Number.isFinite(Date.parse(data.refreshedAt)) ? data.refreshedAt : null;
  return {creditsRemaining: remaining, dailyFreeCredits: daily, refreshedAt, receivedAt};
}

// Display text. 1 credit is shown as-is; USD is NOT derived (the conversion is unknown and must not be guessed).
export const shortNumber = v => typeof v !== 'number' ? '—' : v >= 1e6 ? trim(v / 1e6) + 'M' : v >= 1e3 ? trim(v / 1e3) + 'K' : String(v);
const trim = x => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
const stamp = iso => { if (!iso) return '—'; const d = new Date(iso); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
// value/note stay for the compact HUD field; short/pct/rows/tone feed the ring card. USD is never derived.
export function formatBalance(b) {
  if (!b) return {value: '未提供', note: '未读取', short: '—', total: '—', pct: null, tone: 'none', rows: []};
  const n = v => typeof v === 'number' ? v.toLocaleString('zh-CN') : '未提供';
  const pct = typeof b.creditsRemaining === 'number' && typeof b.dailyFreeCredits === 'number' && b.dailyFreeCredits > 0 ? Math.round(b.creditsRemaining / b.dailyFreeCredits * 1000) / 10 : null;
  const tone = pct === null ? 'none' : pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'low';
  const rows = [['剩余', n(b.creditsRemaining) + ' / ' + n(b.dailyFreeCredits)], ['下次额度重置', stamp(b.refreshedAt)], ['读取', stamp(b.receivedAt) + (typeof b.latencyMs === 'number' ? ' (' + b.latencyMs + 'ms)' : '')]];
  return {value: n(b.creditsRemaining) + (pct !== null ? ' · ' + pct + '%' : ''), note: '每日额度 ' + n(b.dailyFreeCredits) + ' credits' + (b.refreshedAt ? ' · 下次额度重置于 ' + stamp(b.refreshedAt) : ''), short: shortNumber(b.creditsRemaining), total: shortNumber(b.dailyFreeCredits), pct, tone, rows};
}

export function createBalanceReader({fetch: doFetch, now = () => Date.now(), minIntervalMs = BALANCE_MIN_INTERVAL_MS, timeoutMs = BALANCE_TIMEOUT_MS} = {}) {
  let cache = null, lastAt = 0, inflight = null, lastError = null;
  async function read({force = false} = {}) {
    if (inflight) return inflight;
    if (!force && cache && now() - lastAt < minIntervalMs) return {balance: cache, cached: true, error: lastError};
    // A forced read always goes to the network: the old 5 s floor made clicking the refresh button
    // twice look like it did nothing, which is exactly when someone is checking a fresh login.
    inflight = (async () => {
      // Without this the reader wedges: one request that never settles leaves `inflight` set for
      // the life of the service worker, and every later read -- including a forced one -- returns
      // that same dead promise. The card then shows a previous account's balance forever, and a
      // page reload cannot clear it because the worker outlives the page.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const t0 = now();
        const res = await doFetch(BALANCE_URL, {method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: {Accept: 'application/json'}, signal: abort.signal});
        lastAt = now(); const latencyMs = Math.max(0, lastAt - t0);
        // 403 here means the route itself was refused, not that the session is bad: arena.ai
        // retired /api/billing/balance and now answers every unknown route the same way. Saying
        // "未登录" sent the user looking for a login problem that did not exist.
        if (res.status === 401) { lastError = '未登录（HTTP 401）'; return {balance: cache, cached: !!cache, error: lastError}; }
        if (res.status === 403) { lastError = '额度接口已被拒绝（HTTP 403）：arena.ai 已下线该路由，此数值不会再更新'; return {balance: cache, cached: !!cache, error: lastError}; }
        if (res.status === 429) { lastError = '余额接口限流（HTTP 429），稍后再试'; return {balance: cache, cached: !!cache, error: lastError}; }
        if (!res.ok) { lastError = '余额接口返回 HTTP ' + res.status; return {balance: cache, cached: !!cache, error: lastError}; }
        const parsed = parseBalance(await res.text());
        if (!parsed) { lastError = '余额响应格式不符合预期'; return {balance: cache, cached: !!cache, error: lastError}; }
        cache = {...parsed, latencyMs}; lastError = null;
        return {balance: cache, cached: false, error: null};
      } catch (e) {
        lastAt = now(); lastError = '余额读取失败：' + (e?.message || '网络错误');
        return {balance: cache, cached: !!cache, error: lastError};
      } finally { clearTimeout(timer); inflight = null; }
    })();
    return inflight;
  }
  return {read, peek: () => ({balance: cache, cached: true, error: lastError}), clear: () => { cache = null; lastAt = 0; lastError = null; }};
}

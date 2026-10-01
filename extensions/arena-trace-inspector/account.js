/* Account identity (2.3.0): GET https://arena.ai/api/me, same-origin cookies.
   Verified 2026-09-21: returns 200 with {user:{id, supabaseUserId, email, ...}}.
   `id` is a stable UUID and is what records are keyed by.
   The user explicitly asked for the full email to be stored as well; it is personal
   data, so exports carry a warning banner. supabaseUserId and every other field are
   dropped. */
const ME_URL = 'https://arena.ai/api/me';
const ACCOUNT_MIN_INTERVAL_MS = 300000; // 5 min

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

export function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  return email.slice(0, Math.min(3, at)) + '***' + email.slice(at);
}

export function parseAccount(body) {
  let data = body;
  if (typeof data === 'string') {
    if (data.length > 8192) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const user = data && typeof data === 'object' ? data.user : null;
  if (!user || typeof user !== 'object') return null;
  const id = typeof user.id === 'string' && ID_RE.test(user.id) ? user.id : null;
  if (!id) return null;
  const email = typeof user.email === 'string' && user.email.length <= 254 && user.email.includes('@') ? user.email : null;
  return {accountId: id, ...(email ? {email, emailMasked: maskEmail(email)} : {})};
}

// Storage keys embed accountId, so anything outside the charset must never reach them.
export function accountKeyPart(accountId) {
  if (typeof accountId !== 'string' || !ID_RE.test(accountId)) throw new Error('账号 ID 无效');
  return accountId;
}

export function createAccountReader({fetch: doFetch, now = () => Date.now(), minIntervalMs = ACCOUNT_MIN_INTERVAL_MS} = {}) {
  let cache = null,
    lastAt = 0,
    inflight = null,
    lastError = null;
  async function read({force = false} = {}) {
    if (inflight) return inflight;
    if (!force && cache && now() - lastAt < minIntervalMs) return {account: cache, cached: true, error: lastError};
    inflight = (async () => {
      try {
        const res = await doFetch(ME_URL, {method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: {Accept: 'application/json'}});
        lastAt = now();
        if (res.status === 401 || res.status === 403) {
          lastError = '未登录或无权限（HTTP ' + res.status + '）';
          return {account: cache, cached: !!cache, error: lastError};
        }
        if (!res.ok) {
          lastError = '账号接口返回 HTTP ' + res.status;
          return {account: cache, cached: !!cache, error: lastError};
        }
        const parsed = parseAccount(await res.text());
        if (!parsed) {
          lastError = '账号响应格式不符合预期';
          return {account: cache, cached: !!cache, error: lastError};
        }
        cache = parsed;
        lastError = null;
        return {account: cache, cached: false, error: null};
      } catch (e) {
        lastAt = now();
        lastError = '账号读取失败：' + (e?.message || '网络错误');
        return {account: cache, cached: !!cache, error: lastError};
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }
  return {
    read,
    peek: () => ({account: cache, cached: true, error: lastError}),
    clear: () => {
      cache = null;
      lastAt = 0;
      lastError = null;
    }
  };
}

/* Classic-script bridge for HUD/popup: pulse formatting only (no fetch). Keep in sync with billing.js formatPulse. */
(() => {
  const percentage = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
  const readHeader = (headers, name) => {
    if (!headers) return null;
    const target = String(name || '').toLowerCase();
    if (typeof headers.get === 'function') {
      const direct = headers.get(name) ?? headers.get(target);
      if (typeof direct === 'string') return direct;
    }
    if (Array.isArray(headers)) {
      for (const item of headers) {
        if (Array.isArray(item) && String(item[0] || '').toLowerCase() === target && typeof item[1] === 'string') return item[1];
        if (item && typeof item === 'object' && String(item.name || '').toLowerCase() === target && typeof item.value === 'string') return item.value;
      }
      return null;
    }
    if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === target && (typeof v === 'string' || typeof v === 'number')) return String(v);
      }
    }
    return null;
  };
  function parseRateLimitHeaders(headers, receivedAt = new Date().toISOString()) {
    if (!headers) return null;
    const rawLimit = readHeader(headers, 'ratelimit-limit');
    const rawRemaining = readHeader(headers, 'ratelimit-remaining');
    if (rawLimit === null || rawRemaining === null) return null;
    const limit = Number.parseInt(String(rawLimit).trim(), 10);
    const remaining = Number.parseInt(String(rawRemaining).trim(), 10);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000000) return null;
    if (!Number.isInteger(remaining) || remaining < 0) return null;
    const safeReceivedAt = typeof receivedAt === 'string' && Number.isFinite(Date.parse(receivedAt)) ? new Date(Date.parse(receivedAt)).toISOString() : new Date().toISOString();
    const baseMs = Date.parse(safeReceivedAt);
    let resetAt = null;
    const rawReset = readHeader(headers, 'ratelimit-reset');
    if (rawReset !== null) {
      const n = Number.parseInt(String(rawReset).trim(), 10);
      if (Number.isInteger(n) && n > 0) {
        const resetMs = n > 1000000000 ? n * 1000 : baseMs + n * 1000;
        if (Number.isFinite(resetMs)) resetAt = new Date(resetMs).toISOString();
      }
    }
    return {
      limit,
      remaining: Math.min(limit, remaining),
      resetAt,
      receivedAt: safeReceivedAt
    };
  }
  const cleanBucket = b => {
    if (!b || typeof b !== 'object') return null;
    if (!Number.isInteger(b.limit) || b.limit <= 0 || b.limit > 1000000) return null;
    if (!Number.isInteger(b.remaining) || b.remaining < 0) return null;
    if (typeof b.receivedAt !== 'string' || !Number.isFinite(Date.parse(b.receivedAt))) return null;
    const resetAt = typeof b.resetAt === 'string' && Number.isFinite(Date.parse(b.resetAt)) ? b.resetAt : null;
    return {limit: b.limit, remaining: Math.min(b.limit, b.remaining), resetAt, receivedAt: b.receivedAt};
  };
  const newerBucket = (a, b) => {
    const ca = cleanBucket(a),
      cb = cleanBucket(b);
    if (!ca) return cb;
    if (!cb) return ca;
    return Date.parse(cb.receivedAt) >= Date.parse(ca.receivedAt) ? cb : ca;
  };
  function mergeRateLimits(a, b) {
    const createChat = newerBucket(a?.createChat, b?.createChat);
    const apiGeneral = newerBucket(a?.apiGeneral, b?.apiGeneral);
    if (!createChat && !apiGeneral) return null;
    return {
      ...(createChat ? {createChat} : {}),
      ...(apiGeneral ? {apiGeneral} : {})
    };
  }
  function formatRateLimits(rateLimits, nowMs = Date.now()) {
    const fmt = (raw, warnCount) => {
      const b = cleanBucket(raw);
      if (!b) return null;
      const resetMs = b.resetAt ? Date.parse(b.resetAt) : NaN;
      const hasReset = Number.isFinite(resetMs);
      const remainSec = hasReset ? Math.max(0, Math.ceil((resetMs - nowMs) / 1000)) : null;
      const expired = hasReset && nowMs >= resetMs;
      const remaining = expired ? b.limit : b.remaining;
      const pct = Math.max(0, Math.min(100, Math.round((remaining / b.limit) * 100)));
      const tone = expired ? 'good' : remaining <= 0 ? 'low' : remaining <= warnCount || remaining / b.limit <= 0.15 ? 'warn' : 'good';
      const shortReset = remainSec === null ? '' : expired ? '已重置' : remainSec >= 60 ? Math.ceil(remainSec / 60) + 'm' : remainSec + 's';
      const resetText = remainSec === null ? '重置时间未知' : expired ? '窗口已重置' : remainSec >= 60 ? Math.floor(remainSec / 60) + 'm ' + (remainSec % 60) + 's 后重置' : remainSec + 's 后重置';
      return {
        limit: b.limit,
        remaining,
        rawRemaining: b.remaining,
        resetAt: b.resetAt,
        receivedAt: b.receivedAt,
        remainSec,
        expired,
        pct,
        tone,
        shortReset,
        resetText
      };
    };
    const createChat = fmt(rateLimits?.createChat, 3);
    const apiGeneral = fmt(rateLimits?.apiGeneral, 20);
    const tone = createChat?.tone === 'low' || apiGeneral?.tone === 'low' ? 'low' : createChat?.tone === 'warn' || apiGeneral?.tone === 'warn' ? 'warn' : createChat || apiGeneral ? 'good' : 'none';
    return {
      createChat,
      apiGeneral,
      blocked: !!(createChat && !createChat.expired && createChat.remaining <= 0),
      tone
    };
  }
  const stamp = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.getMonth() + 1 + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const pctText = v => (typeof v === 'number' ? (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)) : '—');
  function formatPulse(b) {
    if (!b) return {pct: null, tone: 'none', rows: [], receivedAt: null};
    const pct = percentage(b.pulse);
    const tone = pct === null ? 'none' : pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'low';
    const shown = pctText(pct);
    const rows = [
      ['今日剩余', shown + '%'],
      ['口径', '每日 · 实时'],
      ['读取', stamp(b.receivedAt) + (typeof b.latencyMs === 'number' ? ' (' + b.latencyMs + 'ms)' : '')]
    ];
    return {pct, tone, rows, receivedAt: b.receivedAt || null};
  }
  globalThis.ArenaBilling = {formatPulse, parseRateLimitHeaders, mergeRateLimits, formatRateLimits};
})();

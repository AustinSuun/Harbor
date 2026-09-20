export function isArena(url) {
  try { return new URL(url).origin === 'https://arena.ai'; } catch { return false; }
}

export function streamSession(url) {
  if (!isArena(url)) return null;
  return new URL(url).pathname.match(/^\/ai-proxy\/realtime\/v1\/sessions\/([a-zA-Z0-9-]+)\/out$/)?.[1] || null;
}

export function decode64(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}

// Decoding is NOT signature verification. Trigger.dev validates the token on GET.
export function validateToken(token, sessionId, now = Date.now() / 1000) {
  if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) throw new Error('令牌格式不符合预期');
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(decode64(token.split('.')[1]))); }
  catch { throw new Error('无法解析令牌'); }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.pub !== true || claims.iss !== 'https://id.trigger.dev' || !aud.includes('https://api.trigger.dev')) throw new Error('不是预期的公开运行令牌');
  if (!Number.isFinite(claims.exp) || claims.exp <= now + 5) throw new Error('令牌已过期，请发送新的测试消息');
  const scopes = claims.scopes;
  if (!Array.isArray(scopes) || !scopes.includes('read:sessions:' + sessionId)) throw new Error('令牌与当前流会话不匹配');
  const runs = scopes.filter(s => typeof s === 'string' && /^read:runs:run_[a-zA-Z0-9]+$/.test(s));
  if (runs.length !== 1) throw new Error('令牌必须仅明确指定一个可读取运行');
  return {runId: runs[0].slice('read:runs:'.length), exp: claims.exp};
}

export class SSEParser {
  constructor(onFrame) { this.buffer = ''; this.decoder = new TextDecoder(); this.onFrame = onFrame; }
  push(bytes) {
    this.buffer += this.decoder.decode(bytes, {stream: true});
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (frame.length > 2 * 1024 * 1024) throw new Error('单个流事件过大，停止解析');
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) { let obj; try { obj = JSON.parse(data); } catch { continue; } this.onFrame(obj); }
    }
    if (this.buffer.length > 2 * 1024 * 1024) { this.buffer = ''; throw new Error('流缓冲区超限'); }
  }
}

export function publicTokens(frame) {
  const records = Array.isArray(frame?.records) ? frame.records : [frame];
  const tokens = [];
  for (const record of records) {
    const headers = record?.headers;
    const pairs = Array.isArray(headers) ? headers : headers && typeof headers === 'object' ? Object.entries(headers) : [];
    for (const pair of pairs) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'public-access-token' && typeof pair[1] === 'string') tokens.push(pair[1]);
    }
  }
  return tokens;
}

// Only an explicit ai-provider-* trace icon identifies a provider.
export function traceProvider(icon) {
  return typeof icon==='string' && /^ai-provider-[\w.-]{1,80}$/.test(icon) ? icon.slice(12) : '';
}
export function cleanProvider(value) {
  return typeof value==='string' && /^[\w.-]{1,100}$/.test(value) && !/^(?:hero|tabler|lucide|icon)-/i.test(value) ? value : '';
}
export function extractModels(trace, runId) {
  if (!Array.isArray(trace?.events)) throw new Error('trace 格式不符合预期');
  const found = [];
  for (const event of trace.events) {
    if (event.runId !== runId || event.message !== 'ai.streamText.doStream') continue;
    for (const item of event.style?.accessory?.items || []) {
      if (item.icon !== 'tabler-cube' || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 200) continue;
      found.push({model: item.text, provider: traceProvider(event.style?.icon), spanId: event.spanId, partial: !!event.isPartial});
    }
  }
  return found.filter((x, i) => found.findIndex(y => y.model === x.model && y.provider === x.provider) === i);
}

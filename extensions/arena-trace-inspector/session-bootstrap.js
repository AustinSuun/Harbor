// One bounded, read-only recovery of the CURRENT owner session. No retries, writes,
// token minting, cookie extraction or cross-session lookup. Tokens never leave this call
// except for the valid run token returned privately to the service worker.
import {validateSessionToken, validateToken, SSEParser, publicTokens} from './core.js';
const BASE = 'https://arena.ai/ai-proxy';
const fail = (message, status = null) => Object.assign(new Error(message), {status});
const aborted = () => fail('会话补读已取消');
function sessionInfo(body, sessionId) {
  if (!body || body.externalId !== sessionId) throw fail('会话响应与当前页面不匹配');
  const currentRunId = body.currentRunId ?? null;
  if (currentRunId !== null && (typeof currentRunId !== 'string' || !/^run_[a-zA-Z0-9]+$/.test(currentRunId))) throw fail('会话运行标识格式不符合预期');
  const out = {sessionId, currentRunId};
  for (const key of ['createdAt', 'updatedAt', 'closedAt', 'expiresAt']) {
    const v = body[key];
    if (v === null || (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)))) out[key] = v;
  }
  // No arbitrary metadata/tags/closedReason: they can contain user content.
  return out;
}
async function readStream(response, signal, maxBytes, onChunk) {
  if (!response.body?.getReader) throw fail('响应不支持安全流式读取');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, {once: true});
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw aborted();
      const {done, value} = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) return;
      size += value.byteLength;
      if (size > maxBytes) throw fail('会话补读达到大小上限，已停止');
      if (onChunk(value) === false) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    // Do not wait for a remote streaming source to acknowledge cancellation.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function recoverSessionRun({fetch, token, sessionId, signal, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024, onProgress = () => {}}) {
  const claims = validateSessionToken(token, sessionId);
  const progress = value => {
    try {
      onProgress(value);
    } catch {}
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    Math.max(1, Math.min(timeoutMs, (claims.exp - Date.now() / 1000 - 5) * 1000))
  );
  const request = async (path, accept) => {
    if (controller.signal.aborted) throw aborted();
    const r = await fetch(BASE + path, {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      headers: {Authorization: 'Bearer ' + token, Accept: accept},
      signal: controller.signal
    });
    if (controller.signal.aborted) throw aborted();
    if (!r.ok) {
      void r.body?.cancel().catch(() => {});
      throw fail('会话补读返回 HTTP ' + r.status + '，未自动重试', r.status);
    }
    if (!(r.headers.get('content-type') || '').toLowerCase().includes(accept)) {
      void r.body?.cancel().catch(() => {});
      throw fail('会话补读响应类型不符合预期');
    }
    return r;
  };
  try {
    progress({phase: 'session', message: '正在核对远端会话'});
    const response = await request('/api/v1/sessions/' + encodeURIComponent(sessionId), 'application/json');
    let text = '';
    const decoder = new TextDecoder();
    await readStream(response, controller.signal, 256 * 1024, bytes => {
      text += decoder.decode(bytes, {stream: true});
    });
    text += decoder.decode();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail('会话响应不是有效 JSON');
    }
    const session = sessionInfo(body, sessionId);
    progress({phase: 'session', message: '远端会话已核对', session});
    if (!session.currentRunId) return {session, token: null, reason: 'no-run'};
    progress({phase: 'replay', message: '正在回放当前会话，等待有效 run 授权'});
    const stream = await request('/realtime/v1/sessions/' + encodeURIComponent(sessionId) + '/out', 'text/event-stream');
    let selected = null,
      frames = 0;
    const parser = new SSEParser(frame => {
      if (++frames > 20000) throw fail('会话补读达到事件上限，已停止');
      for (const candidate of publicTokens(frame)) {
        try {
          const run = validateToken(candidate, sessionId);
          if (run.runId === session.currentRunId && (!selected || run.exp > selected.exp)) selected = {token: candidate, exp: run.exp};
        } catch {
          /* Historical/expired/session-only/foreign tokens are not run evidence. */
        }
      }
    });
    await readStream(stream, controller.signal, Math.min(maxBytes, 8 * 1024 * 1024), bytes => {
      parser.push(bytes);
      return !selected;
    });
    if (selected) progress({phase: 'run', message: '已取得当前 run 的有效授权'});
    return {session, token: selected?.token || null, reason: selected ? 'ready' : 'no-valid-run-token'};
  } catch (e) {
    if (timedOut) throw fail('会话补读超时，未取得有效运行令牌；可手动重新补读或等待页面新流');
    if (controller.signal.aborted) throw aborted();
    // Never echo arbitrary fetch/JSON error text (it can contain request credentials).
    if (e?.status || /^会话|^响应/.test(e?.message || '')) throw e;
    throw fail('会话补读失败；未自动重试，可手动重新补读或等待页面新流');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

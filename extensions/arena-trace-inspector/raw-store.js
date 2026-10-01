/* Opt-in personal archive. v2 stores the exact decoded response TEXT, before JSON
   parsing/redaction. This is not a wire/HTTP-header archive. Events and individually
   requested spans have separate sources/timestamps and explicit coverage.
   Legacy v1 records remain readable but cannot be upgraded into complete evidence. */
import {conversationUrl} from './history.js';
import {accountKeyPart} from './account.js';
export const RAW_PREFIX = 'ati.raw.v1.'; // Keep existing keys; record schema is versioned.
export const UNKNOWN_ACCOUNT = 'unknown';
export const RAW_LIMITS = {events: 16 * 1024 * 1024, span: 512 * 1024, spans: 500};
export function rawKey(accountId, sessionId, runId) {
  conversationUrl(sessionId);
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('运行 ID 无效');
  return RAW_PREFIX + accountKeyPart(accountId || UNKNOWN_ACCOUNT) + '.' + sessionId + '.' + runId;
}
const valid = r => r && [1, 2].includes(r.schemaVersion) && r.kind === 'raw';
export function rawCoverage(record) {
  if (record?.schemaVersion !== 2) return {schemaVersion: 1, events: 'legacy-unverified', capturedSpans: 0, detail: 'unknown', note: '旧版记录可能已过滤 properties，不能认定完整'};
  return {
    schemaVersion: 2,
    events: record.events?.bodyComplete ? 'captured' : record.events?.omittedReason || 'missing',
    capturedSpans: (record.spans || []).filter(s => s.bodyComplete).length,
    selectedSpans: record.coverage?.selectedSpanIds?.length || 0,
    detail: record.coverage?.detailStatus || 'not-requested',
    limited: !!record.coverage?.selectionLimited,
    note: '仅本次收到的 events 全文及实际请求的 span；非全部历史运行'
  };
}
function artifact({text, status = 200, source, capturedAt = new Date().toISOString()}, limit) {
  if (typeof text !== 'string') throw Error('原始响应必须为文本');
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  return {source, status, capturedAt, encoding: 'utf-8-decoded-text', utf8Bytes, bodyComplete: utf8Bytes <= limit, ...(utf8Bytes <= limit ? {text} : {omittedReason: 'size-limit'})};
}
export function createRawStore(area) {
  let queue = Promise.resolve();
  const enqueue = task => {
    const work = queue.then(task);
    queue = work.catch(() => {});
    return work;
  };
  const base = ({sessionId, runId, account, token}, prior) => ({
    ...(prior?.schemaVersion === 2 ? prior : {}),
    schemaVersion: 2,
    kind: 'raw',
    sessionId,
    runId,
    url: conversationUrl(sessionId),
    ...(account ? {account} : {}),
    ...(token ? {token} : {}),
    capturedAt: new Date().toISOString(),
    // Preserve rather than falsely relabel a pre-existing, possibly filtered object.
    ...(prior?.schemaVersion === 1 ? {legacy: {capturedAt: prior.capturedAt, source: prior.source, payload: prior.payload}} : {})
  });
  const mutate = (args, change) =>
    enqueue(async () => {
      const key = rawKey(args.account?.accountId, args.sessionId, args.runId);
      const prior = (await area.get(key))[key];
      const record = base(args, prior);
      change(record);
      await area.set({[key]: record});
      return {key, ...rawCoverage(record)};
    });
  return {
    // Legacy API retained for import/compatibility. Production capture uses saveEvents/saveSpan.
    save({sessionId, runId, payload, account = null, token = null, source = null}) {
      return enqueue(async () => {
        const key = rawKey(account?.accountId, sessionId, runId);
        const record = {
          schemaVersion: 1,
          kind: 'raw',
          sessionId,
          runId,
          url: conversationUrl(sessionId),
          ...(account ? {account} : {}),
          capturedAt: new Date().toISOString(),
          source: source || 'https://api.trigger.dev/api/v1/runs/<runId>/events',
          ...(token ? {token} : {}),
          payload
        };
        await area.set({[key]: record});
        return {key, bytes: JSON.stringify(record).length};
      });
    },
    saveEvents(args) {
      return mutate(args, record => {
        record.events = artifact({...args, source: 'https://api.trigger.dev/api/v1/runs/' + encodeURIComponent(args.runId) + '/events'}, RAW_LIMITS.events);
        record.coverage = {...record.coverage, eventsReceived: true};
      });
    },
    saveSpan(args) {
      if (!/^[a-f0-9]{16,32}$/.test(args.spanId || '')) return Promise.reject(Error('span ID 无效'));
      return mutate(args, record => {
        const entry = {...artifact({...args, source: 'https://api.trigger.dev/api/v1/runs/' + encodeURIComponent(args.runId) + '/spans/' + args.spanId}, RAW_LIMITS.span), spanId: args.spanId};
        const spans = [...(record.spans || [])],
          index = spans.findIndex(s => s.spanId === args.spanId);
        if (index >= 0) spans[index] = entry;
        else if (spans.length < RAW_LIMITS.spans) spans.push(entry);
        else record.coverage = {...record.coverage, selectionLimited: true, spanArchiveLimit: true};
        record.spans = spans;
      });
    },
    markDetail(args) {
      return mutate(args, record => {
        const complete = (args.spanIds || []).every(id => record.spans?.some(span => span.spanId === id && span.status === 200 && span.bodyComplete));
        record.coverage = {
          ...record.coverage,
          detailStatus: args.status === 'complete' && !complete ? 'partial' : ['reading', 'complete', 'partial', 'failed'].includes(args.status) ? args.status : 'failed',
          selectedSpanIds: (args.spanIds || []).filter(id => /^[a-f0-9]{16,32}$/.test(id)).slice(0, 24),
          selectionLimited: !!args.limited || !!record.coverage?.spanArchiveLimit,
          checkedAt: new Date().toISOString()
        };
      });
    },
    async listKeys(sessionId) {
      await queue;
      const all = await area.get(null);
      return Object.keys(all).filter(k => k.startsWith(RAW_PREFIX) && (!sessionId || all[k]?.sessionId === sessionId) && valid(all[k]));
    },
    async list() {
      await queue;
      const all = await area.get(null);
      return Object.entries(all)
        .filter(([k, r]) => k.startsWith(RAW_PREFIX) && valid(r))
        .map(([, r]) => r)
        .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    },
    remove(sessionId) {
      return enqueue(async () => {
        conversationUrl(sessionId);
        const all = await area.get(null);
        const keys = Object.keys(all).filter(k => k.startsWith(RAW_PREFIX) && all[k]?.sessionId === sessionId);
        if (keys.length) await area.remove(keys);
        return keys.length;
      });
    },
    async bytes() {
      await queue;
      const all = await area.get(null);
      return Object.entries(all)
        .filter(([k, r]) => k.startsWith(RAW_PREFIX) && valid(r))
        .reduce((n, [, r]) => n + new TextEncoder().encode(JSON.stringify(r)).byteLength, 0);
    }
  };
}

import {sanitizeCollection} from './collection.js';
import {extractReasoningEvidence, sanitizeReasoningEvidence} from './reasoning-evidence.js';
/* Agent span detail: three model-name layers, call settings, usage and cost semantics from span properties.
   Whitelist only. Never stores tokens, prompts, message text, reasoning text or raw span payloads. */
const SPAN_KINDS = {'ai.streamText.doStream': 'stream', 'token.usage.recorded': 'usage', 'spend.recorded': 'cost'};
const TURN = /^chat turn (\d{1,4})$/;
export const DETAIL_LIMITS = {turns: 6, spans: 24};
const spanId = v => (typeof v === 'string' && /^[a-f0-9]{16,32}$/.test(v) ? v : null);
const label = v => (typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) && !v.includes('Bearer ') && !/^eyJ[^ ]+\.[^ ]+\./.test(v) ? v : null);
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const amount = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const number = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = v => (typeof v === 'boolean' ? v : null);
const id = v => (typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) ? v : null);

// Trigger.dev returns properties either nested (properties.ai.model.id) or flat ('ai.model.id'); accept both.
function get(props, path) {
  if (!props || typeof props !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(props, path)) return props[path];
  let cur = props;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}
const FIELDS = {
  stream: {
    apiModelId: ['ai.model.id', label],
    provider: ['ai.model.provider', label],
    responseModel: ['ai.response.model', label],
    apiModelName: ['ai.telemetry.metadata.apiModelName', label],
    requestModel: ['gen_ai.request.model', label],
    genResponseModel: ['gen_ai.response.model', label],
    temperature: ['ai.settings.temperature', number],
    maxOutputTokens: ['ai.settings.maxOutputTokens', count],
    topP: ['ai.settings.topP', number],
    finishReason: ['ai.response.finishReason', label],
    responseId: ['ai.response.id', label],
    inputTokens: ['ai.usage.inputTokens', count],
    outputTokens: ['ai.usage.outputTokens', count],
    totalTokens: ['ai.usage.totalTokens', count],
    reasoningTokens: ['ai.usage.reasoningTokens', count]
  },
  usage: {
    modelName: ['modelName', label],
    provider: ['provider', label],
    usageSource: ['usageSource', label],
    messageId: ['messageId', id],
    inputTokens: ['inputTokens', count],
    outputTokens: ['outputTokens', count],
    totalTokens: ['totalTokens', count],
    reasoningTokens: ['reasoningTokens', count],
    cacheReadTokens: ['cacheReadTokens', count],
    cacheWriteTokens: ['cacheWriteTokens', count]
  },
  cost: {
    modelName: ['modelName', label],
    messageId: ['messageId', id],
    costUsd: ['costUsd', amount],
    effectiveCostUsd: ['effectiveCostUsd', amount],
    chargedUsd: ['chargedUsd', amount],
    effectiveChargedUsd: ['effectiveChargedUsd', amount],
    pricingStrategy: ['pricingStrategy', label],
    costSource: ['costSource', label],
    costKind: ['costKind', label],
    costIsFallback: ['costIsFallback', flag],
    costIsLongContext: ['costIsLongContext', flag],
    unpriced: ['unpriced', flag],
    // Account-level allowance snapshot Arena writes into every spend.recorded span (observed 2026-09-16). Numbers/flags/short labels only.
    allowanceTier: ['allowanceTier', label],
    allowanceUsd: ['allowanceUsd', amount],
    chargedUserTotalUsd: ['chargedUserTotalUsd', amount],
    balanceRemainingUsd: ['balanceRemainingUsd', number],
    overLimit: ['overLimit', flag],
    surface: ['surface', label]
  }
};
// Keys whose presence (not value) is worth knowing when hunting for reasoning-effort style settings.
// providerMetadata: structure only. Keys, numbers, booleans and short enum-like strings (<=40 chars, no spaces/newlines). Never long text.
const META_LIMITS = {depth: 4, entries: 60, string: 40};
const TEXT_KEY = /text|content|message|prompt|reasoning_content|thinking_text|signature|redacted|encrypted|data|blob|payload|citation/i;
// Structural keys that merely contain a text-like substring (e.g. "context" contains "text"); expanded per normal rules, never as text.
const STRUCT_KEY = /^(contextManagement|context_management|contextWindow|usage|cacheControl|cache_control|thinking|reasoning|effort|serviceTier|service_tier)$/;
export function metaShape(value, depth = 0, out = {}, prefix = '', budget = {n: META_LIMITS.entries}) {
  if (!value || typeof value !== 'object' || depth > META_LIMITS.depth) return out;
  for (const [k, v] of Object.entries(value)) {
    if (budget.n <= 0) break;
    const key = (prefix ? prefix + '.' : '') + String(k).slice(0, 60);
    if (TEXT_KEY.test(k) && !STRUCT_KEY.test(k)) {
      out[key] = '<' + (Array.isArray(v) ? 'array' : typeof v) + '>';
      budget.n--;
      continue;
    }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        out[key] = '<array:' + v.length + '>';
        budget.n--;
        if (v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) metaShape(v[0], depth + 1, out, key + '[0]', budget);
      } else if (!Object.keys(v).length) {
        out[key] = '<empty>';
        budget.n--;
      } else metaShape(v, depth + 1, out, key, budget);
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean' || v === null) out[key] = v;
    else if (typeof v === 'string') out[key] = v.length <= META_LIMITS.string && !/\s/.test(v) && !/^eyJ/.test(v) ? v : '<string:' + v.length + '>';
    else continue;
    budget.n--;
  }
  return out;
}
const SETTING_HINTS = [
  'ai.settings.providerOptions',
  'ai.prompt.providerOptions',
  'ai.response.providerMetadata',
  'ai.settings.reasoningEffort',
  'ai.settings.thinking',
  'gen_ai.request.reasoning_effort'
];

// Selection is priority based so the 24-span budget can never drop the spans that carry the Arena internal modelName:
// pass 1 reserves, newest turn first, each turn's final stream + usage + cost ("essentials"); pass 2 spends what is left on the
// remaining (earlier, multi-step) stream spans, again newest first. 6 turns x 3 essentials = 18 always fits inside 24.
// Output keeps trace order. `limited` is true when any turn or span of this run was left out.
export function selectDetailSpans(trace, runId, limits = DETAIL_LIMITS) {
  if (!Array.isArray(trace?.events)) throw new Error('trace 格式不符合预期');
  const turns = [];
  let current = null;
  let order = 0;
  for (const e of trace.events) {
    if (e?.runId !== runId || typeof e.message !== 'string') continue;
    const turnMatch = e.message.match(TURN);
    if (turnMatch) {
      current = {turn: Number(turnMatch[1]), spans: []};
      turns.push(current);
      continue;
    }
    const kind = SPAN_KINDS[e.message];
    if (!kind) continue;
    if (!spanId(e.spanId)) throw new Error('span ID 无效');
    if (!current) {
      current = {turn: null, spans: []};
      turns.push(current);
    }
    current.spans.push({spanId: e.spanId, kind, message: e.message, partial: e.isPartial !== false, turn: current.turn, order: order++});
  }
  const withSpans = turns.filter(t => t.spans.length);
  const kept = withSpans.slice(-limits.turns);
  const essential = new Set();
  for (const t of kept) {
    const streams = t.spans.filter(s => s.kind === 'stream');
    const finalStream = streams.filter(s => !s.partial).pop() || streams.pop();
    for (const s of [finalStream, t.spans.filter(s => s.kind === 'usage').pop(), t.spans.filter(s => s.kind === 'cost').pop()]) if (s) essential.add(s);
  }
  const chosen = new Set();
  let budget = limits.spans;
  for (const pass of [s => essential.has(s), s => !essential.has(s)]) {
    for (let i = kept.length - 1; i >= 0 && budget > 0; i--) {
      const candidates = kept[i].spans.filter(pass);
      for (let j = candidates.length - 1; j >= 0 && budget > 0; j--) {
        chosen.add(candidates[j]);
        budget--;
      }
    }
  }
  const selected = kept
    .flatMap(t => t.spans)
    .filter(s => chosen.has(s))
    .map(({order, ...s}) => s);
  return {
    selected,
    selectionStats: {
      events: trace.events.length,
      matchingEvents: trace.events.filter(e => e?.runId === runId).length,
      foreignEvents: trace.events.filter(e => e?.runId !== runId).length,
      streamCalls: withSpans.reduce((n, t) => n + t.spans.filter(s => s.kind === 'stream').length, 0),
      turns: withSpans.length,
      eligible: withSpans.reduce((n, t) => n + t.spans.length, 0),
      selected: selected.length,
      excludedTurnLimit: withSpans.slice(0, Math.max(0, withSpans.length - kept.length)).reduce((n, t) => n + t.spans.length, 0),
      excludedSpanLimit: kept.reduce((n, t) => n + t.spans.length, 0) - selected.length,
      limits: {turns: limits.turns, spans: limits.spans}
    },
    turnCount: withSpans.length,
    limited: withSpans.length > kept.length || kept.reduce((n, t) => n + t.spans.length, 0) > selected.length
  };
}

// Diagnostic-only projection. Invalid selection never changes the existing caller's gates.
export function planDetailCollection(trace, runId, checkedAt = new Date().toISOString(), attempt = 0) {
  try {
    const selection = selectDetailSpans(trace, runId);
    return sanitizeCollection({
      schemaVersion: 1,
      source: 'detail-pipeline',
      observedAt: checkedAt,
      attempt,
      phase: 'planned',
      gate: 'waiting-existing-gates',
      selection: selection.selectionStats,
      spans: selection.selected.map(s => ({...s, state: 'selected'})),
      persistence: 'memory-only'
    });
  } catch {
    return sanitizeCollection({
      schemaVersion: 1,
      source: 'detail-pipeline',
      observedAt: checkedAt,
      attempt,
      phase: 'failed',
      selection: null,
      spans: [],
      failure: 'selection-invalid',
      persistence: 'memory-only'
    });
  }
}

// Stable identity of the selected detail snapshot. New spans or completion changes
// invalidate old naming readiness even if runId stays the same across turns.
export function detailSnapshotKey(trace, runId) {
  try {
    const {selected, turnCount} = selectDetailSpans(trace, runId);
    return selected.length ? JSON.stringify([turnCount, selected.map(s => [s.spanId, s.kind, s.turn, s.partial])]) : null;
  } catch {
    return null;
  }
}

// True when the newest turn in the trace has a finished stream span plus usage and cost spans, and the turn count exceeds `knownTurns`.
// Used to defer the once-per-run detail read until the current turn's cost/usage spans (which carry the internal modelName) exist.
export function detailComplete(trace, runId, knownTurns = 0) {
  let selection;
  try {
    selection = selectDetailSpans(trace, runId, {turns: 1, spans: 64});
  } catch {
    return false;
  }
  if (!selection.selected.length || selection.turnCount <= knownTurns) return false;
  const last = selection.selected;
  return last.some(s => s.kind === 'stream' && !s.partial) && last.some(s => s.kind === 'usage') && last.some(s => s.kind === 'cost');
}

export function parseDetailSpan(detail, event, runId) {
  if (detail?.runId !== runId || detail.spanId !== event.spanId || detail.message !== event.message) throw new Error('span 与运行不匹配');
  const props = detail.properties && typeof detail.properties === 'object' ? detail.properties : {};
  const values = {};
  for (const [name, [path, clean]] of Object.entries(FIELDS[event.kind])) {
    const v = clean(get(props, path));
    if (v !== null && v !== undefined) values[name] = v;
  }
  const hints = event.kind === 'stream' ? SETTING_HINTS.filter(p => get(props, p) !== undefined) : [];
  const out = {
    spanId: event.spanId,
    kind: event.kind,
    turn: Number.isSafeInteger(event.turn) && event.turn > 0 ? event.turn : null,
    partial: event.partial || detail.isPartial !== false,
    values,
    settingKeys: hints
  };
  if (event.kind === 'stream') {
    out.reasoning = extractReasoningEvidence(props);
    let meta = get(props, 'ai.response.providerMetadata');
    if (typeof meta === 'string' && meta.length < 65536) {
      try {
        meta = JSON.parse(meta);
      } catch {
        meta = null;
      }
    }
    if (meta && typeof meta === 'object') out.providerMeta = metaShape(meta);
    const opts = get(props, 'ai.settings.providerOptions') ?? get(props, 'ai.prompt.providerOptions');
    let o = opts;
    if (typeof o === 'string' && o.length < 65536) {
      try {
        o = JSON.parse(o);
      } catch {
        o = null;
      }
    }
    if (o && typeof o === 'object') out.providerOptions = metaShape(o);
  }
  return out;
}

export function sanitizeDetail(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.spans)) return null;
  const seen = new Set(),
    spans = [];
  for (const s of input.spans) {
    if (spans.length >= DETAIL_LIMITS.spans) break;
    if (!spanId(s?.spanId) || seen.has(s.spanId) || !['stream', 'usage', 'cost'].includes(s.kind)) continue;
    seen.add(s.spanId);
    const values = {};
    for (const [name, [, clean]] of Object.entries(FIELDS[s.kind])) {
      const v = clean(s.values?.[name]);
      if (v !== null && v !== undefined) values[name] = v;
    }
    const entry = {
      spanId: s.spanId,
      kind: s.kind,
      turn: count(s.turn) && s.turn > 0 ? s.turn : null,
      partial: s.partial !== false,
      values,
      settingKeys: Array.isArray(s.settingKeys) ? s.settingKeys.filter(k => SETTING_HINTS.includes(k)) : []
    };
    for (const name of ['providerMeta', 'providerOptions']) {
      const m = s[name];
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        const clean = {};
        let n = 0;
        for (const [k, v] of Object.entries(m)) {
          if (n++ >= META_LIMITS.entries) break;
          if (typeof k !== 'string' || k.length > 250) continue;
          if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) clean[k] = v;
          else if ((typeof v === 'string' && v.length <= META_LIMITS.string && !/\s/.test(v) && !/^eyJ/.test(v)) || (typeof v === 'string' && /^<[a-z]+(:\d+)?>$/.test(v))) clean[k] = v;
        }
        if (Object.keys(clean).length) entry[name] = clean;
      }
    }
    if (s.kind === 'stream' && s.reasoning?.schemaVersion === 1) entry.reasoning = sanitizeReasoningEvidence(s.reasoning);
    spans.push(entry);
  }
  const time = typeof input.checkedAt === 'string' && input.checkedAt.length <= 40 && Number.isFinite(Date.parse(input.checkedAt)) ? input.checkedAt : null;
  return {schemaVersion: 1, checkedAt: time, spans, limited: input.limited === true, stopped: label(input.stopped) || null, turnCount: count(input.turnCount)};
}
// Account-level allowance snapshot from the newest sanitized spend.recorded span.
// Values are copied from the server response; no USD/credits/pulse conversion is performed.
export function quotaFromDetail(detail) {
  if (!detail || typeof detail !== 'object' || !Array.isArray(detail.spans)) return null;
  const keys = ['allowanceTier', 'allowanceUsd', 'chargedUserTotalUsd', 'balanceRemainingUsd', 'overLimit', 'surface'];
  const source = [...detail.spans].reverse().find(s => s?.kind === 'cost' && s.values && keys.some(k => s.values[k] !== undefined));
  if (!source) return null;
  const out = {};
  for (const key of keys) if (source.values[key] !== undefined) out[key] = source.values[key];
  if (typeof detail.checkedAt === 'string' && Number.isFinite(Date.parse(detail.checkedAt))) out.checkedAt = detail.checkedAt;
  return Object.keys(out).length ? out : null;
}

// Reads span details for one run. Stops (does not retry) on 429 or any non-200 and reports what was read so far.
export async function readAgentDetail({
  fetch: doFetch,
  runId,
  token,
  trace,
  signal,
  checkedAt = new Date().toISOString(),
  delayMs = 250,
  wait = ms => new Promise(r => setTimeout(r, ms)),
  onRawSpan = null,
  onProgress = null,
  attempt = 1,
  abortKind = () => 'aborted'
}) {
  let report = planDetailCollection(trace, runId, checkedAt, attempt);
  const emit = () => {
    try {
      const result = onProgress?.(sanitizeCollection(report));
      if (result?.catch) result.catch(() => {});
    } catch {}
  };
  let selection;
  try {
    selection = selectDetailSpans(trace, runId);
  } catch (e) {
    emit();
    throw e;
  }
  report.phase = 'reading';
  report.gate = 'read-started';
  emit();
  const spans = [];
  let stopped = null;
  const fail = (row, kind) => {
    report.phase = 'failed';
    report.failure = kind;
    if (row) row.state = kind;
  };
  const errorKind = (error, fallback) => {
    if (signal?.aborted || error?.name === 'AbortError') {
      let kind = 'aborted';
      try {
        if (abortKind() === 'timeout') kind = 'timeout';
      } catch {}
      return kind;
    }
    return fallback;
  };
  try {
    for (const [i, event] of selection.selected.entries()) {
      const row = report.spans[i];
      if (i) {
        try {
          await wait(delayMs);
        } catch (e) {
          fail(null, errorKind(e, 'wait-failed'));
          throw e;
        }
      }
      row.state = 'requesting';
      let response;
      try {
        response = await doFetch('https://api.trigger.dev/api/v1/runs/' + encodeURIComponent(runId) + '/spans/' + encodeURIComponent(event.spanId), {
          method: 'GET',
          headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal
        });
      } catch (e) {
        fail(row, errorKind(e, 'network-error'));
        throw e;
      }
      row.httpStatus = response.status;
      let text;
      try {
        text = await response.text();
      } catch (e) {
        fail(row, errorKind(e, 'body-read-failed'));
        throw e;
      }
      // Existing opt-in raw archive is independent; diagnostics never receive its text or credentials.
      if (onRawSpan) {
        try {
          await onRawSpan({spanId: event.spanId, status: response.status, text});
        } catch {}
      }
      if (response.status === 429) {
        stopped = '接口限流（HTTP 429），已停止读取 span 详情';
        fail(row, 'http-error');
        report.phase = 'stopped';
        break;
      }
      if (!response.ok) {
        stopped = 'span 详情返回 HTTP ' + response.status + '，已停止';
        fail(row, 'http-error');
        report.phase = 'stopped';
        break;
      }
      if (text.length > 512 * 1024) {
        stopped = 'span 详情超过 512 KB，已停止';
        fail(row, 'response-too-large');
        report.phase = 'stopped';
        break;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        fail(row, 'invalid-json');
        throw e;
      }
      try {
        spans.push(parseDetailSpan(body, event, runId));
      } catch (e) {
        fail(row, 'identity-mismatch');
        throw e;
      }
      row.state = 'validated';
    }
    if (!stopped) report.phase = 'validated';
    return sanitizeDetail({checkedAt, spans, limited: selection.limited, stopped, turnCount: selection.turnCount});
  } finally {
    emit();
  }
}

import {conversationUrl, cleanRecordProviders} from './history.js';
import {mergeUsage, summarizeUsage, formatUsage} from './usage.js';
import {detectSwitch, mergeSwitch, sanitizeSwitch} from './model-switch.js';

export function sessionFromUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://arena.ai' ? url.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null : null;
  } catch {
    return null;
  }
}
export function emptyView(sessionId = null, enabled = false) {
  return {
    sessionId,
    historical: false,
    models: [],
    runId: null,
    run: null,
    usage: null,
    checkedAt: null,
    saved: false,
    usageText: '',
    totalUsageText: '',
    detailPending: false,
    switch: null,
    status: enabled ? '等待新的 Agent 消息' : '未开启监听'
  };
}
export function historicalView(record, sessionId, enabled = false) {
  // schemaVersion 1 = pre-2.3.0 records (no account, no transcript); 2 = account-scoped.
  const known = record?.schemaVersion === 1 || record?.schemaVersion === 2;
  if (!record || !known || record.sessionId !== sessionId || record.url !== conversationUrl(sessionId) || !Array.isArray(record.observations)) return null;
  record = cleanRecordProviders(record);
  const observations = record.observations.filter(o => typeof o.runId === 'string' && typeof o.model === 'string' && o.model.trim());
  const ids = [...new Set([...(record.runs || []).map(r => r.runId), ...observations.map(o => o.runId)])];
  const observedAt = id => [(record.runs || []).find(r => r.runId === id)?.checkedAt || '', ...observations.filter(o => o.runId === id).map(o => o.lastSeen || '')].sort().at(-1) || '';
  ids.sort((a, b) => observedAt(b).localeCompare(observedAt(a)));
  const switchFor = id => {
    const stored = (record.runs || []).find(r => r.runId === id);
    const detected = detectSwitch(stored?.spans);
    return mergeSwitch(stored?.switch, detected?.state === 'switched' ? detected : null);
  };
  const switchedIds = ids.filter(id => switchFor(id)?.state === 'switched');
  const convSwitch = sanitizeSwitch(record.switch)?.state === 'switched' ? sanitizeSwitch(record.switch) : null;
  let runId = switchedIds[0] || ids[0];
  if (!switchedIds.length && convSwitch) {
    const namesOf = id => [...observations.filter(o => o.runId === id).map(o => o.model), ...((record.runs || []).find(r => r.runId === id)?.spans || []).map(s => s.model)];
    runId = ids.find(id => namesOf(id).includes(convSwitch.to)) || ids.find(id => namesOf(id).includes(convSwitch.from)) || ids[0];
  }
  if (!runId) return null;
  const selected = observations.filter(o => o.runId === runId);
  const storedRun = (record.runs || []).find(r => r.runId === runId) || {runId, spans: []};
  const run = mergeUsage([], storedRun)[0] || {runId, spans: []};
  run.checkedAt = observedAt(runId);
  run.spans = run.spans.map(span => ({...span, provider: span.provider || selected.find(o => o.spanId === span.spanId && o.model === span.model)?.provider || ''}));
  const models = selected.map(o => ({model: o.model.slice(0, 200), provider: String(o.provider || '').slice(0, 100), spanId: String(o.spanId || '').slice(0, 128), partial: o.partial}));
  const usage = summarizeUsage([run]);
  const detected = detectSwitch(run.spans);
  const runSwitch = mergeSwitch(storedRun.switch, detected.state === 'switched' ? detected : null);
  if (runSwitch?.state === 'switched') run.switch = runSwitch;
  const conv = convSwitch || (runSwitch?.state === 'switched' ? runSwitch : null);
  return {
    sessionId,
    historical: true,
    runId,
    run,
    models,
    usage,
    checkedAt: run.checkedAt,
    saved: true,
    usageText: formatUsage(usage),
    totalUsageText: formatUsage(summarizeUsage(record.runs || [])),
    switch: conv?.state === 'switched' ? conv : null,
    status: enabled ? '已恢复此会话的本地历史记录；监听中，等待新运行。' : '已恢复此会话的本地历史记录；未开启监听。'
  };
}

import {cleanProvider, traceProvider} from './core.js';
import {createEvidence, mergeEvidence} from './evidence.js';
// Only parse observed trace labels; do not infer provider prices or input/output splits.
export function parseTokenLabel(label) {
  if (typeof label !== 'string') return null;
  const m = label.trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) return null;
  const value = Number(m[1]) * ({k: 1e3, m: 1e6, b: 1e9}[m[2]?.toLowerCase()] || 1);
  return Number.isSafeInteger(Math.round(value)) ? {value: Math.round(value), approximate: !!m[2]} : null;
}
export function parseCostLabel(label) {
  if (typeof label !== 'string') return null;
  const m = label.trim().replace(/,/g, '').match(/^\$\s*(\d+(?:\.\d+)?)$/);
  return m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null;
}
export function extractUsage(trace, runId, checkedAt = new Date().toISOString()) {
  const spans = new Map();
  for (const event of trace.events || []) {
    if (event.runId !== runId || event.message !== 'ai.streamText.doStream' || typeof event.spanId !== 'string') continue;
    const items = event.style?.accessory?.items || [];
    const tokenLabel = items.find(i => i.icon === 'tabler-hash')?.text;
    const costLabel = items.find(i => i.icon === 'tabler-currency-dollar')?.text;
    const tokens = parseTokenLabel(tokenLabel);
    const model = String(items.find(i => i.icon === 'tabler-cube')?.text || '').slice(0, 200);
    const providerIcon = !!traceProvider(event.style?.icon) ? event.style.icon : null;
    const costUsd = parseCostLabel(costLabel);
    const flag = key => typeof event[key] === 'boolean' ? event[key] : null;
    const evidence = createEvidence({model, provider: providerIcon, tokens: tokens ? tokenLabel : null, cost: costUsd !== null ? costLabel : null}, event, checkedAt);
    spans.set(event.spanId, {spanId: event.spanId, model, provider: providerIcon?.replace(/^ai-provider-/, '') || '', tokens: tokens?.value ?? null, tokensApproximate: tokens?.approximate ?? false, costUsd, partial: flag('isPartial'), error: flag('isError'), cancelled: flag('isCancelled'), evidence});
  }
  return {runId, checkedAt, spans: [...spans.values()]};
}
export function mergeUsage(oldRuns = [], incoming) {
  if (!incoming?.runId || !Array.isArray(incoming.spans)) return oldRuns;
  const runs = oldRuns.map(r => ({runId: r.runId, ...(r.checkedAt ? {checkedAt: r.checkedAt} : {}), ...(r.detail ? {detail: r.detail} : {}), spans: [...r.spans]}));
  let run = runs.find(r => r.runId === incoming.runId);
  if (!run) { run = {runId: incoming.runId, spans: []}; runs.push(run); }
  if (typeof incoming.checkedAt === 'string' && incoming.checkedAt.length <= 40 && Number.isFinite(Date.parse(incoming.checkedAt))) run.checkedAt = incoming.checkedAt;
  if (incoming.detail && typeof incoming.detail === 'object') run.detail = incoming.detail;
  for (const span of incoming.spans) {
    if (typeof span.spanId !== 'string') continue;
    const index = run.spans.findIndex(s => s.spanId === span.spanId);
    const old = run.spans[index];
    const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const flag = key => typeof span[key] === 'boolean' ? span[key] : old?.[key] ?? null;
    const entry = {spanId: span.spanId, model: String(span.model || old?.model || '').slice(0,200), provider: cleanProvider(span.provider)||cleanProvider(old?.provider), tokens: valid(span.tokens) ? span.tokens : old?.tokens ?? null, tokensApproximate: valid(span.tokens) ? !!span.tokensApproximate : old?.tokensApproximate ?? false, costUsd: valid(span.costUsd) ? span.costUsd : old?.costUsd ?? null, partial: old?.partial === false ? false : flag('partial'), error: old?.error === true ? true : flag('error'), cancelled: old?.cancelled === true ? true : flag('cancelled'), evidence: mergeEvidence(old?.evidence, span.evidence)};
    if (index < 0) run.spans.push(entry); else run.spans[index] = entry;
  }
  return runs;
}
export function summarizeUsage(runs = []) {
  const unique = new Map();
  for (const r of runs) for (const s of r.spans || []) unique.set(r.runId + ':' + s.spanId, s);
  const spans = [...unique.values()];
  const tokenSpans = spans.filter(s => typeof s.tokens === 'number');
  const costSpans = spans.filter(s => typeof s.costUsd === 'number');
  return {spanCount: spans.length, tokens: tokenSpans.length ? tokenSpans.reduce((n,s) => n+s.tokens,0) : null, costUsd: costSpans.length ? Math.round(costSpans.reduce((n,s) => n+s.costUsd,0)*1e9)/1e9 : null, tokensApproximate: tokenSpans.some(s => s.tokensApproximate), tokenCoverage: tokenSpans.length, costCoverage: costSpans.length, partial: spans.some(s => s.partial)};
}
export function formatUsage(t) {
  if (!t || !t.spanCount) return 'Token / 费用：未提供';
  const tokens = t.tokens === null ? '未提供' : (t.tokensApproximate ? '≈' : '') + t.tokens.toLocaleString('zh-CN');
  const cost = t.costUsd === null ? '未提供' : '≈$' + t.costUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const missing = t.tokenCoverage < t.spanCount || t.costCoverage < t.spanCount;
  return `Token ${tokens} · trace 费用 ${cost}` + (missing ? '（部分缺失）' : '') + (t.partial ? '（进行中）' : '');
}

/* Shared popup / isolated content-script view model. No DOM or browser API access. */
(() => {
  const provider = x => typeof x==='string' && /^[\w.-]{1,100}$/.test(x) && !/^(?:hero|tabler|lucide|icon)-/i.test(x) ? x : '';
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const tokens = (n, approximate) => number(n) ? (approximate ? '≈' : '') + n.toLocaleString('zh-CN') : '未提供';
  const money = n => number(n) ? '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '未提供';
  function completion(calls) {
    if (!calls.length) return '等待数据';
    if (calls.some(c => c.error === true)) return '调用报错';
    if (calls.some(c => c.cancelled === true)) return '调用已取消';
    if (calls.some(c => c.partial === true)) return '调用进行中';
    return calls.every(c => c.partial === false) ? '调用已完成' : '状态未提供';
  }
  function runsFor(record) {
    const runs = [...(record?.runs || [])];
    for (const o of record?.observations || []) if (!runs.some(r => r.runId === o.runId)) runs.push({runId: o.runId, spans: [], checkedAt: o.lastSeen});
    return runs.sort((a,b) => stamp(b).localeCompare(stamp(a)));
    function stamp(r) { return r.checkedAt || (record.observations || []).filter(o => o.runId === r.runId).map(o => o.lastSeen || '').sort().at(-1) || ''; }
  }
  // 1.7.0: when the run's span detail carries a public Arena internal modelName whose base matches the server label
  // (e.g. claude-fable-5.1-high ↔ claude-fable-5-1, gpt-6-astra-low ↔ gpt-6-astra), show the internal name instead of the
  // nickname. Anonymous codenames never replace anything; a mismatch or conflict keeps the server label untouched.
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ANON_RE = /^[a-z]{3,12}-(?:[a-z]{3,12}-)?[a-z0-9]{4,6}$/, KNOWN_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|glm|grok|llama|mistral|kimi|minimax|o\d|fable|nova|command|phi)/i;
  function parseLabel(label) {
    if (globalThis.ArenaModelLabel) return globalThis.ArenaModelLabel.parseModelLabel(label);
    if (typeof label !== 'string' || !label) return null;
    let base = label.replace(/-(\d{8}|\d{4})$/, ''); const t = base.match(/-(minimal|low|medium|high|xhigh|max)$/); if (t) base = base.slice(0, -t[0].length);
    return {label, base, tier: t ? t[1] : null, anonymous: !t && !KNOWN_FAMILY.test(label) && ANON_RE.test(label)};
  }
  function internalNames(detail) {
    if (!detail || !Array.isArray(detail.spans)) return [];
    return [...new Set(detail.spans.filter(s => s && ['usage', 'cost'].includes(s.kind) && typeof s.values?.modelName === 'string').map(s => s.values.modelName))];
  }
  function displayModels(models, detail) {
    const internal = internalNames(detail).map(parseLabel).filter(p => p && !p.anonymous);
    return models.map(m => {
      const hits = [...new Set(internal.filter(p => norm(p.base) === norm(m.model)).map(p => p.label))];
      return hits.length === 1 ? {...m, model: hits[0], serverLabel: m.model, internal: true} : m;
    });
  }
  function build(state = {}, record = null, selectedRunId = '') {
    const historyRuns = runsFor(record);
    const historical = !!selectedRunId || !!state.historical || !state.runId;
    const run = selectedRunId ? historyRuns.find(r => r.runId === selectedRunId) : state.runId ? (state.run?.runId === state.runId ? state.run : {runId: state.runId, spans: []}) : historyRuns[0];
    const observations = (record?.observations || []).filter(o => o.runId === run?.runId);
    const calls = [...new Map((run?.spans || []).map(s => [s.spanId, s])).values()].map(s => ({...s, evidence:cleanEvidence(s.evidence), provider: provider(s.provider) || provider(observations.find(o => o.spanId === s.spanId)?.provider)}));
    const models = calls.length ? calls.filter(c => c.model).map(c => ({model: c.model, provider: c.provider})) : historical ? (observations.length ? observations : state.models || []) : state.models || [];
    const uniqueModels = models.map(m=>({...m,provider:provider(m.provider)})).filter((m,i,a) => a.findIndex(n => n.model === m.model && n.provider === m.provider) === i);
    const tokenCalls = calls.filter(c => number(c.tokens)), costCalls = calls.filter(c => number(c.costUsd));
    const tokenSum = tokenCalls.length ? tokenCalls.reduce((n,c) => n+c.tokens,0) : null;
    const costSum = costCalls.length ? Math.round(costCalls.reduce((n,c)=>n+c.costUsd,0)*1e9)/1e9 : null;
    const detail = run?.detail && typeof run.detail === 'object' && Array.isArray(run.detail.spans) ? run.detail : null;
    const shownModels = displayModels(uniqueModels, detail);
    const detailPending = !historical && !!run?.runId && !detail && state.detailPending === true;
    return {detail, detailPending, runId: run?.runId || '', checkedAt: run?.checkedAt || (historical ? observations.map(o=>o.lastSeen||'').sort().at(-1) : state.checkedAt) || '', historical, models: shownModels, serverModels: uniqueModels, calls,
      completion: completion(calls), tokens: tokens(tokenSum,tokenCalls.some(c=>c.tokensApproximate)), cost: money(costSum),
      tokenCoverage: `${tokenCalls.length}/${calls.length}`, costCoverage: `${costCalls.length}/${calls.length}`,
      tokenMissing: tokenCalls.length < calls.length, costMissing: costCalls.length < calls.length,
      count: calls.length ? String(calls.length) : run?.runId ? '未提供' : '—',
      evidenceCount: calls.filter(c => c.evidence?.schemaVersion === 1).length,
      source: run?.runId ? (historical ? '本地历史 · 非重新验证' : '本次捕获') : '等待捕获'};
  }
  function exportEvidence(view) {
    return {schemaVersion:1,exportedAt:new Date().toISOString(),runId:view.runId,checkedAt:view.checkedAt,historical:view.historical,
      scope:'仅已捕获的 ai.streamText.doStream 调用；非原始 trace 全文',
      detail:view.detail?{checkedAt:view.detail.checkedAt||null,limited:!!view.detail.limited,stopped:view.detail.stopped||null,spans:view.detail.spans.map(s=>({spanId:s.spanId,kind:s.kind,turn:s.turn??null,partial:!!s.partial,values:{...s.values},...(typeof s.values.modelName==='string'&&globalThis.ArenaModelLabel?{modelLabel:globalThis.ArenaModelLabel.parseModelLabel(s.values.modelName)}:{}),settingKeys:[...(s.settingKeys||[])],...(s.providerMeta?{providerMeta:{...s.providerMeta}}:{}),...(s.providerOptions?{providerOptions:{...s.providerOptions}}:{})}))}:null,
      calls:view.calls.map(c=>({spanId:c.spanId,model:c.model,provider:c.provider,tokens:c.tokens??null,tokensApproximate:!!c.tokensApproximate,costUsd:c.costUsd??null,partial:c.partial??null,error:c.error??null,cancelled:c.cancelled??null,
        evidence:cleanEvidence(c.evidence),provenance:c.evidence?.schemaVersion===1?'observed-trace-labels':'legacy-local-record-no-raw-labels'}))};
  }
  function cleanEvidence(e) {
    if (e?.schemaVersion !== 1) return null;
    const out={schemaVersion:1,source:'Trigger.dev run events',spanName:'ai.streamText.doStream'};
    for(const k of ['model','provider','tokens','cost']) if(e[k]&&(k!=='provider'||/^ai-provider-[\w.-]{1,80}$/.test(e[k].value))) out[k]={path:String(e[k].path||'').slice(0,200),value:String(e[k].value||'').slice(0,200),observedAt:e[k].observedAt||null};
    if(e.flags) out.flags={isPartial:e.flags.isPartial??null,isError:e.flags.isError??null,isCancelled:e.flags.isCancelled??null,observedAt:e.flags.observedAt||null};
    return out;
  }
  globalThis.ArenaTraceView = {build,runsFor,tokens,money,completion,exportEvidence,displayModels,internalNames};
})();

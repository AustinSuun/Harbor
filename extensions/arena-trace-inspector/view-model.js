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
  // 1.7.0: an internal modelName whose base matches the server label replaces the nickname
  // (claude-fable-5.1-high ↔ claude-fable-5-1, gpt-6-astra-low ↔ gpt-6-astra). Anonymous codenames
  // never replace anything. 2.1.0 adds two disclosed fallbacks for when that exact match fails --
  // see displayModels.
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ANON_RE = /^[a-z]{3,12}-(?:[a-z]{3,12}-)?[a-z0-9]{4,6}$/, KNOWN_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|glm|grok|llama|mistral|kimi|minimax|o\d|fable|nova|command|phi)/i;
  const TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function parseLabel(label) {
    if (globalThis.ArenaModelLabel) return globalThis.ArenaModelLabel.parseModelLabel(label);
    if (typeof label !== 'string' || !label) return null;
    // Same rule as model-label.js: the tier is the last tier word standing as its own segment.
    const segments = label.split('-');
    let at = -1;
    for (let i = 1; i < segments.length; i++) if (TIERS.includes(segments[i])) at = i;
    const dated = label.match(/-(\d{8}|\d{4})$/);
    const base = at > 0 ? segments.slice(0, at).join('-') : dated ? label.slice(0, -dated[0].length) : label;
    const date = at > 0 ? (segments.slice(at + 1).find(s => /^(\d{8}|\d{4})$/.test(s)) || null) : dated ? dated[1] : null;
    return {label, base, tier: at > 0 ? segments[at] : null, date, trailing: at > 0 ? segments.slice(at + 1) : [], anonymous: at < 1 && !date && !KNOWN_FAMILY.test(label) && ANON_RE.test(label)};
  }
  function internalNames(detail) {
    if (!detail || !Array.isArray(detail.spans)) return [];
    return [...new Set(detail.spans.filter(s => s && ['usage', 'cost'].includes(s.kind) && typeof s.values?.modelName === 'string').map(s => s.values.modelName))];
  }
  // Trigger.dev prices each call against its own catalogue and records which model it matched.
  // Independent of Arena, so it is a last resort, never a replacement for Arena's own naming.
  function matchedNames(detail) {
    if (!detail || !Array.isArray(detail.spans)) return [];
    return [...new Set(detail.spans.filter(s => s && typeof s.values?.matchedModel === 'string').map(s => s.values.matchedModel).map(parseLabel).filter(p => p && !p.anonymous).map(p => p.label))];
  }
  // 1.7.0 rule kept first: an internal name whose base matches this label is a confirmed pairing.
  // 2.1.0 adds two disclosed fallbacks, because the server label is often only a short alias
  // (deepseek-flash) while Arena's own config name (deepseek-v4.1-flash-max-20260910) is the
  // accurate one. Every substitution keeps serverLabel, so the panel can show both.
  function displayModels(models, detail) {
    const internal = internalNames(detail).map(parseLabel).filter(p => p && !p.anonymous);
    const matched = matchedNames(detail);
    let substituted = false;
    const out = models.map(m => {
      const hits = [...new Set(internal.filter(p => norm(p.base) === norm(m.model)).map(p => p.label))];
      if (hits.length === 1) { substituted = true; return {...m, model: hits[0], serverLabel: m.model, internal: true, nameSource: 'internal-match'}; }
      return m;
    });
    // One label and one internal name: they can only refer to each other -- but only when that
    // internal name actually reads as a model. Arena sometimes records an opaque gateway id here
    // (arenaGateway runs leave "dxzui"), which says less than Trigger.dev's catalogue match does.
    const informative = internal.filter(p => p.label.includes('-') || KNOWN_FAMILY.test(p.label));
    if (!substituted && models.length === 1 && informative.length === 1) {
      substituted = true;
      return [{...out[0], model: informative[0].label, serverLabel: out[0].model, internal: true, nameSource: 'internal-only'}];
    }
    if (!substituted && models.length === 1 && matched.length === 1) {
      return [{...out[0], model: matched[0], serverLabel: out[0].model, matched: true, nameSource: 'trigger-matched'}];
    }
    return out;
  }
  // Every layer Arena and Trigger.dev expose for the model, aggregated across turns and
  // de-duplicated. Values that disagree between turns are shown side by side, never merged.
  const LAYER_FIELDS = [
    ['Arena 内部 modelName', 'modelName'],
    ['供应商请求 model', 'requestModel'],
    ['供应商响应 model', 'responseModel'],
    ['Trigger.dev 计价匹配', 'matchedModel']
  ];
  function modelLayers(detail) {
    if (!detail || !Array.isArray(detail.spans) || !detail.spans.length) return [];
    const rows = [];
    for (const [label, key] of LAYER_FIELDS) {
      const values = [...new Set(detail.spans.map(s => s?.values?.[key]).filter(v => typeof v === 'string' && v))];
      if (!values.length) continue;
      const parsed = key === 'modelName' ? parseLabel(values[0]) : null;
      rows.push({label, value: values.join(' / '), conflict: values.length > 1,
        note: parsed && globalThis.ArenaModelLabel ? globalThis.ArenaModelLabel.describeModelLabel(values[0]) : ''});
    }
    // The stream span and the usage span both report this for one turn, so count each turn once --
    // preferring the usage record, but falling back to the stream span when the usage span omits
    // the field entirely (it is present-but-zero on some runs and missing on others).
    const perTurn = new Map();
    for (const s of detail.spans) {
      if (typeof s?.values?.reasoningTokens !== 'number') continue;
      const key = Number.isSafeInteger(s.turn) ? s.turn : 'unknown';
      const prior = perTurn.get(key);
      if (!prior || (prior.kind !== 'usage' && s.kind === 'usage')) perTurn.set(key, s);
    }
    const reasoning = [...perTurn.values()].map(s => s.values.reasoningTokens);
    if (reasoning.length) rows.push({label: '推理 Token（实际产出，非请求档位）',
      value: reasoning.reduce((a, b) => a + b, 0).toLocaleString('zh-CN')});
    return rows;
  }
  // The trace's own per-run accounting (spend.recorded) carries a full account snapshot: allowance,
  // remaining balance and cumulative charge. Arena writes it server-side every run, so it outlives
  // the retirement of arena.ai/api/billing/balance. The snapshot is cumulative, so the newest turn wins.
  const QUOTA_KEYS = ['allowanceUsd', 'balanceRemainingUsd', 'chargedUserTotalUsd', 'allowanceTier',
    'allowanceSource', 'qualityScore', 'scoreVersion', 'overLimit', 'windowStartAtMs'];
  function traceQuota(detail) {
    if (!detail || !Array.isArray(detail.spans)) return null;
    const costs = detail.spans.filter(s => s && s.kind === 'cost' && s.values);
    if (!costs.length) return null;
    const newest = costs.reduce((a, b) => ((b.turn ?? 0) >= (a.turn ?? 0) ? b : a));
    const v = newest.values;
    if (!number(v.allowanceUsd) || v.allowanceUsd <= 0 || !number(v.balanceRemainingUsd)) return null;
    const out = {checkedAt: detail.checkedAt || null};
    for (const key of QUOTA_KEYS) if (v[key] !== undefined && v[key] !== null) out[key] = v[key];
    return out;
  }
  const usd = n => number(n) ? '$' + n.toFixed(2) : '未提供';
  // Cents matter here: a draw moves the balance by fractions of a cent, so rounding to whole
  // dollars would make the card look frozen. Only the allowance is abbreviated.
  const usdShort = n => !number(n) ? '—' : n >= 1000 ? '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : '$' + n.toFixed(2);
  const dayStamp = ms => { if (!Number.isFinite(ms)) return '未提供'; const d = new Date(ms); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const isoStamp = iso => { const ms = Date.parse(iso); return Number.isFinite(ms) ? dayStamp(ms) : '未提供'; };
  // Same shape the API path produces, so the card renders it with no branching.
  function traceQuotaCard(quota) {
    if (!quota) return null;
    const pct = Math.round(quota.balanceRemainingUsd / quota.allowanceUsd * 1000) / 10;
    const tier = [quota.allowanceTier, quota.allowanceSource].filter(Boolean).join(' · ');
    const rows = [
      ['剩余', usd(quota.balanceRemainingUsd) + ' / ' + usd(quota.allowanceUsd)],
      ['累计已用', usd(quota.chargedUserTotalUsd)],
      ...(tier ? [['额度档位', tier]] : []),
      ...(Number.isFinite(quota.windowStartAtMs) ? [['额度窗口自', dayStamp(quota.windowStartAtMs)]] : []),
      ['读取', isoStamp(quota.checkedAt)]
    ];
    return {
      value: usd(quota.balanceRemainingUsd) + ' · ' + pct + '%',
      note: '账户额度 ' + usd(quota.allowanceUsd) + ' · 累计已用 ' + usd(quota.chargedUserTotalUsd),
      short: usdShort(quota.balanceRemainingUsd), total: usdShort(quota.allowanceUsd), pct,
      tone: pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'low',
      rows,
      source: '来源：本 run 的 spend.recorded（服务端记账）——不是 arena.ai/api/billing/balance',
      error: quota.overLimit === true ? '账户额度已超限' : ''
    };
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
    const quota = traceQuota(detail);
    return {detail, detailPending, layers: modelLayers(detail), quota, quotaCard: traceQuotaCard(quota), runId: run?.runId || '', checkedAt: run?.checkedAt || (historical ? observations.map(o=>o.lastSeen||'').sort().at(-1) : state.checkedAt) || '', historical, models: shownModels, serverModels: uniqueModels, calls,
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
  globalThis.ArenaTraceView = {build,runsFor,tokens,money,completion,exportEvidence,displayModels,internalNames,modelLayers,traceQuota,traceQuotaCard};
})();

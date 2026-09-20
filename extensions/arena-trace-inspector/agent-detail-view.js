/* Agent span-detail renderer for HUD and popup (classic script, no fetch/storage). Shows layers separately; infers nothing across layers. */
(() => {
  const LIMITS = {turns: 6, spans: 24};
  const money = n => typeof n === 'number' ? '$' + n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '') : '未提供';
  const num = n => typeof n === 'number' ? n.toLocaleString('zh-CN') : '未提供';

  // Per-turn rows for the panel. Every row separates layers; nothing is inferred across layers.
  function detailView(detail) {
    const clean = detail && typeof detail === 'object' && Array.isArray(detail.spans) ? {...detail, spans: detail.spans.filter(s => s && typeof s === 'object' && ['stream','usage','cost'].includes(s.kind) && s.values && typeof s.values === 'object').slice(0, LIMITS.spans)} : null;
    if (!clean || !clean.spans.length) return {turns: [], note: clean?.stopped || '', checkedAt: clean?.checkedAt || null, limited: !!clean?.limited};
    const byTurn = new Map();
    for (const s of clean.spans) { const key = s.turn ?? 0; if (!byTurn.has(key)) byTurn.set(key, {turn: s.turn, stream: [], usage: [], cost: []}); byTurn.get(key)[s.kind].push(s); }
    const turns = [...byTurn.values()].sort((a, b) => (b.turn || 0) - (a.turn || 0)).map(t => {
      const pick = (list, name) => [...new Set(list.map(s => s.values[name]).filter(v => v !== undefined))];
      const one = (list, name) => { const v = pick(list, name); return v.length === 1 ? v[0] : v.length ? {conflict: v} : undefined; };
      const fmt = v => v === undefined ? '未提供' : v && typeof v === 'object' ? '冲突：' + v.conflict.map(String).join(' / ') : String(v);
      const internal = one([...t.usage, ...t.cost], 'modelName');
      const requestModel = one(t.stream, 'apiModelName') ?? one(t.stream, 'requestModel') ?? one(t.stream, 'apiModelId');
      const responseModel = one(t.stream, 'responseModel') ?? one(t.stream, 'genResponseModel');
      const provider = one(t.stream, 'provider') ?? one(t.usage, 'provider');
      const costSource = one(t.cost, 'costSource'), costUsd = one(t.cost, 'costUsd'), charged = one(t.cost, 'chargedUsd');
      const usageTotal = one(t.usage, 'totalTokens'), streamTotal = one(t.stream, 'totalTokens');
      const rows = [
        ['Arena 内部 modelName', fmt(internal) + (typeof internal === 'string' && globalThis.ArenaModelLabel ? (d => d ? '（' + d + '）' : '')(globalThis.ArenaModelLabel.describeModelLabel(internal)) : '')],
        ['供应商请求 model', fmt(requestModel)],
        ['供应商响应 model', fmt(responseModel) + (typeof responseModel === 'string' && typeof requestModel === 'string' ? (responseModel === requestModel ? ' · 与请求一致' : ' · 与请求不同') : '')],
        ['provider', fmt(provider)],
        ['temperature / topP / maxOutputTokens', [one(t.stream, 'temperature'), one(t.stream, 'topP'), one(t.stream, 'maxOutputTokens')].map(fmt).join(' / ')],
        ['finishReason', fmt(one(t.stream, 'finishReason'))],
        ['输入 / 输出 Token（usage 日志，输入不含缓存）', num(one(t.usage, 'inputTokens')) + ' / ' + num(one(t.usage, 'outputTokens'))],
        ['缓存读 / 推理 Token', num(one(t.usage, 'cacheReadTokens')) + ' / ' + num(one(t.usage, 'reasoningTokens'))],
        ['总 Token', num(usageTotal) + (typeof usageTotal === 'number' && typeof streamTotal === 'number' ? (usageTotal === streamTotal ? ' · 与 doStream 一致' : ' · doStream 记 ' + num(streamTotal)) : '')],
        ['模型成本 costUsd', money(costUsd) + (costSource === 'unpriced' ? '（未定价，非免费）' : '')],
        ['用户实付 chargedUsd', money(charged)],
        ['价格来源 / 定价策略', fmt(costSource) + ' / ' + fmt(one(t.cost, 'pricingStrategy'))]
      ];
      const quota = quotaOf(t.cost);
      if (quota) rows.push(['账户配额快照（spend.recorded，账户级）', quotaText(quota)]);
      const settingKeys = [...new Set(t.stream.flatMap(s => Array.isArray(s.settingKeys) ? s.settingKeys.filter(k => typeof k === 'string').map(k => k.slice(0, 80)) : []))];
      rows.push(['显式推理档位字段', settingKeys.length ? '存在键：' + settingKeys.join(', ') : '未出现（ai.settings 仅含上列项）']);
    const metaEntries = t.stream.flatMap(s => Object.entries(s.providerMeta && typeof s.providerMeta === 'object' ? s.providerMeta : {})).filter(([k, v]) => typeof k === 'string' && (typeof v === 'number' || typeof v === 'boolean' || v === null || typeof v === 'string' && v.length <= 60));
    rows.push(['providerMetadata（结构）', metaEntries.length ? metaEntries.slice(0, 20).map(([k, v]) => k + '=' + String(v)).join(' · ') + (metaEntries.length > 20 ? ' · …' : '') : '未读取或为空']);
    const optEntries = t.stream.flatMap(s => Object.entries(s.providerOptions && typeof s.providerOptions === 'object' ? s.providerOptions : {})).filter(([k, v]) => typeof k === 'string' && (typeof v === 'number' || typeof v === 'boolean' || v === null || typeof v === 'string' && v.length <= 60));
    if (optEntries.length) rows.push(['providerOptions（请求侧配置）', optEntries.slice(0, 20).map(([k, v]) => k + '=' + String(v)).join(' · ')]);
      return {quota, turn: t.turn, title: (t.turn ? '第 ' + t.turn + ' 轮' : '轮次未知') + ' · ' + (typeof internal === 'string' ? internal : '内部名未提供'), rows, spanIds: [...t.stream, ...t.usage, ...t.cost].map(s => s.spanId), partial: [...t.stream, ...t.usage, ...t.cost].some(s => s.partial), messageId: one(t.cost, 'messageId') ?? one(t.usage, 'messageId')};
    });
    const notes = [];
    if (clean.limited) notes.push('只读取最近 ' + LIMITS.turns + ' 轮（共 ' + (clean.turnCount ?? '?') + ' 轮）');
    if (clean.stopped) notes.push(clean.stopped);
    const quota = turns.map(t => t.quota).find(Boolean) || null;
    return {turns, quota, note: notes.join('；'), checkedAt: clean.checkedAt, limited: clean.limited};
  }

  // Allowance snapshot from a turn's cost span(s). Values are copied, never computed (balance is NOT derived from allowance - charged).
  function quotaOf(costSpans) {
    const src = [...costSpans].reverse().find(s => ['allowanceUsd', 'balanceRemainingUsd', 'chargedUserTotalUsd', 'overLimit', 'allowanceTier'].some(k => s.values[k] !== undefined));
    if (!src) return null;
    const v = src.values, out = {};
    for (const k of ['allowanceTier', 'allowanceUsd', 'chargedUserTotalUsd', 'balanceRemainingUsd', 'overLimit', 'surface']) if (v[k] !== undefined) out[k] = v[k];
    return out;
  }
  const usd = n => typeof n === 'number' ? '$' + (Math.round(n * 1e6) / 1e6).toString() : '未提供';
  function quotaText(q) {
    return '额度 ' + usd(q.allowanceUsd) + ' · 已用 ' + usd(q.chargedUserTotalUsd) + ' · 余额 ' + usd(q.balanceRemainingUsd)
      + (q.overLimit === true ? ' · 已超限' : q.overLimit === false ? ' · 未超限' : '') + (q.allowanceTier ? ' · tier ' + q.allowanceTier : '');
  }

  globalThis.ArenaAgentDetailView = {detailView, quotaText, LIMITS};
})();

/* Shared popup / isolated content-script view model. No DOM or browser API access. */
(() => {
  const provider = x => (typeof x === 'string' && /^[\w.-]{1,100}$/.test(x) && !/^(?:hero|tabler|lucide|icon)-/i.test(x) ? x : '');
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const tokens = (n, approximate) => (number(n) ? (approximate ? '≈' : '') + n.toLocaleString('zh-CN') : '未提供');
  const money = n => (number(n) ? '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '未提供');
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
    return runs.sort((a, b) => stamp(b).localeCompare(stamp(a)));
    function stamp(r) {
      return (
        r.checkedAt ||
        (record.observations || [])
          .filter(o => o.runId === r.runId)
          .map(o => o.lastSeen || '')
          .sort()
          .at(-1) ||
        ''
      );
    }
  }
  // 1.7.0: when the run's span detail carries a public Arena internal modelName whose base matches the server label
  // (e.g. claude-fable-5.1-high ↔ claude-fable-5-1, gpt-6-astra-low ↔ gpt-6-astra), show the internal name instead of the
  // nickname. Anonymous codenames never replace anything; a mismatch or conflict keeps the server label untouched.
  const norm = x =>
    String(x || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const ANON_RE = /^[a-z]{3,12}-(?:[a-z]{3,12}-)?[a-z0-9]{4,6}$/,
    KNOWN_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|glm|grok|llama|mistral|kimi|minimax|mimo|muse|step|nemotron|doubao|o\d|fable|nova|command|phi)/i;
  function parseLabel(label) {
    if (globalThis.ArenaModelLabel) return globalThis.ArenaModelLabel.parseModelLabel(label);
    if (typeof label !== 'string' || !label) return null;
    let base = label.replace(/-(\d{8}|\d{4})$/, '');
    const t = base.match(/-(minimal|low|medium|high|xhigh|max)$/);
    if (t) base = base.slice(0, -t[0].length);
    return {label, base, tier: t ? t[1] : null, anonymous: !t && !KNOWN_FAMILY.test(label) && ANON_RE.test(label)};
  }
  function internalNames(detail) {
    if (!detail || !Array.isArray(detail.spans)) return [];
    return [...new Set(detail.spans.filter(s => s && ['usage', 'cost'].includes(s.kind) && typeof s.values?.modelName === 'string').map(s => s.values.modelName))];
  }
  // A 200 response and finished span flags do not prove modelName has propagated.
  // Both accounting kinds of the newest selected turn must be present, and every
  // selected naming span must contain a nonempty internal name. Conflicting public
  // variants of the same server label are not a safe naming fallback either.
  function detailNamingReady(detail, models = []) {
    const spans = detail?.spans;
    if (detail?.stopped || !Array.isArray(spans) || !spans.length || spans.some(s => s?.partial !== false)) return false;
    const turn = s => (Number.isSafeInteger(s.turn) && s.turn > 0 ? s.turn : 0);
    const latest = Math.max(...spans.map(turn));
    if (!['usage', 'cost'].every(kind => spans.some(s => s.kind === kind && turn(s) === latest))) return false;
    const naming = spans.filter(s => ['usage', 'cost'].includes(s.kind));
    if (naming.some(s => typeof s.values?.modelName !== 'string' || !s.values.modelName.trim())) return false;
    return !modelMatches(models, detail).some(x => x.status === 'conflict');
  }
  function modelMatches(models, detail) {
    const labels = models.map(m => m.serverLabel || m.model),
      names = internalNames(detail);
    if (globalThis.ArenaModelLabel?.matchModelNames) return globalThis.ArenaModelLabel.matchModelNames(labels, names);
    // Old standalone consumers without the shared parser remain conservative.
    return labels.map(serverLabel => {
      const candidates = [
        ...new Set(
          names
            .map(parseLabel)
            .filter(p => p && !p.anonymous && norm(p.base) === norm(serverLabel))
            .map(p => p.label)
        )
      ];
      return {
        serverLabel,
        status: candidates.length > 1 ? 'conflict' : candidates.length === 1 ? 'matched' : names.length ? 'mismatch' : 'missing',
        method: candidates.length === 1 ? 'base' : null,
        candidates
      };
    });
  }
  function displayModels(models, detail) {
    const matches = modelMatches(models, detail);
    return models.map(m => {
      const hit = matches.find(x => x.serverLabel === (m.serverLabel || m.model));
      return hit?.status === 'matched' ? {...m, model: hit.candidates[0], serverLabel: m.serverLabel || m.model, internal: true} : m;
    });
  }
  // Read-only coverage explanation. No naming, policy, persisted task or route decision
  // consumes this projection. Exact span ID links are distinct from same-turn evidence.
  function callCoverage(calls = [], detail = null, runCheckedAt = null) {
    const CAP = 500,
      SHOW = 40,
      all = Array.isArray(calls) ? calls : [],
      spans = Array.isArray(detail?.spans) ? detail.spans.slice(0, 24) : [];
    const text = v => (typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
    const turn = s => (Number.isSafeInteger(s?.turn) && s.turn > 0 ? s.turn : null);
    const byId = new Map(),
      callCounts = new Map();
    for (const d of spans)
      if (d?.kind === 'stream' && text(d.spanId)) {
        if (!byId.has(d.spanId)) byId.set(d.spanId, []);
        byId.get(d.spanId).push(d);
      }
    for (const c of all.slice(0, CAP)) if (text(c?.spanId)) callCounts.set(c.spanId, (callCounts.get(c.spanId) || 0) + 1);
    const rows = all.slice(0, CAP).map((c, i) => {
      const candidates = byId.get(c?.spanId) || [],
        ambiguous = candidates.length > 1 || (callCounts.get(c?.spanId) || 0) > 1,
        d = !ambiguous && candidates.length === 1 ? candidates[0] : null;
      return {
        index: i + 1,
        spanId: text(c?.spanId),
        model: text(c?.model) || '模型未记录',
        turn: turn(d),
        streamState: ambiguous ? 'ambiguous' : !d ? 'missing' : d.partial !== false || c.partial !== false || c.error === true || c.cancelled === true ? 'partial' : 'present',
        accountingState: 'unlinked',
        mapping: null,
        internalNames: []
      };
    });
    const turns = [...new Set(spans.map(turn).filter(x => x !== null))]
      .sort((a, b) => a - b)
      .map(n => {
        const ds = spans.filter(s => turn(s) === n),
          accounting = ds.filter(s => ['usage', 'cost'].includes(s.kind)),
          linked = rows.filter(c => c.turn === n),
          usage = accounting.filter(s => s.kind === 'usage'),
          cost = accounting.filter(s => s.kind === 'cost');
        const labels = [...new Set(linked.map(c => c.model).filter(x => x !== '模型未记录'))],
          names = internalNames({spans: accounting});
        const status =
          !usage.length && !cost.length
            ? 'missing-both'
            : !usage.length
              ? 'missing-usage'
              : !cost.length
                ? 'missing-cost'
                : accounting.some(s => s.partial !== false || typeof s.values?.modelName !== 'string' || !s.values.modelName.trim())
                  ? 'partial'
                  : 'present';
        const matches = modelMatches(
          labels.map(model => ({model})),
          {spans: accounting}
        );
        for (const row of linked) {
          const match = matches.find(m => m.serverLabel === row.model);
          row.accountingState = status;
          row.mapping = match?.status || null;
          row.internalNames = match?.candidates || [];
        }
        return {
          turn: n,
          linkedCalls: linked.length,
          streamDetails: ds.filter(s => s.kind === 'stream').length,
          usageSpans: usage.length,
          costSpans: cost.length,
          accountingState: status,
          internalNames: names,
          multipleServerLabels: labels.length > 1
        };
      });
    const counts = {
      totalCalls: all.length,
      scannedCalls: rows.length,
      streamDetails: rows.filter(c => ['present', 'partial'].includes(c.streamState)).length,
      missingStream: rows.filter(c => c.streamState === 'missing').length,
      ambiguousStream: rows.filter(c => c.streamState === 'ambiguous').length,
      partialStream: rows.filter(c => c.streamState === 'partial').length,
      withTurnAccounting: rows.filter(c => c.accountingState === 'present').length
    };
    const missing = counts.missingStream,
      markers = [];
    if (detail?.limited === true) markers.push('saved-limit-marker');
    if (detail?.stopped) markers.push('saved-stop-marker');
    const detailTime = Date.parse(detail?.checkedAt),
      runTime = Date.parse(runCheckedAt);
    if (Number.isFinite(detailTime) && Number.isFinite(runTime) && detailTime < runTime) markers.push('detail-older-than-call-snapshot');
    const diagnosis = {
      status: !all.length ? 'no-calls' : !detail ? 'no-saved-detail' : counts.ambiguousStream ? 'span-link-conflict' : missing ? 'unlinked-stream-details' : 'linked-within-saved-snapshot',
      markers,
      causeConfirmed: false
    };
    return {
      schemaVersion: 1,
      counts,
      diagnosis,
      calls: rows.slice(0, SHOW),
      turns,
      truncated: all.length > CAP || rows.length > SHOW,
      detailLimited: detail?.limited === true || (detail?.spans?.length || 0) > 24,
      detailStopped: !!detail?.stopped,
      association: 'exact-span-for-stream;same-turn-only-for-accounting'
    };
  }
  function modelEvidence(models, detail, calls = [], runCheckedAt = null) {
    const rows = [],
      clean = v => (typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\r\n\u0000-\u001f]/.test(v) && !/^eyJ/.test(v) ? v : null);
    const add = (layer, path, value, span = null) => {
      value = clean(value);
      if (!value || rows.length >= 160) return;
      rows.push({layer, path, value, turn: Number.isSafeInteger(span?.turn) && span.turn > 0 ? span.turn : null, spanId: clean(span?.spanId), partial: span?.partial === true});
    };
    for (const m of models.slice(0, 24)) {
      const call = calls.find(c => c.model === m.model),
        span = call ? (detail?.spans || []).find(s => s.spanId === call.spanId) : null;
      add(
        'server',
        call?.evidence?.model?.path || (call ? 'run.spans[].model（已解析标签）' : 'state.models[].model（已解析标签）'),
        m.model,
        call ? {spanId: call.spanId, turn: span?.turn, partial: call.partial} : null
      );
    }
    for (const span of (detail?.spans || []).slice(0, 24)) {
      const v = span?.values;
      if (!v || typeof v !== 'object') continue;
      if (['usage', 'cost'].includes(span.kind)) add('internal', span.kind + '.modelName', v.modelName, span);
      if (span.kind === 'stream')
        for (const [layer, key, path] of [
          ['request', 'apiModelId', 'ai.model.id'],
          ['request', 'apiModelName', 'ai.telemetry.metadata.apiModelName'],
          ['request', 'requestModel', 'gen_ai.request.model'],
          ['response', 'responseModel', 'ai.response.model'],
          ['response', 'genResponseModel', 'gen_ai.response.model']
        ])
          add(layer, path, v[key], span);
    }
    const matches = modelMatches(models, detail);
    return {
      rows,
      matches,
      coverage: callCoverage(calls, detail, runCheckedAt),
      hasAnonymous: internalNames(detail).some(x => parseLabel(x)?.anonymous),
      limited: detail?.limited === true || (detail?.spans?.length || 0) > 24 || models.length > 24,
      stopped: !!detail?.stopped
    };
  }
  function authorizationSummary(value, historical) {
    if (historical || !value || typeof value !== 'object' || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    const count = key => (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 99 ? value[key] : 0);
    const scopeCount = count('scopeCount'),
      writeScopeCount = count('writeScopeCount'),
      extraReadScopeCount = count('extraReadScopeCount'),
      otherScopeCount = count('otherScopeCount');
    return {
      expiresAt: value.expiresAt,
      scopeCount,
      writeScopeCount,
      extraReadScopeCount,
      otherScopeCount,
      level: writeScopeCount ? 'write' : extraReadScopeCount || otherScopeCount ? 'expanded' : 'readOnly'
    };
  }
  const time = value => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null);
  function runtimeEvidence({historical, calls, models, detail, checkedAt, switchInfo}) {
    const modelCalls = calls.filter(c => typeof c?.model === 'string' && c.model);
    const observed = modelCalls.filter(c => typeof c.evidence?.model?.value === 'string' && c.evidence.model.value);
    let level = 'waiting',
      label = '尚无证据',
      note = '等待已白名单的模型调用记录。';
    if (historical) {
      level = 'historical';
      label = '历史记录';
      note = '本地历史不会被视为重新验证。';
    } else if (observed.length && observed.length === modelCalls.length) {
      level = 'confirmed';
      label = '已确认';
      note = '每个已记录模型调用均保留了原始标签观测。';
    } else if (observed.length) {
      level = 'partial';
      label = '部分确认';
      note = '仅部分已记录模型调用保留了原始标签观测。';
    } else if (modelCalls.length || models.length || detail) {
      level = 'recorded';
      label = '记录待佐证';
      note = '有已捕获记录，但没有可用的原始模型标签观测。';
    }
    const timeline = [];
    const add = (kind, at, title, detailText) => timeline.push({kind, at: time(at), title, detail: String(detailText || '').slice(0, 240)});
    // One row per distinct (label, observation time). A single run emits many doStream spans that
    // share both, and one row per span floods the card with identical entries. Counts stay exact.
    const labelRows = new Map();
    for (const call of observed) {
      const value = call.evidence.model.value,
        at = time(call.evidence.model.observedAt);
      const key = value + '\u0000' + (at || '');
      const hit = labelRows.get(key);
      if (hit) hit.count += 1;
      else labelRows.set(key, {value, at, count: 1});
    }
    for (const row of labelRows.values()) add('model-label', row.at, '模型标签', row.count > 1 ? row.value + ' · ' + row.count + ' 次观测' : row.value);
    if (time(checkedAt)) add('run-check', checkedAt, '运行检查', '已检查 ' + calls.length + ' 个已捕获调用');
    if (detail && time(detail.checkedAt)) add('span-detail', detail.checkedAt, 'span 详情', '已读取 ' + detail.spans.length + ' 个白名单 span');
    if (switchInfo?.state === 'switched') add('route', switchInfo.at, '模型路由', '已确认：' + switchInfo.from + ' → ' + switchInfo.to);
    else if (switchInfo?.state === 'suspected') add('route', null, '模型路由', '疑似：' + switchInfo.from + ' → 未确认');
    timeline.sort((a, b) => (a.at || '\uffff').localeCompare(b.at || '\uffff') || a.title.localeCompare(b.title));
    return {level, label, note, modelCalls: modelCalls.length, observedCalls: observed.length, timeline};
  }
  const COMPATIBILITY_CHECKS = [
    ['trace-events', 'trace.events'],
    ['run-events', 'trace.events[runId]'],
    ['stream-spans', 'events[].message = ai.streamText.doStream'],
    ['span-id', 'events[].spanId'],
    ['accessory-items', 'events[].style.accessory.items'],
    ['model-label', 'items[icon=tabler-cube]']
  ];
  function compatibilitySummary(value, historical) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.checks)) return null;
    const allowed = new Set(['ok', 'pending', 'missing', 'invalid', 'limited', 'unavailable']);
    const states = Object.fromEntries(
      COMPATIBILITY_CHECKS.map(([id]) => [id, allowed.has(value.checks.find(check => check?.id === id)?.status) ? value.checks.find(check => check?.id === id).status : 'unavailable'])
    );
    const level =
      states['trace-events'] === 'limited'
        ? 'limited'
        : Object.values(states).includes('invalid')
          ? 'incompatible'
          : states['run-events'] === 'pending' || states['stream-spans'] === 'pending'
            ? 'pending'
            : Object.values(states).includes('missing')
              ? 'partial'
              : COMPATIBILITY_CHECKS.every(([id]) => states[id] === 'ok')
                ? 'compatible'
                : 'unknown';
    const copy = {
      compatible: ['兼容', '当前 trace 符合已支持的固定字段路径。'],
      pending: ['等待事件', '本次运行所需事件尚未出现，可能仍在传播；未判定为协议漂移。'],
      partial: ['部分兼容', '核心结构可读，但部分模型标签尚未出现。'],
      incompatible: ['需要更新', '固定字段路径缺失或类型不符；不会猜测替代路径。'],
      limited: ['读取受限', 'trace 超出安全解析范围，未检查后续结构。'],
      unknown: ['未评估', '没有可用的兼容性快照。']
    }[level];
    const words = {pending: '尚未出现', missing: '缺少标签', invalid: '类型或路径不符', limited: '安全上限'};
    // Re-map by index so a malformed input can never select a dynamic location or message.
    const safeIssues = COMPATIBILITY_CHECKS.map(([id, location]) => (!['ok', 'unavailable'].includes(states[id]) ? {location, status: words[states[id]] || '未评估'} : null)).filter(Boolean);
    return {level, label: historical ? '历史快照 · ' + copy[0] : copy[0], note: historical ? '历史快照；' + copy[1] : copy[1], issues: safeIssues};
  }
  function recoveryView(state, localOnly = false) {
    const phases = {
      idle: '等待授权',
      scan: '扫描页面',
      session: '核对会话',
      replay: '回放事件',
      run: '取得运行授权',
      trace: '读取 trace',
      ready: '已取得运行证据',
      waiting: '等待可用数据',
      partial: '部分完成',
      error: '读取失败',
      blocked: '安全停止',
      expired: '授权已过期'
    };
    const raw = localOnly ? {} : state.recovery || {},
      phase = Object.hasOwn(phases, raw.phase) ? raw.phase : 'idle';
    const text = v => (typeof v === 'string' ? v.slice(0, 240) : '');
    const time = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
    const info = localOnly ? {} : state.sessionInfo || {};
    return {
      phase,
      label: phases[phase],
      message: text(raw.message),
      checkedAt: time(raw.checkedAt),
      source: localOnly ? '本地历史 · 未重新验证' : raw.source === 'page' ? '页面授权 / 远端核对' : raw.source === 'live' ? '当前页面实时流' : '尚未远端核对',
      currentRunId: typeof info.currentRunId === 'string' && /^run_[a-zA-Z0-9]+$/.test(info.currentRunId) ? info.currentRunId : null,
      closedAt: time(info.closedAt),
      expiresAt: time(info.expiresAt),
      busy: ['scan', 'session', 'replay', 'run', 'trace'].includes(phase),
      canRetry: !localOnly && state.enabled === true && !state.generating && !state.captureHalted && !!state.sessionId && !['scan', 'session', 'replay', 'run', 'trace'].includes(phase)
    };
  }
  function build(state = {}, record = null, selectedRunId = '') {
    const historyRuns = runsFor(record);
    const historical = !!selectedRunId || !!state.historical || !state.runId;
    const run = selectedRunId ? historyRuns.find(r => r.runId === selectedRunId) : state.runId ? (state.run?.runId === state.runId ? state.run : {runId: state.runId, spans: []}) : historyRuns[0];
    const observations = (record?.observations || []).filter(o => o.runId === run?.runId);
    const calls = [...new Map((run?.spans || []).map(s => [s.spanId, s])).values()].map(s => ({
      ...s,
      evidence: cleanEvidence(s.evidence),
      provider: provider(s.provider) || provider(observations.find(o => o.spanId === s.spanId)?.provider)
    }));
    const models = calls.length
      ? calls.filter(c => c.model).map(c => ({model: c.model, provider: c.provider}))
      : historical
        ? observations.length
          ? observations
          : state.models || []
        : state.models || [];
    const uniqueModels = models.map(m => ({...m, provider: provider(m.provider)})).filter((m, i, a) => a.findIndex(n => n.model === m.model && n.provider === m.provider) === i);
    const tokenCalls = calls.filter(c => number(c.tokens)),
      costCalls = calls.filter(c => number(c.costUsd));
    const tokenSum = tokenCalls.length ? tokenCalls.reduce((n, c) => n + c.tokens, 0) : null;
    const costSum = costCalls.length ? Math.round(costCalls.reduce((n, c) => n + c.costUsd, 0) * 1e9) / 1e9 : null;
    const detail = run?.detail && typeof run.detail === 'object' && Array.isArray(run.detail.spans) ? run.detail : null;
    const collection = globalThis.ArenaCollection?.sanitizeCollection(!historical && state.collection?.runId === run?.runId ? state.collection.diagnostic : run?.collection) || null;
    const shownModels = displayModels(uniqueModels, detail);
    const detailPending = !historical && !!run?.runId && state.detailPending === true;
    // A cleared spinner (including failure/timeout) is NOT proof that detail arrived.
    const renameReady =
      !historical &&
      state.enabled === true &&
      state.saved === true &&
      state.renameReady === true &&
      state.generating !== true &&
      !detailPending &&
      !!detail &&
      !detail.stopped &&
      detail.spans.length > 0 &&
      detailNamingReady(detail, uniqueModels) &&
      completion(calls) === '调用已完成';
    const switchInfo = (() => {
      const clean = v => {
        if (!v || typeof v !== 'object') return null;
        const from = typeof v.from === 'string' ? v.from.trim().slice(0, 200) : '';
        if (!from) return null;
        if (v.state === 'suspected') return {state: 'suspected', from, to: '', suspectedAt: String(v.suspectedAt || '').slice(0, 128), confirmedAt: ''};
        if (v.state !== 'switched') return null;
        const to = typeof v.to === 'string' ? v.to.trim().slice(0, 200) : '';
        if (!to || to === from) return null;
        const out = {state: 'switched', from, to, suspectedAt: String(v.suspectedAt || '').slice(0, 128), confirmedAt: String(v.confirmedAt || '').slice(0, 128)};
        if (typeof v.at === 'string' && v.at.length <= 40) out.at = v.at;
        return out;
      };
      const list = [run?.switch, record?.switch, state?.switch].map(clean);
      return list.find(x => x?.state === 'switched') || list.find(x => x?.state === 'suspected') || null;
    })();
    const renameTitle = (() => {
      const name = shownModels[0]?.model || '';
      return switchInfo?.state === 'switched' && name && !name.includes('(被路由)') ? (name + '(被路由)').slice(0, 100) : name.slice(0, 100);
    })();
    const checkedAt =
      run?.checkedAt ||
      (historical
        ? observations
            .map(o => o.lastSeen || '')
            .sort()
            .at(-1)
        : state.checkedAt) ||
      '';
    const evidenceStatus = runtimeEvidence({historical, calls, models: shownModels, detail, checkedAt, switchInfo});
    const compatibility = compatibilitySummary(run?.compatibility || state.compatibility, historical);
    const freshness =
      globalThis.ArenaCollection?.freshnessView({
        historical,
        enabled: state.enabled === true,
        sessionId: state.sessionId,
        runId: run?.runId,
        context: state.detailObservation,
        collection,
        detail,
        generating: state.generating === true,
        detailPending
      }) || null;
    return {
      freshness,
      collection,
      modelEvidence: modelEvidence(uniqueModels, detail, calls, run?.checkedAt || checkedAt),
      sessionId: state.sessionId || record?.sessionId || null,
      recovery: recoveryView(state, !!selectedRunId || !state.sessionId),
      rawArchive: state.rawArchive
        ? {
            limited: state.rawArchive.limited === true,
            events: String(state.rawArchive.events || ''),
            detail: String(state.rawArchive.detail || ''),
            capturedSpans: Number(state.rawArchive.capturedSpans) || 0,
            selectedSpans: Number(state.rawArchive.selectedSpans) || 0,
            error: typeof state.rawArchive.error === 'string' ? state.rawArchive.error.slice(0, 160) : ''
          }
        : null,
      detail,
      detailPending,
      renameReady,
      switch: switchInfo,
      renameTitle,
      authorization: authorizationSummary(state.authorization, historical),
      compatibility,
      runId: run?.runId || '',
      checkedAt,
      historical,
      models: shownModels,
      serverModels: uniqueModels,
      calls,
      evidenceStatus,
      timeline: evidenceStatus.timeline,
      completion: completion(calls),
      tokens: tokens(
        tokenSum,
        tokenCalls.some(c => c.tokensApproximate)
      ),
      cost: money(costSum),
      tokenCoverage: `${tokenCalls.length}/${calls.length}`,
      costCoverage: `${costCalls.length}/${calls.length}`,
      tokenMissing: tokenCalls.length < calls.length,
      costMissing: costCalls.length < calls.length,
      count: calls.length ? String(calls.length) : run?.runId ? '未提供' : '—',
      evidenceCount: calls.filter(c => c.evidence?.schemaVersion === 1).length,
      source: run?.runId ? (historical ? '本地历史 · 非重新验证' : '本次捕获') : '等待捕获'
    };
  }
  function exportEvidence(view) {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      runId: view.runId,
      checkedAt: view.checkedAt,
      historical: view.historical,
      scope: '仅已捕获的 ai.streamText.doStream 调用；非原始 trace 全文',
      collection: globalThis.ArenaCollection?.sanitizeCollection(view.collection) || null,
      freshness: globalThis.ArenaCollection?.sanitizeFreshness(view.freshness) || null,
      detail: view.detail
        ? {
            checkedAt: view.detail.checkedAt || null,
            limited: !!view.detail.limited,
            stopped: view.detail.stopped || null,
            spans: view.detail.spans.map(s => ({
              spanId: s.spanId,
              kind: s.kind,
              turn: s.turn ?? null,
              partial: !!s.partial,
              values: {...s.values},
              ...(typeof s.values.modelName === 'string' && globalThis.ArenaModelLabel ? {modelLabel: globalThis.ArenaModelLabel.parseModelLabel(s.values.modelName)} : {}),
              settingKeys: [...(s.settingKeys || [])],
              ...(s.reasoning && globalThis.ArenaReasoningEvidence ? {reasoning: globalThis.ArenaReasoningEvidence.sanitizeReasoningEvidence(s.reasoning)} : {}),
              ...(s.providerMeta ? {providerMeta: {...s.providerMeta}} : {}),
              ...(s.providerOptions ? {providerOptions: {...s.providerOptions}} : {})
            }))
          }
        : null,
      calls: view.calls.map(c => ({
        spanId: c.spanId,
        model: c.model,
        provider: c.provider,
        tokens: c.tokens ?? null,
        tokensApproximate: !!c.tokensApproximate,
        costUsd: c.costUsd ?? null,
        partial: c.partial ?? null,
        error: c.error ?? null,
        cancelled: c.cancelled ?? null,
        evidence: cleanEvidence(c.evidence),
        provenance: c.evidence?.schemaVersion === 1 ? 'observed-trace-labels' : 'legacy-local-record-no-raw-labels'
      }))
    };
  }
  function cleanEvidence(e) {
    if (e?.schemaVersion !== 1) return null;
    const out = {schemaVersion: 1, source: 'Trigger.dev run events', spanName: 'ai.streamText.doStream'};
    for (const k of ['model', 'provider', 'tokens', 'cost'])
      if (e[k] && (k !== 'provider' || /^ai-provider-[\w.-]{1,80}$/.test(e[k].value)))
        out[k] = {path: String(e[k].path || '').slice(0, 200), value: String(e[k].value || '').slice(0, 200), observedAt: e[k].observedAt || null};
    if (e.flags) out.flags = {isPartial: e.flags.isPartial ?? null, isError: e.flags.isError ?? null, isCancelled: e.flags.isCancelled ?? null, observedAt: e.flags.observedAt || null};
    return out;
  }
  globalThis.ArenaTraceView = {
    build,
    runsFor,
    tokens,
    money,
    completion,
    exportEvidence,
    displayModels,
    modelMatches,
    modelEvidence,
    callCoverage,
    internalNames,
    detailNamingReady,
    authorizationSummary,
    runtimeEvidence,
    compatibilitySummary,
    recoveryView
  };
})();

/* Read-only, bounded detail-pipeline diagnostics. No network, retries or action policy.
   Single classic implementation; collection.js exposes the same functions to ESM. */
(function () {
  const PHASES = new Set(['planned', 'reading', 'validated', 'stopped', 'failed']);
  const GATES = new Set(['waiting-existing-gates', 'no-model-label', 'read-started']);
  const FAILURES = new Set(['selection-invalid', 'wait-failed', 'network-error', 'aborted', 'timeout', 'body-read-failed', 'http-error', 'response-too-large', 'invalid-json', 'identity-mismatch']);
  const STATES = new Set(['selected', 'requesting', 'validated', ...FAILURES]);
  const PERSISTENCE = new Set(['memory-only', 'pending', 'saved-metadata', 'saved-detail', 'failed']);
  const number = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
  const date = s => (typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null);
  function sanitizeCollection(input) {
    if (input?.schemaVersion !== 1 || input.source !== 'detail-pipeline' || !PHASES.has(input.phase) || !Array.isArray(input.spans) || input.spans.length > 24) return null;
    const spans = [];
    for (const s of input.spans) {
      if (!s || typeof s.spanId !== 'string' || !/^[a-f0-9]{16,32}$/.test(s.spanId) || !['stream', 'usage', 'cost'].includes(s.kind) || !STATES.has(s.state)) return null;
      spans.push({
        spanId: s.spanId,
        kind: s.kind,
        turn: Number.isSafeInteger(s.turn) && s.turn > 0 && s.turn <= 9999 ? s.turn : null,
        partial: s.partial !== false,
        state: s.state,
        httpStatus: Number.isInteger(s.httpStatus) && s.httpStatus >= 100 && s.httpStatus <= 599 ? s.httpStatus : null
      });
    }
    let selection = null;
    if (input.selection) {
      selection = {};
      for (const k of ['events', 'matchingEvents', 'foreignEvents', 'streamCalls', 'turns', 'eligible', 'selected', 'excludedTurnLimit', 'excludedSpanLimit']) {
        if (!number(input.selection[k])) return null;
        selection[k] = input.selection[k];
      }
      if (
        selection.events !== selection.matchingEvents + selection.foreignEvents ||
        selection.selected !== spans.length ||
        selection.eligible !== selection.selected + selection.excludedTurnLimit + selection.excludedSpanLimit ||
        selection.eligible > selection.matchingEvents ||
        selection.streamCalls > selection.eligible ||
        selection.turns > selection.matchingEvents
      )
        return null;
      const {turns, spans: limit} = input.selection.limits || {};
      if (!Number.isInteger(turns) || turns < 1 || turns > 6 || !Number.isInteger(limit) || limit < 1 || limit > 24 || selection.selected > limit) return null;
      selection.limits = {turns, spans: limit};
    } else if (spans.length) return null;
    const validated = spans.filter(s => s.state === 'validated').length;
    const persistence = PERSISTENCE.has(input.persistence) ? input.persistence : 'memory-only';
    const savedSpans = persistence === 'saved-detail' && Number.isInteger(input.savedSpans) && input.savedSpans >= 0 && input.savedSpans <= validated ? input.savedSpans : null;
    return {
      schemaVersion: 1,
      source: 'detail-pipeline',
      observedAt: date(input.observedAt),
      attempt: Number.isInteger(input.attempt) && input.attempt >= 0 && input.attempt <= 4 ? input.attempt : 0,
      phase: input.phase,
      gate: GATES.has(input.gate) ? input.gate : 'waiting-existing-gates',
      selection,
      spans,
      counts: {
        attempted: spans.filter(s => s.state !== 'selected').length,
        received: spans.filter(s => s.httpStatus !== null).length,
        validated,
        rejected: spans.filter(s => ['invalid-json', 'identity-mismatch'].includes(s.state)).length,
        notAttempted: spans.filter(s => s.state === 'selected').length,
        inFlight: spans.filter(s => s.state === 'requesting').length
      },
      failure: FAILURES.has(input.failure) ? input.failure : null,
      persistence,
      savedSpans
    };
  }
  function withPersistence(input, persistence, savedSpans = null) {
    return sanitizeCollection({...input, persistence, savedSpans});
  }
  function collectionRows(input) {
    const d = sanitizeCollection(input);
    if (!d) return [['采集过程', '旧记录未保存阶段诊断；缺失原因未知']];
    const s = d.selection,
      c = d.counts,
      rows = [
        ['诊断范围', '仅此 run 的一次详情选择／读取快照，不是全部历史缺失原因'],
        ['快照', d.observedAt || '时间未记录'],
        ['详情尝试', String(d.attempt) + '（沿用既有补读规则，不新增重试）']
      ];
    if (s)
      rows.push(
        ['发现', s.matchingEvents + ' 个同 run 事件 · ' + s.streamCalls + ' 个 stream 调用 · ' + s.turns + ' 轮（含详情候选）'],
        ['选择', s.selected + '/' + s.eligible + ' 个候选；轮数预算排除 ' + s.excludedTurnLimit + '；span 预算排除 ' + s.excludedSpanLimit],
        ['读取／校验', '尝试 ' + c.attempted + ' · 收到响应 ' + c.received + ' · 校验通过 ' + c.validated + ' · 拒收 ' + c.rejected + ' · 尚未尝试 ' + c.notAttempted]
      );
    else rows.push(['选择', '格式未接受，选择计数未知']);
    const phase = {
      planned: '尚无详情读取结果，仍受既有门禁控制',
      reading: '读取中；中断后没有终止记录不能认定失败',
      validated: '本次选择范围读取结束',
      stopped: '本次详情读取已停止',
      failed: '本次详情阶段失败'
    };
    rows.push(['阶段', phase[d.phase]]);
    const failures = {
      'selection-invalid': '选择输入未通过校验',
      'wait-failed': '间隔等待失败',
      'network-error': '请求失败；底层网络原因未确认',
      aborted: '已观察到取消；不能仅凭取消认定超时',
      timeout: '本地详情超时计时器已触发',
      'body-read-failed': '读取响应体失败',
      'http-error': '收到非成功 HTTP 响应',
      'response-too-large': '响应超过既有体积上限',
      'invalid-json': '响应不是有效 JSON',
      'identity-mismatch': 'run/span/message 绑定校验未通过'
    };
    if (d.failure) rows.push(['已观察到的停止点', failures[d.failure]]);
    const persistence = {
      'memory-only': '仅在内存中；尚未确认保存',
      pending: '保存等待中，不能认定已落盘',
      'saved-metadata': '诊断随元数据保存；不代表详情已保存',
      'saved-detail': '诊断与详情同次写入；保存 ' + (d.savedSpans ?? '未知') + ' 个详情',
      failed: '本地保存未成功确认；此失败状态仅在内存中，不自动重试'
    };
    rows.push(['保存', persistence[d.persistence]]);
    for (const span of d.spans)
      rows.push([span.kind + ' · ' + (span.turn ? '第 ' + span.turn + ' 轮' : '轮次未知') + ' · ' + span.spanId, span.state + (span.httpStatus ? ' · HTTP ' + span.httpStatus : '')]);
    return rows;
  }
  // Display-only freshness. An in-memory acknowledgement is scoped to the current
  // listener generation and observed SSE turn by the worker; it is never persisted.
  // No timestamp, naming readiness, or turn COUNT can stand in for this receipt.
  const FRESH_LABELS = {aligned: '已对齐本次观察并保存', earlier: '显示详情未对齐本次选择', pending: '等待本轮采集或保存', historical: '历史快照，未重新验证', unknown: '新鲜度无法确认'};
  const FRESH_NOTES = {
    aligned: '仅确认本次已观察的选择范围，不代表服务端全部数据最新或完整。',
    historical: '本地快照不沿用此前监听中的验证状态；未重新补读。',
    scope: '缺少本次监听的同会话／同运行上下文，不能借用其他快照。',
    waiting: '已观察到生成或新一轮开始；旧详情不作为本轮保存证明。',
    selection: '本次选择与展示详情不一致；保留已有详情，不自动补采。',
    diagnostic: '诊断、选择或轮标缺失／冲突，不能凭轮数或时间推断。',
    saving: '读取或保存尚未完成确认；清除等待提示也不等于已保存。',
    unconfirmed: '未取得本次观察范围的详情保存确认；历史 saved-detail 不能代替。',
    failed: '本次读取或保存未成功确认；停止点另见采集过程，不新增重试。'
  };
  const turn = n => Number.isSafeInteger(n) && n > 0 && n <= 9999;
  const turnList = spans => [...new Set((spans || []).map(s => s?.turn).filter(turn))].sort((a, b) => a - b);
  // Identity is order-insensitive but not ID-only: kind/turn/partial and bucket count
  // participate, matching detailSnapshotKey's evidence without changing its policy.
  function selectionIdentity(count, spans) {
    if (!number(count) || !Array.isArray(spans) || !spans.length || spans.length > 24) return null;
    const ids = new Set(),
      rows = [];
    for (const s of spans) {
      if (
        !s ||
        typeof s.spanId !== 'string' ||
        !/^[a-f0-9]{16,32}$/.test(s.spanId) ||
        ids.has(s.spanId) ||
        !['stream', 'usage', 'cost'].includes(s.kind) ||
        !(s.turn === null || turn(s.turn)) ||
        typeof s.partial !== 'boolean'
      )
        return null;
      ids.add(s.spanId);
      rows.push([s.spanId, s.kind, s.turn, s.partial]);
    }
    return JSON.stringify([count, rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]);
  }
  function observedIdentity(key) {
    if (typeof key !== 'string' || key.length > 8192) return null;
    try {
      const a = JSON.parse(key);
      if (!Array.isArray(a) || a.length !== 2 || !Array.isArray(a[1]) || a[1].length > 24) return null;
      if (a[1].some(r => !Array.isArray(r) || r.length !== 4)) return null;
      return selectionIdentity(
        a[0],
        a[1].map(([spanId, kind, turn, partial]) => ({spanId, kind, turn, partial}))
      );
    } catch {
      return null;
    }
  }
  function sanitizeFreshness(input) {
    if (input?.schemaVersion !== 1 || !Object.hasOwn(FRESH_LABELS, input.status) || !Object.hasOwn(FRESH_NOTES, input.reason)) return null;
    const turns = k => (Array.isArray(input[k]) ? [...new Set(input[k].slice(0, 24).filter(turn))].sort((a, b) => a - b) : []);
    const count = k => (Number.isInteger(input[k]) && input[k] >= 0 && input[k] <= 24 ? input[k] : null);
    return {
      schemaVersion: 1,
      status: input.status,
      reason: input.reason,
      label: FRESH_LABELS[input.status],
      note: FRESH_NOTES[input.reason],
      selectedTurns: turns('selectedTurns'),
      shownTurns: turns('shownTurns'),
      unknownTurns: input.unknownTurns === true,
      selectedSpans: count('selectedSpans'),
      shownSpans: count('shownSpans'),
      persistence: PERSISTENCE.has(input.persistence) ? input.persistence : 'memory-only',
      limited: input.limited === true,
      partial: input.partial === true,
      stopped: input.stopped === true,
      observedAt: date(input.observedAt),
      detailAt: date(input.detailAt)
    };
  }
  function freshnessView({historical = false, enabled = false, sessionId, runId, context, collection, detail, generating = false, detailPending = false} = {}) {
    const d = sanitizeCollection(collection),
      shown = Array.isArray(detail?.spans) && detail.spans.length <= 24 ? detail.spans : [],
      selected = d?.spans || [];
    const base = {
      schemaVersion: 1,
      selectedTurns: turnList(selected),
      shownTurns: turnList(shown),
      unknownTurns: [...selected, ...shown].some(s => !turn(s?.turn)),
      selectedSpans: d?.selection?.selected ?? null,
      shownSpans: shown.length,
      persistence: d?.persistence,
      limited: detail?.limited === true || !!(d?.selection?.excludedTurnLimit || d?.selection?.excludedSpanLimit),
      partial: [...selected, ...shown].some(s => s?.partial !== false),
      stopped: !!detail?.stopped || !!d?.failure || d?.persistence === 'failed',
      observedAt: d?.observedAt,
      detailAt: detail?.checkedAt
    };
    const out = (status, reason) => sanitizeFreshness({...base, status, reason});
    if (historical || (!enabled && !!runId)) return out('historical', 'historical');
    if (
      !enabled ||
      typeof sessionId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) ||
      typeof runId !== 'string' ||
      !/^run_[a-zA-Z0-9]+$/.test(runId) ||
      context?.schemaVersion !== 1 ||
      context.sessionId !== sessionId ||
      context.runId !== runId
    )
      return out('unknown', 'scope');
    if (generating || context.waitingForTurn === true) return out(shown.length ? 'earlier' : 'pending', 'waiting');
    const observed = observedIdentity(context.selectionKey),
      diagnostic = selectionIdentity(d?.selection?.turns, selected),
      displayed = selectionIdentity(detail?.turnCount, shown);
    if (!d || !observed || observed !== diagnostic || base.unknownTurns) return out(detailPending && !d ? 'pending' : 'unknown', 'diagnostic');
    if (shown.length && !displayed) return out('unknown', 'diagnostic');
    if (displayed && observed !== displayed) return out('earlier', 'selection');
    if (d.persistence === 'failed' || d.failure || ['failed', 'stopped'].includes(d.phase)) return out('unknown', 'failed');
    if (detailPending || d.persistence === 'pending' || ['reading', 'planned'].includes(d.phase)) return out('pending', 'saving');
    if (
      displayed &&
      observedIdentity(context.savedKey) === observed &&
      d.phase === 'validated' &&
      d.persistence === 'saved-detail' &&
      d.savedSpans === shown.length &&
      d.counts.validated === selected.length
    )
      return out('aligned', 'aligned');
    return out('unknown', 'unconfirmed');
  }
  function freshnessRows(value) {
    const f = sanitizeFreshness(value);
    if (!f) return [];
    const list = a => (a.length ? a.join('、') : '未确认');
    const rows = [
      ['详情新鲜度', f.label],
      ['判断范围', f.note],
      ['本次选择轮标', list(f.selectedTurns)],
      ['展示详情轮标', list(f.shownTurns)],
      ['轮标说明', '来自已选 span 的轮标，不把候选轮数当作最新轮号' + (f.unknownTurns ? '；存在未知轮标' : '')],
      ['选择／展示 span', (f.selectedSpans ?? '未知') + ' / ' + (f.shownSpans ?? '未知')]
    ];
    if (f.limited || f.partial || f.stopped)
      rows.push(['覆盖限制', [f.limited ? '存在预算／覆盖限制' : '', f.partial ? '存在部分结果' : '', f.stopped ? '存在停止或保存失败记录' : ''].filter(Boolean).join('；')]);
    return rows;
  }
  globalThis.ArenaCollection = {sanitizeCollection, withPersistence, collectionRows, freshnessView, sanitizeFreshness, freshnessRows};
})();

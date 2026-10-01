/* Isolated-world task recorder. Awaited milestones fail closed before sending/renaming; passive observations never block rendering. */
(() => {
  const VERSION = '3.0.0',
    PROTOCOL = 1,
    documentKey = crypto.randomUUID();
  let context = null,
    lastState = null,
    queue = Promise.resolve(),
    fault = null,
    sequence = 0;
  const seen = new Set();
  const session = () => location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const send = m => chrome.runtime.sendMessage({...m, pageUrl: location.href});
  async function titleHash(title) {
    if (typeof title !== 'string' || !title) return null;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(title));
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function emit(type, fields = {}, round = context?.round || 0) {
    if (!context?.active) return Promise.resolve();
    const taskId = context.taskId,
      eventId = taskId + '-' + ++sequence;
    const work = queue.then(async () => {
      if (fault) throw fault;
      const r = await send({type: 'ATI_DRAW_TASK_EVENT', taskId, event: {type, round, fields, eventId}});
      if (!r?.ok) throw Error(r?.error || '任务记录保存失败');
    });
    queue = work.catch(e => {
      fault = e;
    });
    return work;
  }
  function once(type, fields) {
    const key = type + ':' + context.round + ':' + JSON.stringify(fields);
    if (seen.has(key)) return;
    seen.add(key);
    void emit(type, fields).catch(() => {});
  }
  function observe(state, domUpdated = false) {
    lastState = state;
    if (!context?.active || !context.sessionId || state?.sessionId !== context.sessionId || !state.runId) return;
    const view = globalThis.ArenaTraceView.build(state),
      fields = {sessionId: context.sessionId, runId: state.runId};
    const serverLabels = (view.serverModels || []).map(m => m.model),
      internalNames = globalThis.ArenaTraceView.internalNames(view.detail),
      displayTitle = view.renameTitle;
    once('run-observed', fields);
    if (serverLabels.length) once('label-observed', {...fields, serverLabels});
    if (internalNames.length) once('internal-observed', {...fields, internalNames});
    if (internalNames.length) once('mapping-evaluated', {...fields, mapping: globalThis.ArenaDrawPolicy.mapping(view), displayTitle});
    if (domUpdated && displayTitle) once('ui-dom-updated', {...fields, displayTitle, mapping: globalThis.ArenaDrawPolicy.mapping(view)});
  }
  async function begin(total) {
    if (context?.active) throw Error('任务记录尚未结束');
    fault = null;
    queue = Promise.resolve();
    seen.clear();
    sequence = 0;
    const r = await send({type: 'ATI_DRAW_TASK_CREATE', total});
    if (!r?.ok || !r.taskId) throw Object.assign(Error(r?.error || '无法创建抽卡任务记录'), {code: r?.code});
    context = {taskId: r.taskId, active: true, round: 0, sessionId: null};
    return {taskId: r.taskId, policy: r.policy};
  }
  async function preflight() {
    const r = await send({type: 'ATI_DRAW_PREFLIGHT'});
    if (!r?.ok) throw Error(r?.error || '启动自检失败');
    return r;
  }
  function probe() {
    const visible = e => !!e?.isConnected && e.getClientRects().length > 0;
    const draw = globalThis.ArenaAutoDraw?.status();
    return {
      version: VERSION,
      protocol: PROTOCOL,
      documentKey,
      taskId: context?.taskId || null,
      active: context?.active === true,
      running: draw?.running === true,
      phase: draw?.phase || null,
      generating: visible(document.querySelector('button[aria-label="Stop generating"]')),
      hasDraft: [...document.querySelectorAll('[contenteditable="true"],textarea')].some(e => visible(e) && String(e.value || e.innerText || e.textContent || '').trim().length > 0),
      busy: globalThis.ArenaConversationRename?.isBusy() === true
    };
  }
  async function startRound(index) {
    if (fault) throw fault;
    context.round = index;
    context.sessionId = null;
    await emit('round-start', {}, index);
  }
  async function confirmed(sessionId) {
    context.sessionId = sessionId;
    await emit('session-confirmed', {sessionId});
    if (lastState) observe(lastState);
  }
  async function ready(state, view) {
    observe(state);
    await emit('naming-ready', {
      sessionId: state.sessionId,
      runId: state.runId,
      serverLabels: (view.serverModels || view.models || []).map(m => m.serverLabel || m.model),
      internalNames: globalThis.ArenaTraceView.internalNames(view.detail),
      displayTitle: view.renameTitle,
      mapping: globalThis.ArenaDrawPolicy.mapping(view)
    });
  }
  async function renameStart(title) {
    const hash = await titleHash(globalThis.ArenaConversationRename.currentTitle(context.sessionId));
    await emit('rename-start', {displayTitle: title, ...(hash ? {titleBeforeHash: hash} : {})});
  }
  async function finish(type, reason) {
    try {
      await emit(type, {reason}, 0);
    } finally {
      if (context) context.active = false;
    }
  }
  async function retryRename(msg) {
    if (globalThis.ArenaAutoDraw?.status().running || globalThis.ArenaConversationRename?.isBusy()) return {ok: false, reason: 'operation-failed'};
    if (session() !== msg.sessionId) return {ok: false, reason: 'state-changed'};
    const state = await send({type: 'ATI_STATUS'});
    lastState = state;
    const check = () => {
      if (session() !== msg.sessionId || lastState?.runId !== msg.runId) return false;
      const v = globalThis.ArenaTraceView.build(lastState);
      return v.renameReady && v.renameTitle === msg.title;
    };
    if (!check()) return {ok: false, reason: 'state-changed'};
    const previousTitle = globalThis.ArenaConversationRename.currentTitle(msg.sessionId);
    if (previousTitle !== msg.title && (!msg.titleBeforeHash || (await titleHash(previousTitle)) !== msg.titleBeforeHash)) return {ok: false, reason: 'manual-title'};
    try {
      const r = await globalThis.ArenaConversationRename.rename({sessionId: msg.sessionId, model: msg.title, expectedTitle: previousTitle, isCurrent: check});
      return {ok: r?.title === msg.title, title: r?.title};
    } catch (e) {
      return {ok: false, reason: 'operation-failed', renameState: e?.submitted === false ? 'safe-failed' : 'uncertain'};
    }
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === 'ATI_DRAW_TASK_PROBE') {
      reply(probe());
      return;
    }
    if (msg.type === 'ATI_DRAW_TASK_STOP') {
      if (context?.taskId !== msg.taskId) {
        reply({ok: false});
        return;
      }
      globalThis.ArenaAutoDraw?.stop();
      reply({ok: true});
      return;
    }
    if (msg.type === 'ATI_DRAW_RETRY_RENAME') {
      retryRename(msg).then(reply, () => reply({ok: false, reason: 'operation-failed'}));
      return true;
    }
  });
  globalThis.ArenaDrawTasks = {
    version: VERSION,
    preflight,
    begin,
    startRound,
    confirmed,
    ready,
    renameStart,
    emit,
    finish,
    observe,
    titleHash,
    flush: async () => {
      await queue;
      if (fault) throw fault;
    },
    status: () => ({taskId: context?.taskId || null, active: context?.active === true})
  };
})();

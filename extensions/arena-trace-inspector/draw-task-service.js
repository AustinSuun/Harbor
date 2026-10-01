import {createDrawTaskStore, taskSummary, diagnosticExport, EVENT_LABELS} from './draw-task-store.js';
const POLICY = globalThis.ArenaDrawPolicy;
export const TASK_MESSAGES = new Set([
  'ATI_DRAW_PREFLIGHT',
  'ATI_DRAW_MANAGER_OPEN',
  'ATI_DRAW_POLICY_GET',
  'ATI_DRAW_POLICY_SET',
  'ATI_DRAW_TASK_CREATE',
  'ATI_DRAW_TASK_EVENT',
  'ATI_DRAW_TASK_LIST',
  'ATI_DRAW_TASK_GET',
  'ATI_DRAW_TASK_EXPORT',
  'ATI_DRAW_TASK_REMOVE',
  'ATI_DRAW_TASK_OPEN',
  'ATI_DRAW_TASK_STOP_REQUEST',
  'ATI_DRAW_TASK_RETRY'
]);
export function createDrawTaskService({chrome, ready, isArena, sessionFromUrl, stateFor, recover, cleanup, viewFor, now = Date.now}) {
  const store = createDrawTaskStore(chrome.storage.local, {now}),
    retries = new Map(),
    actions = new Set(),
    health = new Map();
  const policy = async () => POLICY.sanitize((await chrome.storage.local.get(POLICY.KEY))[POLICY.KEY]);
  const manager = sender => sender.url === chrome.runtime.getURL('history.html') || sender.url === chrome.runtime.getURL('settings.html') || sender.url === chrome.runtime.getURL('tasks.html');
  const popup = sender => sender.url === chrome.runtime.getURL('popup.html');
  const snapshot = task => ({...task, pageState: health.get(task.taskId) || null, summary: taskSummary(task)});
  const deadline = (p, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error('页面未响应，请刷新后重试')), ms);
      Promise.resolve(p).then(
        x => {
          clearTimeout(t);
          resolve(x);
        },
        e => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  async function page(sender, msg) {
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !isArena(sender.url)) throw Error('消息来源无效');
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!isArena(tab.pendingUrl || tab.url) || !/^https:\/\/arena\.ai\/agent(?:\/|$)/.test(tab.pendingUrl || tab.url) || !isArena(msg.pageUrl)) throw Error('请从当前 Agent 页面操作');
    return tab.id;
  }
  async function probePage(tabId) {
    return deadline(chrome.tabs.sendMessage(tabId, {type: 'ATI_DRAW_TASK_PROBE'}, {frameId: 0}), 2000);
  }
  async function preflight(tabId, {starting = false} = {}) {
    const tab = await chrome.tabs.get(tabId),
      state = stateFor(tabId),
      extensionVersion = chrome.runtime.getManifest().version,
      checks = [];
    const add = (key, ok, message) => checks.push({key, state: ok ? 'pass' : 'fail', message});
    let probe = null;
    add('page', isArena(tab.pendingUrl || tab.url) && /^https:\/\/arena\.ai\/agent(?:\/|$)/.test(tab.pendingUrl || tab.url), '需要当前 Agent 页面');
    add('lifecycle', !tab.frozen && !tab.discarded, tab.frozen ? '页面被冻结，请手动激活后重查' : tab.discarded ? '页面已被丢弃，请手动刷新' : '页面未被冻结或丢弃');
    if (!tab.frozen && !tab.discarded)
      try {
        probe = await probePage(tabId);
      } catch {}
    add('response', !!probe, '页面脚本需可响应；无法响应时请手动激活或刷新');
    add(
      'version',
      !!probe && probe.version === extensionVersion && probe.protocol === 1 && typeof probe.documentKey === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(probe.documentKey),
      '扩展与页面脚本版本须一致，不一致请刷新 Arena 页面'
    );
    add('listening', state?.enabled === true && !state.captureHalted, '请先手动开启监听，安全停止不能自动绕过');
    add('draft', probe?.hasDraft === false, '输入框必须没有未发送草稿');
    add('generation', probe?.generating === false && !state?.generating, '当前页面不能仍在生成');
    add('operation', probe?.busy === false && !probe?.active && (!probe?.running || (starting && probe.phase === 'checking')), '已有任务或聊天操作时不能启动');
    return {ok: true, ready: checks.every(c => c.state === 'pass'), extensionVersion, scriptVersion: probe?.version || null, checks, documentKey: probe?.documentKey || null};
  }
  async function reconcile() {
    const tasks = await store.list();
    for (const task of tasks) {
      if (task.status === 'running') {
        let tab = null,
          closed = false;
        try {
          tab = await chrome.tabs.get(task.tabId);
        } catch {
          try {
            closed = !(await chrome.tabs.query({})).some(t => t.id === task.tabId);
          } catch {}
        }
        let lost = closed || (!!tab && (tab.discarded || !isArena(tab.pendingUrl || tab.url) || !/^https:\/\/arena\.ai\/agent(?:\/|$)/.test(tab.pendingUrl || tab.url)));
        let state = lost ? 'interrupted' : tab?.frozen ? 'frozen' : 'unresponsive';
        if (tab && !lost && !tab.frozen)
          try {
            const probe = await probePage(task.tabId);
            if (probe?.active === true && probe.taskId === task.taskId && (!task.documentKey || probe.documentKey === task.documentKey)) state = 'responsive';
            else if (probe && ((task.documentKey && probe.documentKey && task.documentKey !== probe.documentKey) || (probe.active === false && probe.running === false))) {
              lost = true;
              state = 'interrupted';
            }
          } catch {}
        health.set(task.taskId, state);
        if (lost) await store.append(task.taskId, null, {type: 'interrupted', fields: {reason: 'interrupted'}});
      } else health.delete(task.taskId);
      for (const row of task.rounds)
        if (row.retryState === 'pending' && now() - Date.parse(row.updatedAt) > 120000)
          await store.append(task.taskId, null, {type: 'retry-failed', round: row.index, fields: {reason: 'interrupted'}});
    }
    return store.list();
  }
  async function openRound(task, row) {
    if (!row?.sessionId) throw Error('本轮未确认会话，不会重新发送');
    const url = 'https://arena.ai/agent/' + row.sessionId;
    const tabs = await chrome.tabs.query({url: 'https://arena.ai/*'});
    let tab = tabs.find(t => sessionFromUrl(t.pendingUrl || t.url) === row.sessionId);
    if (!tab) {
      tab = await chrome.tabs.create({url, active: true});
      return {tabId: tab.id, opened: true};
    }
    await chrome.tabs.update(tab.id, {active: true});
    return {tabId: tab.id, opened: false};
  }
  async function finishRetry(entry, ok, reason, fields = {}) {
    if (retries.get(entry.tabId) !== entry) return;
    retries.delete(entry.tabId);
    clearTimeout(entry.timer);
    await store.append(entry.taskId, null, {type: ok ? 'retry-recovered' : 'retry-failed', round: entry.round, fields: {reason, ...fields}});
  }
  function observe(tabId, state) {
    const e = retries.get(tabId);
    if (!e || e.finishing) return;
    if (state.sessionId !== e.sessionId || (state.runId && state.runId !== e.runId) || state.generating || state.captureHalted) {
      e.finishing = true;
      void finishRetry(e, false, 'state-changed').catch(() => {});
      return;
    }
    if (state.taskRecovery?.requestId !== e.requestId) return;
    if (state.taskRecovery.invalidated) {
      e.finishing = true;
      void finishRetry(e, false, 'state-changed').catch(() => {});
      return;
    }
    const view = viewFor(state);
    if (state.runId === e.runId && state.saved === true && state.taskRecovery.complete === true && view.renameReady) {
      e.finishing = true;
      void finishRetry(e, true, 'retry-ready', {displayTitle: view.renameTitle, internalNames: globalThis.ArenaTraceView.internalNames(view.detail), mapping: POLICY.mapping(view)}).catch(() => {});
    } else if ((state.runId && state.runId !== e.runId) || state.captureHalted || state.namingUnavailable || ['error', 'blocked', 'expired'].includes(state.recovery?.phase)) {
      e.finishing = true;
      void finishRetry(e, false, state.runId && state.runId !== e.runId ? 'state-changed' : 'retry-failed').catch(() => {});
    }
  }
  async function handle(msg, sender) {
    if (sender.id !== chrome.runtime.id || !(await ready)) throw Error('消息来源或本地存储不可用');
    const trusted = manager(sender) || popup(sender);
    if (msg.type === 'ATI_DRAW_PREFLIGHT') {
      if (trusted) throw Error('请从 Agent 页面执行启动自检');
      return preflight(await page(sender, msg));
    }
    if (msg.type === 'ATI_DRAW_MANAGER_OPEN') {
      if (!trusted) await page(sender, msg);
      const targetPage = msg.view === 'settings' ? 'settings.html' : 'history.html';
      await chrome.tabs.create({url: chrome.runtime.getURL(targetPage), active: true});
      return {ok: true};
    }
    if (msg.type === 'ATI_DRAW_POLICY_GET') {
      if (!trusted) await page(sender, msg);
      return {ok: true, policy: await policy()};
    }
    if (msg.type === 'ATI_DRAW_POLICY_SET') {
      if (!manager(sender)) throw Error('请从任务中心设置规则');
      const clean = POLICY.validate(msg.policy);
      await chrome.storage.local.set({[POLICY.KEY]: clean});
      return {ok: true, policy: clean};
    }
    if (msg.type === 'ATI_DRAW_TASK_CREATE') {
      if (trusted) throw Error('请从 Agent 页面开始任务');
      const tabId = await page(sender, msg),
        state = stateFor(tabId);
      if (!state?.enabled || state.captureHalted) throw Error('请先手动开启当前页监听');
      const check = await preflight(tabId, {starting: true});
      if (!check.ready)
        throw Object.assign(
          Error(
            check.checks
              .filter(c => c.state !== 'pass')
              .map(c => c.message)
              .join('；')
          ),
          {code: 'preflight'}
        );
      const tasks = await reconcile();
      if (tasks.some(t => t.rounds.some(r => r.retryState === 'pending'))) throw Error('补读或命名重试尚未结束');
      const task = await store.create({tabId, total: msg.total, policy: await policy(), documentKey: check.documentKey});
      return {ok: true, taskId: task.taskId, policy: task.policy};
    }
    if (msg.type === 'ATI_DRAW_TASK_EVENT') {
      if (trusted) throw Error('任务事件只能来自执行页面');
      const tabId = await page(sender, msg);
      if (msg.event?.fields?.sessionId) {
        const tab = await chrome.tabs.get(tabId);
        if (sessionFromUrl(tab.pendingUrl || tab.url) !== msg.event.fields.sessionId) throw Error('任务事件会话已变化');
      }
      await store.append(msg.taskId, tabId, msg.event);
      return {ok: true};
    }
    if (!manager(sender)) throw Error('请从任务中心操作记录');
    if (msg.type === 'ATI_DRAW_TASK_LIST') return {ok: true, tasks: (await reconcile()).map(snapshot)};
    const task = await store.get(msg.taskId);
    if (msg.type === 'ATI_DRAW_TASK_GET') return {ok: true, task: snapshot(task), eventLabels: EVENT_LABELS};
    if (msg.type === 'ATI_DRAW_TASK_EXPORT') return {ok: true, diagnostic: diagnosticExport({...task, pageState: health.get(task.taskId)})};
    if (msg.type === 'ATI_DRAW_TASK_REMOVE') {
      if (task.rounds.some(r => r.retryState === 'pending')) throw Error('重试尚未结束');
      await store.remove(task.taskId);
      return {ok: true};
    }
    if (msg.type === 'ATI_DRAW_TASK_STOP_REQUEST') {
      if (task.status !== 'running') throw Error('任务已结束');
      const r = await deadline(chrome.tabs.sendMessage(task.tabId, {type: 'ATI_DRAW_TASK_STOP', taskId: task.taskId}, {frameId: 0}), 3000);
      if (!r?.ok) throw Error('任务页面不可用，请刷新任务列表');
      return {ok: true};
    }
    const row = task.rounds.find(r => r.index === msg.round);
    if (!row) throw Error('轮次不存在');
    if (msg.type === 'ATI_DRAW_TASK_OPEN') return {ok: true, ...(await openRound(task, row))};
    if (msg.type === 'ATI_DRAW_TASK_RETRY') {
      if (msg.action === 'cleanup') {
        if (task.status === 'running' || (await store.list()).some(t => t.status === 'running')) throw Error('请先结束运行中的任务');
        if (!row.archived || !row.sessionId || row.cleanupState !== 'failed' || !row.cleanupFingerprint || !cleanup) throw Error('没有可安全重试的本地清理记录');
        const key = task.taskId + ':' + row.index;
        if (actions.has(key) || row.retryState === 'pending') throw Error('该轮重试进行中');
        actions.add(key);
        try {
          await store.append(task.taskId, null, {type: 'retry-start', round: row.index, fields: {retryAction: 'cleanup', reason: 'retry-requested'}});
          try {
            await cleanup(row.sessionId, row.cleanupFingerprint);
          } catch (e) {
            await store.append(task.taskId, null, {type: 'retry-failed', round: row.index, fields: {reason: e?.code === 'cleanup-changed' ? 'cleanup-changed' : 'cleanup-failed'}});
            throw Error(e?.code === 'cleanup-changed' ? '本地记录已变化，未删除新数据' : '本地记录未能清理；请检查存储或目标页监听状态');
          }
          await store.append(task.taskId, null, {type: 'retry-cleanup-confirmed', round: row.index, fields: {reason: 'retry-ready'}});
          return {ok: true, message: '仅清理了原版本的本地模型记录，没有再次归档聊天。'};
        } finally {
          actions.delete(key);
        }
      }
      if (!['recover', 'rename'].includes(msg.action)) throw Error('重试操作无效');
      if (task.status === 'running' || (await store.list()).some(t => t.status === 'running')) throw Error('请先结束正在运行的抽卡任务');
      if (row.archived) throw Error('已归档的会话不执行自动重试');
      if (!row.runId) throw Error('本轮未确认运行，不自动重发消息');
      if (msg.action === 'recover' && row.identified) throw Error('内部名识别已确认，无需重试补读');
      if (msg.action === 'rename' && row.renamed) throw Error('本轮已确认命名成功，无需重试');
      if (msg.action === 'rename' && row.renameState !== 'safe-failed') throw Error('上次命名未确认安全失败，不重复提交；请在聊天页面核对');
      const key = task.taskId + ':' + row.index;
      if (actions.has(key) || row.retryState === 'pending') throw Error('该轮重试进行中');
      actions.add(key);
      try {
        const opened = await openRound(task, row);
        if (opened.opened) return {ok: true, opened: true, message: '已打开聊天；请开启该页监听，再重试补读。'};
        const tabId = opened.tabId,
          current = stateFor(tabId);
        if (!current?.enabled || current.captureHalted) throw Error('请先在目标聊天手动开启监听');
        if (current.sessionId !== row.sessionId) throw Error('会话已变化');
        if (current.runId && current.runId !== row.runId) throw Error('当前会话运行已变化，未重试旧任务');
        const probe = await deadline(chrome.tabs.sendMessage(tabId, {type: 'ATI_DRAW_TASK_PROBE'}, {frameId: 0}), 3000);
        if (probe?.running || probe?.active) throw Error('目标页面正在执行任务');
        if (msg.action === 'recover') {
          if (retries.has(tabId)) throw Error('当前页面已在补读');
          const entry = {taskId: task.taskId, round: row.index, sessionId: row.sessionId, runId: row.runId, tabId, requestId: crypto.randomUUID()};
          await store.append(task.taskId, null, {type: 'retry-start', round: row.index, fields: {retryAction: 'recover', reason: 'retry-requested'}});
          retries.set(tabId, entry);
          entry.timer = setTimeout(() => void finishRetry(entry, false, 'retry-failed').catch(() => {}), 60000);
          try {
            await recover(tabId, row.sessionId, entry.requestId);
          } catch (e) {
            await finishRetry(entry, false, 'retry-failed');
            throw e;
          }
          return {ok: true, message: '已请求补读当前会话，不会重新发送消息。'};
        }
        if (row.renamed) throw Error('本轮已确认命名成功，无需重试');
        if (row.renameState !== 'safe-failed') throw Error('上次命名未确认安全失败，不重复提交；请在聊天页面核对');
        const view = viewFor(current);
        if (current.runId !== row.runId || !view.renameReady) throw Error('当前运行尚未就绪，请先补读；不会使用历史标题命名');
        await store.append(task.taskId, null, {type: 'retry-start', round: row.index, fields: {retryAction: 'rename', reason: 'retry-requested', renameState: 'pending'}});
        let result;
        try {
          result = await deadline(
            chrome.tabs.sendMessage(tabId, {type: 'ATI_DRAW_RETRY_RENAME', sessionId: row.sessionId, runId: row.runId, title: view.renameTitle, titleBeforeHash: row.titleBeforeHash}, {frameId: 0}),
            30000
          );
        } catch {
          result = {ok: false, reason: 'retry-failed', renameState: 'uncertain'};
        }
        await store.append(task.taskId, null, {
          type: result?.ok ? 'retry-rename-confirmed' : 'retry-failed',
          round: row.index,
          fields: {
            renameState: result?.ok ? 'confirmed' : result?.renameState || 'uncertain',
            reason: result?.ok ? 'retry-ready' : result?.reason || 'retry-failed',
            ...(result?.ok ? {confirmedTitle: view.renameTitle} : {})
          }
        });
        if (!result?.ok) throw Error(POLICY.reasonText[result?.reason] || '未确认命名成功，请检查页面');
        return {ok: true, message: '页面已确认重命名，不会重新发送消息。'};
      } finally {
        actions.delete(key);
      }
    }
    throw Error('未知任务操作');
  }
  return {handle, observe, store, reconcile};
}

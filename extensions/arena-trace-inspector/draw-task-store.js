/* Durable task metadata only. Never accepts prompts, raw responses, JWTs, cookies, email, or arbitrary error text. */
import './draw-policy-global.js';
import {normalizeRound, applyResultEvent, failRound, FAILURE_STEPS} from './draw-task-result.js';
export const TASK_INDEX = 'ati.draw.tasks.index.v1',
  TASK_PREFIX = 'ati.draw.task.v1.';
const TASK_LIMITS = {tasks: 40, rounds: 100, events: 1200};
export const EVENT_LABELS = {
  created: '创建任务',
  'round-start': '开始本轮',
  'send-intent': '提交发送操作（尚未确认）',
  'session-confirmed': '新会话已确认',
  'run-observed': '当前运行已取得',
  'label-observed': '服务端标签已取得',
  'internal-observed': '内部名字段已取得',
  'mapping-evaluated': '名称映射已评估',
  'ui-dom-updated': '面板 DOM 已更新（不代表屏幕已绘制）',
  'naming-ready': '命名条件满足',
  'rule-evaluated': '筛选规则已评估',
  'rename-start': '开始重命名',
  'rename-submit-intent': '即将点击页面命名提交',
  'rename-submitted': '已点击页面命名提交（待确认）',
  'next-chat': '进入下一空白聊天（尚未发送）',
  'rename-confirmed': '页面确认命名成功',
  'archive-start': '开始归档',
  'archive-confirmed': '页面确认归档成功',
  'cleanup-confirmed': '本地模型记录清理成功',
  'cleanup-failed': '聊天已归档，本地清理未完成',
  'retry-cleanup-confirmed': '手动清理本地模型记录成功',
  'round-failed': '本轮未完成',
  'round-finished': '本轮处理结束',
  completed: '任务轮数已完成',
  stopped: '任务已停止',
  interrupted: '任务已中断',
  'retry-start': '开始手动重试',
  'retry-recovered': '手动补读成功',
  'retry-rename-confirmed': '手动命名成功',
  'retry-failed': '手动重试未完成'
};
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const sid = x => (typeof x === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(x) ? x : null);
const label = x => (typeof x === 'string' && x.length <= 200 && x.trim() && !/[\u0000-\u001f\u007f@]/.test(x) && !/(?:Bearer\s|https?:\/\/|eyJ[^ ]*\.)/i.test(x) ? x.trim() : null);
const labels = x => [...new Set((Array.isArray(x) ? x : []).map(label).filter(Boolean))].slice(0, 12);
const reasons = new Set(Object.keys(globalThis.ArenaDrawPolicy.reasonText));
const mapping = new Set(['matched', 'missing', 'anonymous', 'mismatch', 'conflict']);
function cleanFields(v = {}) {
  const f = {};
  if (FAILURE_STEPS.includes(v.failureStep)) f.failureStep = v.failureStep;
  if (['recover', 'rename', 'cleanup'].includes(v.retryAction)) f.retryAction = v.retryAction;
  if (typeof v.cleanupFingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.cleanupFingerprint)) f.cleanupFingerprint = v.cleanupFingerprint;
  if (sid(v.sessionId)) f.sessionId = v.sessionId;
  if (validId(v.runId)) f.runId = v.runId;
  for (const k of ['serverLabels', 'internalNames']) if (Array.isArray(v[k])) f[k] = labels(v[k]);
  for (const k of ['displayTitle', 'confirmedTitle']) if (label(v[k])) f[k] = label(v[k]);
  if (['pending', 'safe-failed', 'uncertain', 'confirmed'].includes(v.renameState)) f.renameState = v.renameState;
  if (Array.isArray(v.ruleMatches)) f.ruleMatches = v.ruleMatches.filter(x => typeof x === 'string' && /^(include|exclude|tier|legacy):[a-z0-9._-]{1,80}$/.test(x)).slice(0, 40);
  if (mapping.has(v.mapping)) f.mapping = v.mapping;
  if (reasons.has(v.reason)) f.reason = v.reason;
  if (['keep', 'review', 'archive'].includes(v.decision)) f.decision = v.decision;
  if (['kept', 'review', 'archived', 'failed'].includes(v.outcome)) f.outcome = v.outcome;
  if (typeof v.titleBeforeHash === 'string' && /^[a-f0-9]{64}$/.test(v.titleBeforeHash)) f.titleBeforeHash = v.titleBeforeHash;
  return f;
}
export function taskSummary(task) {
  const rows = (task?.rounds || []).map(normalizeRound);
  return {
    rounds: rows.length,
    sent: rows.filter(r => r.sent).length,
    identified: rows.filter(r => r.identified).length,
    renamed: rows.filter(r => r.renamed).length,
    archived: rows.filter(r => r.archived).length,
    review: rows.filter(r => r.outcome === 'review').length,
    failed: rows.filter(r => r.failed).length,
    historicallyFailed: rows.filter(r => r.failureCount > 0).length,
    failureAttempts: rows.reduce((n, r) => n + r.failureCount, 0),
    failureHistoryIncomplete: rows.some(r => r.failureHistoryIncomplete),
    cleanupFailed: rows.filter(r => r.cleanupState === 'failed').length,
    kept: rows.filter(r => r.outcome === 'kept').length
  };
}
export function diagnosticExport(task) {
  if (!task) return null;
  const ids = new Map(),
    runs = new Map();
  const alias = (m, value, prefix) => {
    if (!value) return null;
    if (!m.has(value)) m.set(value, prefix + '-' + (m.size + 1));
    return m.get(value);
  };
  const safe = x => {
    const {titleBeforeHash, cleanupFingerprint, eventId, sessionId, runId, ...rest} = x;
    return {...rest, ...(sessionId ? {session: alias(ids, sessionId, 'session')} : {}), ...(runId ? {run: alias(runs, runId, 'run')} : {})};
  };
  return {
    schemaVersion: 1,
    kind: 'draw-diagnostic',
    version: '2.5.1',
    notice: '仅含模型标签、阶段与时间；会话和运行 ID 已替换。不含提示正文、令牌、Cookie 或原始响应。',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: task.status,
    pageState: task.status === 'running' ? task.pageState || 'unchecked' : null,
    reason: task.reason,
    total: task.total,
    policy: task.policy,
    summary: taskSummary(task),
    truncated: !!task.truncated,
    rounds: task.rounds.map(normalizeRound).map(safe),
    events: task.events.map(e => ({...safe(e), label: EVENT_LABELS[e.type]}))
  };
}
export function createDrawTaskStore(area, {now = Date.now, id = () => crypto.randomUUID()} = {}) {
  let queue = Promise.resolve();
  const enqueue = fn => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const load = async key => (await area.get(key))[key];
  async function list() {
    const index = (await load(TASK_INDEX)) || [];
    const result = [];
    for (const key of index) {
      if (!validId(key)) continue;
      const t = await load(TASK_PREFIX + key);
      if (t?.schemaVersion === 1 && t.kind === 'draw-task') result.push({...t, rounds: t.rounds.map(normalizeRound)});
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function get(taskId) {
    if (!validId(taskId)) throw Error('任务 ID 无效');
    const t = await load(TASK_PREFIX + taskId);
    if (!t || t.kind !== 'draw-task') throw Error('任务记录不存在');
    return {...t, rounds: t.rounds.map(normalizeRound)};
  }
  async function append(taskId, owner, {type, round = 0, fields = {}, eventId} = {}) {
    const t = await get(taskId);
    if (owner !== null && t.tabId !== owner) throw Error('任务不属于当前标签页');
    if (!Object.hasOwn(EVENT_LABELS, type)) throw Error('事件类型无效');
    if (!Number.isInteger(round) || round < 0 || round > t.total) throw Error('轮次无效');
    if (t.status !== 'running' && type === 'interrupted' && (owner === null || t.status === 'interrupted')) return t;
    if (t.status !== 'running' && !type.startsWith('retry-')) throw Error('任务已结束');
    if (eventId && t.events.some(e => e.eventId === eventId)) return t;
    if (type.startsWith('retry-') && owner !== null) throw Error('重试必须经后台授权');
    const f = cleanFields(fields),
      stamp = new Date(now()).toISOString();
    let row = null;
    if (round) {
      row = t.rounds.find(r => r.index === round);
      if (!row) {
        row = {index: round, startedAt: stamp, sent: false, identified: false, renamed: false, archived: false, outcome: null, currentFailures: {}, failureCount: 0};
        t.rounds.push(row);
      }
      if (row.sessionId && f.sessionId && row.sessionId !== f.sessionId) throw Error('本轮会话发生变化');
      if (row.runId && f.runId && row.runId !== f.runId) throw Error('本轮运行发生变化');
      Object.assign(row, f, {updatedAt: stamp});
      Object.assign(row, applyResultEvent(row, type, f, stamp));
    }
    t.events.push({type, round, at: stamp, ...f, ...(typeof eventId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(eventId) ? {eventId} : {})});
    if (t.events.length > TASK_LIMITS.events) {
      t.events.splice(0, t.events.length - TASK_LIMITS.events);
      t.truncated = true;
    }
    if (['completed', 'stopped', 'interrupted'].includes(type)) {
      t.status = type;
      t.reason = f.reason || type;
      for (const r of t.rounds)
        if (!r.outcome) {
          r.outcome = 'failed';
          r.reason = f.reason || 'interrupted';
          r.finishedAt = stamp;
          failRound(r, 'record', r.reason);
        }
    }
    t.updatedAt = stamp;
    await area.set({[TASK_PREFIX + taskId]: t});
    return t;
  }
  return {
    list: () => enqueue(list),
    get: taskId => enqueue(() => get(taskId)),
    create: ({tabId, total, policy, documentKey = null}) =>
      enqueue(async () => {
        if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(total) || total < 1 || total > 100) throw Error('任务参数无效');
        const all = await list();
        if (all.some(t => t.status === 'running')) throw Error('已有任务运行中，请先停止或刷新任务状态');
        const taskId = id();
        if (!validId(taskId)) throw Error('任务 ID 无效');
        const stamp = new Date(now()).toISOString();
        const t = {
          schemaVersion: 1,
          kind: 'draw-task',
          recordVersion: 2,
          taskId,
          tabId,
          ...(validId(documentKey) ? {documentKey} : {}),
          total,
          policy: globalThis.ArenaDrawPolicy.sanitize(policy),
          status: 'running',
          createdAt: stamp,
          updatedAt: stamp,
          rounds: [],
          events: [{type: 'created', round: 0, at: stamp}],
          truncated: false
        };
        const keep = all.slice(0, TASK_LIMITS.tasks - 1);
        await area.set({[TASK_PREFIX + taskId]: t});
        await area.set({[TASK_INDEX]: [taskId, ...keep.map(t => t.taskId)]});
        const stale = all.slice(TASK_LIMITS.tasks - 1).map(t => TASK_PREFIX + t.taskId);
        if (stale.length) await area.remove(stale);
        return t;
      }),
    append: (...args) => enqueue(() => append(...args)),
    remove: taskId =>
      enqueue(async () => {
        const t = await get(taskId);
        if (t.status === 'running') throw Error('请先停止运行中的任务');
        const keys = (await load(TASK_INDEX)) || [];
        await area.set({[TASK_INDEX]: keys.filter(k => k !== taskId)});
        await area.remove(TASK_PREFIX + taskId);
        return true;
      })
  };
}

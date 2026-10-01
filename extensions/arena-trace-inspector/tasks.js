import {EVENT_LABELS} from './draw-task-store.js';
const $ = id => document.getElementById(id),
  P = globalThis.ArenaDrawPolicy,
  statusText = {running: '运行中', completed: '已完成', stopped: '已停止', interrupted: '已中断'},
  mappingText = {matched: '确认匹配', missing: '内部名缺失', anonymous: '匿名代号', mismatch: '名称未匹配', conflict: '名称冲突'},
  outcomeText = {kept: '已保留', review: '保留待确认', archived: '已归档', failed: '仍有未解决问题', incomplete: '补读完成，后续待处理'};
const taskState = t =>
  t.status === 'running' && t.pageState === 'frozen'
    ? '页面冻结 · 状态待核对'
    : t.status === 'running' && t.pageState === 'unresponsive'
      ? '页面未响应 · 状态待核对'
      : statusText[t.status] || t.status;
let selected = null,
  tasks = [],
  busy = false,
  filterStatus = 'all';
const node = (tag, text = '', cls = '') => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const date = v => (v ? new Date(v).toLocaleString('zh-CN', {hour12: false}) : '—');
function notice(message, error = false) {
  $('notice').replaceChildren(node('span', message));
  $('notice').className = error ? 'error' : '';
  const close = node('button', '关闭');
  close.onclick = () => $('notice').replaceChildren();
  $('notice').append(close);
}
async function rpc(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({type, ...extra});
  if (!r?.ok) throw Error(r?.error || '任务操作失败');
  return r;
}
function action(label, fn, disabled = false, cls = '') {
  const b = node('button', label, cls);
  b.type = 'button';
  b.disabled = disabled;
  b.onclick = async () => {
    if (busy) return;
    busy = true;
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      notice(e.message, true);
    } finally {
      busy = false;
      await refresh().catch(e => notice(e.message, true));
    }
  };
  return b;
}
const rowData = r => ({taskId: selected, round: r.index});
function renderFilters() {
  const bar = $('task-filters');
  if (!bar) return;
  bar.replaceChildren();
  const defs = [
    ['all', '全部', tasks.length],
    ['running', '运行中', tasks.filter(t => t.status === 'running').length],
    ['completed', '已完成', tasks.filter(t => t.status === 'completed').length],
    ['stopped', '已停止', tasks.filter(t => t.status === 'stopped').length],
    ['interrupted', '已中断', tasks.filter(t => t.status === 'interrupted').length]
  ];
  for (const [key, label, count] of defs) {
    if (key !== 'all' && count === 0 && filterStatus !== key) continue;
    const btn = node('button', `${label} ${count}`, 'filter-pill' + (filterStatus === key ? ' active' : ''));
    btn.type = 'button';
    btn.onclick = () => {
      filterStatus = key;
      renderList();
    };
    bar.append(btn);
  }
}
function renderList() {
  const root = $('tasks');
  root.replaceChildren();
  renderFilters();
  const visible = filterStatus === 'all' ? tasks : tasks.filter(t => t.status === filterStatus);
  $('count').textContent = filterStatus === 'all' ? `已存 ${tasks.length} 条 · 上限 40` : `显示 ${visible.length}/${tasks.length} 条 · 上限 40`;
  if (!tasks.length) {
    root.append(node('p', '暂无任务。请从 Arena 页面 HUD 启动。', 'muted'));
    return;
  }
  if (!visible.length) {
    root.append(node('p', '当前筛选条件下无匹配任务。', 'muted'));
    return;
  }
  for (let i = 0; i < visible.length; i++) {
    const t = visible[i];
    const idx = tasks.indexOf(t) + 1;
    const b = node('button', '', 'task-item' + (t.taskId === selected ? ' selected' : ''));
    const top = node('div', '', 'task-item-top');
    top.append(node('strong', date(t.createdAt)), node('span', '#' + idx, 'task-idx'));
    b.append(top, node('span', taskState(t), 'state'), node('small', `${t.summary.rounds}/${t.total} 轮 · 保留 ${t.summary.kept} · 待确认 ${t.summary.review}`));
    b.onclick = () => {
      selected = t.taskId;
      renderList();
      renderDetail(t);
    };
    root.append(b);
  }
}
function renderDetail(task) {
  const root = $('detail');
  if (!task) {
    if (!tasks.length) root.replaceChildren(node('h2', '暂无抽卡记录'), node('p', '任务不会自动启动。请在 Arena 页面手动开启监听，再从 HUD 开始。', 'muted'));
    return;
  }
  const traceOpen = root.querySelector('.trace')?.open === true,
    frozenOpen = root.querySelector('.frozen')?.open === true;
  root.replaceChildren();
  const head = node('div', '', 'detail-head'),
    title = node('div');
  title.append(node('h2', date(task.createdAt)), node('span', taskState(task) + ' · ' + (P.reasonText[task.reason] || '记录中'), 'badge'));
  const toolbar = node('div', '', 'toolbar');
  toolbar.append(
    action('导出脱敏诊断', async () => {
      const r = await rpc('ATI_DRAW_TASK_EXPORT', {taskId: task.taskId}),
        blob = new Blob([JSON.stringify(r.diagnostic, null, 2)], {type: 'application/json'}),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'draw-diagnostic-' + task.createdAt.slice(0, 19).replace(/:/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
    action('停止任务', () => rpc('ATI_DRAW_TASK_STOP_REQUEST', {taskId: task.taskId}), task.status !== 'running'),
    action(
      '删除记录',
      async () => {
        if (!confirm('只删除本地任务记录，不会删除或归档聊天。继续？')) return;
        await rpc('ATI_DRAW_TASK_REMOVE', {taskId: task.taskId});
        selected = null;
      },
      task.status === 'running',
      'danger'
    )
  );
  head.append(title, toolbar);
  root.append(head);
  const metrics = node('div', '', 'metrics');
  for (const [key, label] of [
    ['sent', '确认会话'],
    ['identified', '内部名确认'],
    ['renamed', '命名确认'],
    ['archived', '归档确认'],
    ['review', '待确认'],
    ['failed', '仍未解决']
  ]) {
    const box = node('div', '', 'metric');
    box.append(node('strong', String(task.summary[key])), node('span', label));
    metrics.append(box);
  }
  root.append(
    metrics,
    node(
      'p',
      `历史失败：${task.summary.historicallyFailed || 0} 轮 · ${task.summary.failureHistoryIncomplete ? '至少 ' : ''}${task.summary.failureAttempts || 0} 次尝试。当前未解决问题单独计数；命名成功不等于身份已确认。`,
      'note'
    )
  );
  if (task.pageState === 'frozen' || task.pageState === 'unresponsive')
    root.append(node('p', '请手动激活任务页面后刷新状态；必要时手动刷新任务页会中断任务。这里不会自动唤醒、刷新或重发消息。', 'warn'));
  const frozen = node('details', '', 'frozen');
  frozen.open = frozenOpen;
  frozen.append(node('summary', '查看本任务的冻结配置'), node('pre', JSON.stringify({轮数上限: task.total, 高级规则: task.policy.rules, 停止条件: task.policy.stop}, null, 2)));
  root.append(frozen, node('h3', '逐轮结果'));
  const scroll = node('div', '', 'table-scroll'),
    table = node('table'),
    thead = node('thead'),
    tr = node('tr');
  for (const label of ['轮次', '服务端 / Arena 内部名', '识别 · 命名 · 归档', '处理结果 / 规则', '操作']) tr.append(node('th', label));
  thead.append(tr);
  table.append(thead);
  const body = node('tbody');
  for (const r of task.rounds) {
    const row = node('tr'),
      models = node('td', '', 'model');
    models.append(node('div', (r.serverLabels || []).join(' / ') || '服务端标签未取得'), node('small', '内部：' + ((r.internalNames || []).join(' / ') || '未取得')));
    if (r.confirmedTitle) models.append(node('small', '确认标题：' + r.confirmedTitle));
    const steps = node('td');
    steps.append(
      node('div', mappingText[r.mapping] || '识别未就绪', r.identified ? 'yes' : 'warn'),
      node('div', r.renamed ? '命名 ✓' : r.renameState === 'uncertain' || r.renameState === 'pending' ? '命名结果未确认' : '命名 —', r.renamed ? 'yes' : 'no'),
      node('div', r.archived ? '归档 ✓' : '归档 —', r.archived ? 'yes' : 'no')
    );
    if (r.archived)
      steps.append(node('div', r.cleanupState === 'confirmed' ? '本地清理 ✓' : r.cleanupState === 'failed' ? '本地清理失败' : '本地清理未确认', r.cleanupState === 'confirmed' ? 'yes' : 'warn'));
    const result = node('td');
    result.append(node('div', outcomeText[r.outcome] || '处理中', r.outcome === 'review' ? 'warn' : ''), node('small', P.reasonText[r.reason] || ''));
    if (r.failureCount) result.append(node('small', '历史失败 ' + (r.failureHistoryIncomplete ? '≥' : '') + r.failureCount + ' 次'));
    if (r.ruleReason && r.ruleReason !== r.reason) result.append(node('small', P.reasonText[r.ruleReason] || r.ruleReason));
    if (r.ruleMatches?.length) result.append(node('small', r.ruleMatches.join(' / ')));
    if (r.retryState) result.append(node('small', '重试：' + ({pending: '处理中', complete: '已完成', failed: '仍有未解决问题', incomplete: '补读完成，后续待处理'}[r.retryState] || r.retryState)));
    const controls = node('td', '', 'actions'),
      locked = task.status === 'running' || r.archived || r.retryState === 'pending';
    controls.append(
      action(
        '打开聊天',
        async () => {
          await rpc('ATI_DRAW_TASK_OPEN', rowData(r));
        },
        !r.sessionId
      ),
      action(
        '重试补读',
        async () => {
          const res = await rpc('ATI_DRAW_TASK_RETRY', {...rowData(r), action: 'recover'});
          notice(res.message || '已请求补读');
        },
        locked || !r.runId || r.identified
      ),
      action(
        '重试命名',
        async () => {
          const res = await rpc('ATI_DRAW_TASK_RETRY', {...rowData(r), action: 'rename'});
          notice(res.message || '已确认重命名');
        },
        locked || !r.runId || r.renamed || r.renameState !== 'safe-failed'
      )
    );
    if (r.archived && r.cleanupState === 'failed')
      controls.append(
        action(
          '仅重试本地清理',
          async () => {
            if (!confirm('只清理归档前版本的本地模型记录，不会再次归档聊天，也不删除对话正文或 raw。继续？')) return;
            const res = await rpc('ATI_DRAW_TASK_RETRY', {...rowData(r), action: 'cleanup'});
            notice(res.message);
          },
          task.status === 'running' || r.retryState === 'pending' || !r.cleanupFingerprint
        )
      );
    if (!r.renamed && r.renameState !== 'safe-failed' && !r.archived) controls.append(node('small', '只重试确认未提交的命名失败；其余请打开聊天核对。'));
    row.append(node('td', String(r.index)), models, steps, result, controls);
    body.append(row);
  }
  if (!task.rounds.length) {
    const r = node('tr'),
      c = node('td', '尚未开始任何轮次');
    c.colSpan = 5;
    r.append(c);
    body.append(r);
  }
  table.append(body);
  scroll.append(table);
  root.append(scroll, node('p', '✓ 表示对应步骤已确认，不表示整轮全部成功。补读／命名重试不会重新发送抽卡提示；未确认的提交不会自动再次提交。', 'note'));
  const trace = node('details', '', 'trace');
  trace.open = traceOpen;
  trace.append(node('summary', `诊断时间线 · ${task.events.length} 条${task.truncated ? ' · 较早事件已截断' : ''}`));
  const list = node('ol');
  for (const e of task.events) {
    const line = node('li'),
      detail = node('div');
    detail.append(node('div', EVENT_LABELS[e.type] || e.type));
    if (e.reason) detail.append(node('div', P.reasonText[e.reason] || e.reason, 'reason'));
    if (e.displayTitle) detail.append(node('div', e.displayTitle, 'reason'));
    line.append(node('time', date(e.at)), node('span', e.round ? '第 ' + e.round + ' 轮' : '任务'), detail);
    list.append(line);
  }
  trace.append(list, node('p', '时间为插件收到并持久化事件的时间。DOM 更新不等于屏幕绘制；本报告不声称验证了像素呈现。', 'note'));
  root.append(trace, node('p', '本地保留最多 40 个任务，每任务最多 1,200 条阶段事件。诊断导出不包含提示正文、完整响应、Token、Cookie、标题／清理指纹或真实会话／运行 ID。', 'note'));
}
async function refresh() {
  const res = await rpc('ATI_DRAW_TASK_LIST');
  tasks = res.tasks;
  if (!tasks.some(t => t.taskId === selected)) selected = tasks[0]?.taskId || null;
  renderList();
  renderDetail(tasks.find(t => t.taskId === selected));
}
$('refresh').onclick = () => refresh().catch(e => notice(e.message, true));
async function init() {
  try {
    await refresh();
  } catch (e) {
    notice(e.message, true);
  }
}
void init();
setInterval(() => {
  if (!busy && tasks.some(t => t.status === 'running' || t.rounds.some(r => r.retryState === 'pending'))) void refresh().catch(e => notice(e.message, true));
}, 4000);

let storageRefreshTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some(k => k === 'ati.draw.tasks.index.v1' || k.startsWith('ati.draw.task.v1.'))) return;
  clearTimeout(storageRefreshTimer);
  storageRefreshTimer = setTimeout(() => {
    if (!busy) void refresh().catch(e => notice(e.message, true));
  }, 350);
});

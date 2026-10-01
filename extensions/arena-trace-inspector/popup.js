import {formatUsage, summarizeUsage} from './usage.js';
import {summarizeMetadataWorkspace, formatMetadataWorkspace} from './metadata-workbench.js';
const $ = id => document.getElementById(id);
const status = $('status'),
  button = $('toggle');
const panel = ArenaTracePanel.create($('result-panel'), {onRecover: recoverCurrent});
let recoveryPending = false;
async function recoverCurrent(view) {
  if (recoveryPending) return;
  recoveryPending = true;
  renderPanel();
  try {
    const r = await chrome.runtime.sendMessage({type: 'ATI_SESSION_RECOVER', tabId, sessionId: view.sessionId});
    if (!r?.ok) throw Error(r?.error || '无法补读');
  } catch (e) {
    status.textContent = e.message;
  } finally {
    recoveryPending = false;
    renderPanel();
  }
}
let tabId,
  currentUrl = '',
  records = [],
  visibleCount = 20,
  selectedUrl = '',
  selectedRunId = '';
let state = {enabled: false, status: '检查当前标签页…', models: []};
let pulseInfo = null,
  pulseLoading = false,
  pulseError = '',
  rateLimits = null;
const mergeRl = (a, b) => globalThis.ArenaBilling?.mergeRateLimits?.(a, b) || b || a || null;
function paintPulse() {
  const f = globalThis.ArenaBilling?.formatPulse(pulseInfo) || {pct: null, tone: 'none', rows: []};
  panel.setPulse({...f, ...(rateLimits ? {rateLimits} : {}), loading: pulseLoading, error: pulseError, onRefresh: () => void loadPulse(true)});
}
async function loadPulse(force = false) {
  if (pulseLoading) return;
  pulseLoading = true;
  paintPulse();
  try {
    const r = await chrome.runtime.sendMessage({type: 'ATI_PULSE', force});
    if (r?.pulse) pulseInfo = r.pulse;
    if (r?.accountQuota && !state.accountQuota) state = {...state, accountQuota: r.accountQuota};
    if (r?.rateLimits) {
      rateLimits = mergeRl(rateLimits, r.rateLimits);
      state = {...state, rateLimits};
    }
    pulseError = r?.error || '';
  } catch (e) {
    pulseError = e?.message || '每日额度读取失败';
  } finally {
    pulseLoading = false;
    paintPulse();
    renderPanel();
  }
}
const deletingSessions = new Set();
const list = $('history-list'),
  search = $('search'),
  historyStatus = $('history-status'),
  more = $('more'),
  exportButton = $('export');
// 2.4.0 export controls; absent in older popup markup, so every use is guarded.
const toolMarksToggle = $('export-reasoning'),
  autoToggle = $('transcript-auto'),
  rawToggle = $('raw-auto');
const exportRawButton = $('export-raw'),
  storageNote = $('storage-note');
function renderMetadataWorkbench() {
  const text = formatMetadataWorkspace(summarizeMetadataWorkspace(records));
  $('metadata-summary').textContent = text.summary;
}
function renderPanel() {
  if (selectedUrl && !records.some(r => r.url === selectedUrl)) {
    selectedUrl = '';
    selectedRunId = '';
  }
  const record = records.find(r => r.url === (selectedUrl || currentUrl)) || null;
  const effectiveState = selectedUrl ? {} : state;
  const runs = ArenaTraceView.runsFor(record);
  if (selectedRunId && !runs.some(r => r.runId === selectedRunId)) selectedRunId = '';
  const select = $('run-select');
  select.replaceChildren();
  const base = document.createElement('option');
  base.value = '';
  base.textContent = effectiveState.runId && !effectiveState.historical ? '本次捕获' : '最近保存的运行';
  select.append(base);
  for (const r of runs) {
    const o = document.createElement('option');
    o.value = r.runId;
    o.textContent = r.runId + (r.checkedAt ? ' · ' + new Date(r.checkedAt).toLocaleString() : '');
    select.append(o);
  }
  select.value = selectedRunId;
  $('run-select-label').hidden = !runs.length;
  $('view-context').hidden = !selectedUrl;
  $('view-title').textContent = record?.title || '已保存会话';
  rateLimits = mergeRl(rateLimits, state.rateLimits);
  panel.render({
    ...ArenaTraceView.build(effectiveState, record, selectedRunId),
    ...(state.accountQuota ? {accountQuota: state.accountQuota} : {}),
    ...(rateLimits ? {rateLimits} : {}),
    recoveryPending
  });
}
function render(s) {
  if (!s || s.restoring) return;
  if (s.runId !== state.runId) selectedRunId = '';
  state = s;
  status.textContent = s.status || '未开启';
  button.textContent = s.listenState === 'reconnecting' ? '恢复监听中…' : s.enabled ? '停止监听' : '开启当前页监听';
  $('listen-label').textContent = s.enabled ? '当前标签页监听中' : '当前标签页未监听';
  $('listen-dot').classList.toggle('on', !!s.enabled);
  renderPanel();
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    render(await chrome.runtime.sendMessage({type: 'ATI_TOGGLE', tabId}));
  } catch {
    status.textContent = '操作失败，请重新打开扩展';
  } finally {
    button.disabled = false;
  }
});
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'ATI_STATE' && msg.tabId === tabId) render(msg.state);
});
$('run-select').addEventListener('change', e => {
  selectedRunId = e.target.value;
  renderPanel();
});
$('back-current').addEventListener('click', () => {
  selectedUrl = '';
  selectedRunId = '';
  highlightSelected();
  renderPanel();
});
async function deleteRecord(record) {
  if (deletingSessions.has(record.sessionId)) return;
  if (!window.confirm(`删除“${record.title}”的本地记录？\n该会话保存的运行、模型标签和累计用量将被移除，无法撤销。\n不会删除 Arena 网站上的对话。继续监听后，新捕获的结果可能重新生成记录。`)) return;
  deletingSessions.add(record.sessionId);
  renderHistory();
  try {
    const result = await chrome.runtime.sendMessage({type: 'ATI_HISTORY_DELETE', sessionId: record.sessionId});
    if (!result?.ok) throw Error(result?.error || '删除本地记录失败，请重试');
    if (selectedUrl === record.url) {
      selectedUrl = '';
      selectedRunId = '';
    }
    await loadHistory();
  } catch {
    historyStatus.textContent = '删除本地记录失败，请重试；未确认删除成功。';
  } finally {
    deletingSessions.delete(record.sessionId);
    const deleteButton = [...list.querySelectorAll('[data-delete-session]')].find(b => b.dataset.deleteSession === record.sessionId);
    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.textContent = '删除记录';
    }
  }
}
// 选中态只改 class，避免重建整个列表把滚动位置也一起丢掉。
function highlightSelected() {
  const viewing = selectedUrl || currentUrl;
  for (const card of list.children) card.classList.toggle('selected', card.dataset.url === viewing);
}
function renderHistory() {
  const query = search.value.trim().toLowerCase();
  const filtered = records.filter(r => [r.title, r.url, ...r.observations.map(o => o.model + ' ' + o.provider)].join(' ').toLowerCase().includes(query));
  list.replaceChildren();
  $('count').textContent = records.length;
  renderMetadataWorkbench();
  $('all-usage').textContent = '本机已保存累计（仅已捕获）：' + formatUsage(summarizeUsage(records.flatMap(r => r.runs || [])));
  historyStatus.textContent = records.length ? `匹配 ${filtered.length} 个本机元数据会话 · 不会补全未监听调用` : '暂无本机元数据。开启监听并识别模型后会保存元数据快照。';
  exportButton.disabled = !records.length;
  for (const record of filtered.slice(0, visibleCount)) {
    const card = document.createElement('article');
    card.className = 'record';
    card.dataset.url = record.url;
    // current = 浏览器当前打开的会话；selected = 此刻正在查看的会话。两者可以不是同一个。
    if (record.url === (selectedUrl || currentUrl)) card.classList.add('selected');
    if (record.switch?.state === 'switched' || (record.runs || []).some(r => r.switch?.state === 'switched')) card.classList.add('switched');
    if (record.url === currentUrl) {
      card.classList.add('current');
      const label = document.createElement('div');
      label.className = 'current-label';
      label.textContent = '当前会话 · 本地记录';
      card.append(label);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const actions = document.createElement('div');
    actions.className = 'record-actions';
    const remove = document.createElement('button');
    remove.className = 'small danger';
    remove.type = 'button';
    remove.dataset.deleteSession = record.sessionId;
    remove.disabled = deletingSessions.has(record.sessionId);
    remove.textContent = remove.disabled ? '删除中…' : '删除记录';
    remove.setAttribute('aria-label', '删除本地记录：' + record.title);
    remove.addEventListener('click', () => void deleteRecord(record));
    const exportOne = document.createElement('button');
    exportOne.className = 'small';
    exportOne.type = 'button';
    exportOne.textContent = '导出为 md';
    exportOne.setAttribute('aria-label', '把此会话导出为 Markdown：' + record.title);
    exportOne.addEventListener('click', () => void runExport(exportOne, 'chat', record.sessionId));
    actions.append(exportOne, remove);
    const model = document.createElement('div');
    model.className = 'model';
    const switched = record.switch?.state === 'switched' || (record.runs || []).some(r => r.switch?.state === 'switched');
    model.textContent = (switched ? '⚠ 已切换 · ' : '') + [...new Set(record.observations.map(o => o.model + (o.provider ? ' · ' + o.provider : '')))].join(' / ');
    const time = document.createElement('small');
    time.textContent = '最近记录：' + new Date(record.lastSeen).toLocaleString();
    const usage = document.createElement('small');
    usage.textContent = '本机已保存累计（仅已捕获）：' + formatUsage(summarizeUsage(record.runs || []));
    // 标题行删除后由 URL 承担跳转职能
    const url = document.createElement('a');
    url.className = 'url';
    url.href = record.url;
    url.target = '_blank';
    url.rel = 'noopener noreferrer';
    url.textContent = record.url;
    row.append(model, actions);
    card.append(row, usage, time, url);
    // 整张卡片即切换入口：目标比一个小按钮大得多，且不再强制把页面滚到顶部。
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', '查看此会话的运行：' + record.title);
    const pick = event => {
      if (event.target.closest('button, a')) return;
      selectedUrl = record.url;
      selectedRunId = '';
      highlightSelected();
      renderPanel();
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      pick(event);
    });
    list.append(card);
  }
  more.hidden = filtered.length <= visibleCount;
}
async function loadHistory() {
  try {
    const result = await chrome.runtime.sendMessage({type: 'ATI_HISTORY_LIST'});
    if (result.error) throw Error(result.error);
    records = result.records || [];
    renderHistory();
    renderPanel();
  } catch {
    historyStatus.textContent = '读取记录失败，请重新加载扩展后重试';
  }
}
search.addEventListener('input', () => {
  visibleCount = 20;
  renderHistory();
});
more.addEventListener('click', () => {
  visibleCount += 20;
  renderHistory();
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void loadHistory();
});
/* 2.4.0: three separate exports, never merged into one file.
   The service worker builds each bundle (refreshes titles, groups by account).
   Metadata falls back to the local list so it never dead-ends; chat and raw do not
   fake a fallback, because the popup has no copy of that data. */
// 会话记录 → Markdown。正文自 2.8.1 起保存时就已还原成 Markdown，这里只做分节与页眉，不重复转换。
function chatToMarkdown(record) {
  const head = ['# ' + (record.title || 'Arena 会话'), '', '> 由 Arena Trace Inspector 导出 · ' + new Date().toLocaleString(), '> 来源：' + (record.url || '未知'), ''];
  const out = [];
  let lastRole = null;
  for (const m of record.messages || []) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    if (m.role !== lastRole) {
      if (lastRole !== null) out.push('', '---', '');
      out.push('## ' + role, '');
      lastRole = m.role;
    }
    if (m.text) out.push(m.text);
    if (m.reasoning) out.push('', '<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>');
  }
  if (!out.length) out.push('（这条会话没有保存正文。点 HUD 的「保存本会话」后再导出。）');
  return head.concat(out).join('\n') + '\n';
}
function download(payload, stem, ext = 'json') {
  const isText = typeof payload === 'string';
  const blob = new Blob([isText ? payload : JSON.stringify(payload, null, 2)], {type: isText ? 'text/markdown;charset=utf-8' : 'application/json'});
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = stem + '-' + new Date().toISOString().slice(0, 10) + '.' + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const rawRiskLabels = {credentials: '凭据／令牌', bodyText: '对话或正文', reasoning: '思考／推理', identity: '账号或身份标识', clientMetadata: '客户端或反爬元数据'};
function rawRiskText(risk) {
  return (risk?.categories || [])
    .map(x => rawRiskLabels[x])
    .filter(Boolean)
    .join('、');
}
function confirmRawRisk(risk, action) {
  const labels = rawRiskText(risk);
  if (!labels) return true;
  const text = action + '前检测到：' + labels + '。此提示不显示字段值，但原始文件仍可能含敏感数据。仅限个人本机使用，确认继续？';
  return typeof globalThis.confirm === 'function' && globalThis.confirm(text);
}
let exportProgressTarget = null;
chrome.runtime.onMessage.addListener(m => {
  if (m?.type === 'ATI_EXPORT_PROGRESS' && exportProgressTarget) {
    exportProgressTarget.textContent = '刷新标题 ' + m.pages + ' 页…';
  }
});
async function runExport(button, kind, sessionId = null) {
  if (!button) return;
  const before = button.textContent;
  button.disabled = true;
  button.textContent = '导出中…';
  // 标题刷新要串行翻最多 25 页，实测占导出耗时的 99%；单会话导出一律跳过。
  // 标题一律用本地已存储的：联网翻页实测占导出耗时 99%，收益只是把重命名后的新标题补进文件。
  const refreshTitles = false;
  exportProgressTarget = refreshTitles ? button : null;
  try {
    // 该开关现在控制工具调用标记（思考过程在现代模型下已不再渲染，见 2.8.1 取证）。
    const includeToolMarks = !toolMarksToggle || toolMarksToggle.checked;
    const r = await chrome.runtime.sendMessage({type: 'ATI_EXPORT', kind, includeToolMarks, refreshTitles, ...(sessionId ? {sessionId} : {})});
    if (r?.error || !r?.bundle) throw Error(r?.error || '导出失败');
    if (kind === 'raw' && !confirmRawRisk(r.rawRisk, '导出原始 trace')) {
      button.disabled = false;
      button.textContent = before;
      return;
    }
    exportProgressTarget = null;
    if (sessionId && kind === 'chat') {
      const record = (r.bundle.accounts || []).flatMap(a => a.items || [])[0];
      if (!record) throw Error('这条会话还没有保存正文，先在 HUD 点「保存本会话」');
      download(chatToMarkdown(record), r.filename || 'arena-chat', 'md');
    } else {
      download(r.bundle, r.filename || 'arena-' + kind);
    }
  } catch (e) {
    if (kind === 'metadata') {
      download(
        {
          schemaVersion: 1,
          kind: 'metadata',
          exportedAt: new Date().toISOString(),
          titlesRefreshed: false,
          degraded: true,
          notice: '标题未能刷新，内容来自本地记录。含账号邮箱，请勿外发。',
          accounts: [{account: {accountId: 'unknown'}, items: records}]
        },
        'arena-metadata'
      );
    } else {
      button.textContent = e?.message?.slice(0, 20) || '导出失败';
      setTimeout(() => {
        button.textContent = before;
        button.disabled = false;
      }, 2500);
      return;
    }
  }
  button.disabled = false;
  button.textContent = before;
}
exportButton.addEventListener('click', () => void runExport(exportButton, 'metadata'));
exportRawButton?.addEventListener('click', () => void runExport(exportRawButton, 'raw'));
// Auto-capture preference (default on).
if (autoToggle) {
  chrome.runtime
    .sendMessage({type: 'ATI_TRANSCRIPT_AUTO_GET'})
    .then(r => {
      autoToggle.checked = r?.enabled !== false;
    })
    .catch(() => {});
  autoToggle.addEventListener('change', () => {
    void chrome.runtime.sendMessage({type: 'ATI_TRANSCRIPT_AUTO_SET', enabled: autoToggle.checked}).catch(() => {});
  });
}
// Storage footprint readout; unlimitedStorage is on, so the number is informational.
if (storageNote) {
  chrome.runtime
    .sendMessage({type: 'ATI_STORAGE_STATS'})
    .then(r => {
      if (!r?.stats) return;
      const mb = n => (n / 1048576).toFixed(2) + ' MB';
      storageNote.textContent = '已用：元数据 ' + mb(r.stats.metadataBytes) + ' ／ 对话 ' + mb(r.stats.chatBytes) + ' ／ 原始 ' + mb(r.stats.rawBytes);
    })
    .catch(() => {});
}
try {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  tabId = tab?.id;
  currentUrl = tab?.url?.split(/[?#]/)[0] || '';
  if (!tab?.url || new URL(tab.url).origin !== 'https://arena.ai') {
    render({...state, status: '切换到 Arena 标签页即可开启监听；也可查看下方历史记录。'});
  } else {
    render(await chrome.runtime.sendMessage({type: 'ATI_STATUS', tabId}));
    button.disabled = false;
  }
} catch {
  status.textContent = '无法读取标签页，请重新打开扩展';
  renderPanel();
}
void loadPulse(false);
await loadHistory();

document.getElementById('draw-tasks').addEventListener('click', () => chrome.runtime.sendMessage({type: 'ATI_DRAW_MANAGER_OPEN', view: 'history'}));
document.getElementById('draw-settings')?.addEventListener('click', () => chrome.runtime.sendMessage({type: 'ATI_DRAW_MANAGER_OPEN', view: 'settings'}));

// 原始 trace 保存（默认关闭，需用户显式开启）——留存的 payload 可能含令牌与正文，
// 关闭它只影响此后新捕获的运行，已存的记录不受影响。
if (rawToggle) {
  chrome.runtime
    .sendMessage({type: 'ATI_RAW_AUTO_GET'})
    .then(r => {
      rawToggle.checked = r?.enabled === true;
    })
    .catch(() => {});
  // 默认关闭是有意的安全默认值（payload 可能含令牌），但一个沉默的未勾选框说明不了这件事。
  // 从未设置过时把当前状态与后果写在旁边，点过一次之后就不再提示。
  void chrome.storage.local
    .get('ati.raw.enabled.v1')
    .then(v => {
      if (v['ati.raw.enabled.v1'] !== undefined) return;
      const hint = document.createElement('span');
      hint.className = 'raw-hint';
      hint.textContent = '未开启 · trace 不留存';
      hint.title = '开启后才会保存未经处理的 trace 原文；它可能含令牌与对话正文，开启时会再确认一次。';
      rawToggle.closest('.opt')?.after(hint);
      rawToggle.addEventListener('change', () => hint.remove(), {once: true});
    })
    .catch(() => {});
  rawToggle.addEventListener('change', () => {
    void (async () => {
      const enabled = rawToggle.checked;
      if (enabled && !confirmRawRisk({categories: ['credentials', 'bodyText', 'reasoning', 'identity', 'clientMetadata']}, '开启原始 trace 保存')) {
        rawToggle.checked = false;
        return;
      }
      try {
        const r = await chrome.runtime.sendMessage({type: 'ATI_RAW_AUTO_SET', enabled});
        rawToggle.checked = r?.enabled === true;
      } catch {
        rawToggle.checked = !enabled;
      }
    })();
  });
}

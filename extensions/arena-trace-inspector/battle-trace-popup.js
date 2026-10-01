import './battle-core.js';
import './battle-trace-core.js';
import './battle-trace-ui.js';
const section = document.createElement('details');
section.className = 'history fold';
const summary = document.createElement('summary');
summary.className = 'fold-summary';
const title = document.createElement('h2');
title.textContent = 'Battle Code · 执行 trace';
const count = document.createElement('span');
count.className = 'fold-count';
count.textContent = '0';
summary.append(title, count);
const list = document.createElement('div');
section.append(summary, list);
document.getElementById('tab-records').append(section);
async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({type: 'ATI_BATTLE_TRACE_LIST'});
    if (r?.error) throw Error();
    list.replaceChildren();
    const records = r.records || [];
    count.textContent = String(records.length);
    for (const record of records) {
      const article = document.createElement('article');
      article.className = 'record';
      const row = document.createElement('div');
      row.className = 'row';
      const link = document.createElement('a');
      link.href = record.url;
      link.textContent = 'Code trace · ' + record.sessionId;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
      article.append(row);
      const inner = document.createElement('details');
      inner.className = 'record-fold';
      const innerSum = document.createElement('summary');
      innerSum.textContent = '查看 Code trace';
      inner.append(innerSum);
      const detail = document.createElement('div');
      ArenaBattleTraceUI.render(detail, record, true);
      inner.append(detail);
      article.append(inner);
      list.append(article);
    }
    if (!records.length) list.textContent = '暂无 Code trace。请在已有 Code 工作流的 Battle 页面点击“读取 Code trace”。';
  } catch {
    list.textContent = 'Code trace 历史读取失败，请重新加载扩展';
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(k => k.startsWith('ati.battle.trace.v1.'))) void refresh();
});
void refresh();

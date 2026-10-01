import './battle-core.js';
/* Battle history is intentionally separate from Agent run/span totals. */
const section = document.createElement('details');
section.className = 'history fold';
const summary = document.createElement('summary');
summary.className = 'fold-summary';
const title = document.createElement('h2');
title.textContent = 'Battle 官方揭示记录';
const count = document.createElement('span');
count.className = 'fold-count';
count.textContent = '0';
summary.append(title, count);
const note = document.createElement('p');
note.className = 'note';
note.textContent = '官方揭示与调用数据独立保存；Token / 成本来自 Battle 消息元数据，不计入 Agent trace 累计。默认折叠，点开查看。';
const list = document.createElement('div');
section.append(summary, note, list);
document.getElementById('tab-records').append(section);
async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({type: 'ATI_BATTLE_LIST'});
    if (r?.error) throw Error(r.error);
    list.replaceChildren();
    const records = r.records || [];
    count.textContent = String(records.length);
    for (const record of records) {
      const card = document.createElement('article');
      card.className = 'record';
      const row = document.createElement('div');
      row.className = 'row';
      const a = document.createElement('a');
      a.href = record.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Battle · ' + record.sessionId;
      row.append(a);
      card.append(row);
      const names = [];
      for (const pair of record.pairs) for (const m of pair.sides) names.push(m.displayName);
      const model = document.createElement('div');
      model.className = 'model';
      model.textContent = names.filter(Boolean).join(' / ') || '未提供模型名';
      card.append(model);
      const inner = document.createElement('details');
      inner.className = 'record-fold';
      const innerSum = document.createElement('summary');
      innerSum.textContent = '查看调用数据';
      inner.append(innerSum);
      for (const pair of record.pairs) {
        for (const m of pair.sides) {
          const p = document.createElement('div');
          p.className = 'model';
          p.textContent = m.position.toUpperCase() + ' · ' + m.displayName;
          inner.append(p);
          const v = ArenaBattleCore.callDataView(m.callData, true);
          const src = document.createElement('small');
          src.textContent = v.source;
          inner.append(src);
          for (const [label, value] of v.rows) {
            const line = document.createElement('div');
            line.textContent = label + '：' + value;
            line.style.fontSize = '11px';
            inner.append(line);
          }
          if (v.warning) {
            const warning = document.createElement('small');
            warning.textContent = v.warning;
            inner.append(warning);
          }
        }
      }
      card.append(inner);
      const time = document.createElement('small');
      time.textContent = '本地历史 · ' + new Date(record.observedAt).toLocaleString();
      card.append(time);
      list.append(card);
    }
    if (!records.length) list.textContent = '暂无 Battle 记录。评分揭示后会自动读取；失败时可在 Battle 浮层重试。';
  } catch {
    list.textContent = 'Battle 记录读取失败，请重新加载扩展';
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(k => k.startsWith('ati.battle.v1.'))) void refresh();
});
void refresh();

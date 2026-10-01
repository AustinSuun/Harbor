import {formatPulse, formatRateLimits} from './billing.js';
const $ = id => document.getElementById(id),
  P = globalThis.ArenaDrawPolicy,
  SVG = 'http://www.w3.org/2000/svg',
  R = 46,
  C = 2 * Math.PI * R;
let rateLimitsState = null,
  pulseState = null,
  accountQuotaState = null,
  quotaTickTimer = null;
const node = (tag, text = '', cls = '') => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const usd = n => (typeof n === 'number' && Number.isFinite(n) ? '$' + n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—');
const shortUsd = n => (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) >= 1000 ? '$' + (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'K' : usd(n));
const shortStamp = iso =>
  iso && Number.isFinite(Date.parse(iso))
    ? (() => {
        const d = new Date(iso);
        return d.getMonth() + 1 + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      })()
    : '—';
function notice(message, error = false) {
  $('notice').replaceChildren(node('span', message));
  $('notice').className = error ? 'error' : '';
  const close = node('button', '关闭');
  close.onclick = () => $('notice').replaceChildren();
  $('notice').append(close);
}
async function rpc(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({type, ...extra});
  if (!r?.ok) throw Error(r?.error || '设置操作失败');
  return r;
}
function formatBucketItem(key, label, routeTag, emptyText, emptyTip, item) {
  if (!item) {
    return {key, label, routeTag, tone: 'none', pct: 0, valueText: emptyText, waitText: '', expired: false, tip: emptyTip};
  }
  const tone = item.tone === 'good' ? 'ok' : item.tone || 'ok';
  const valueText = item.remaining + ' / ' + item.limit;
  const waitText = item.remainSec === null || item.expired ? '' : item.remainSec >= 60 ? Math.floor(item.remainSec / 60) + 'm ' + (item.remainSec % 60) + 's 后重置' : item.remainSec + 's 后重置';
  const tip = label + '限流（同号 × 当前 IP）：剩余 ' + item.remaining + '/' + item.limit + (item.resetText ? ' · ' + item.resetText : '');
  return {
    key,
    label,
    routeTag,
    tone,
    pct: typeof item.pct === 'number' ? item.pct : 0,
    valueText,
    waitText,
    expired: !!item.expired,
    tip
  };
}
function stopQuotaTick() {
  if (quotaTickTimer !== null) {
    clearInterval(quotaTickTimer);
    quotaTickTimer = null;
  }
}
function renderQuotaSection(nowMs = Date.now()) {
  const host = $('settings-quota');
  if (!host) return false;
  const pulseView = pulseState ? formatPulse(pulseState) : {pct: null, tone: 'none', rows: []};
  const q = accountQuotaState;
  const f = formatRateLimits(rateLimitsState, nowMs);
  const items = [
    formatBucketItem('createChat', '新建会话', 'create-chat', '待触发', '新建会话限流：待首次发送消息后捕获响应头', f?.createChat),
    formatBucketItem('apiGeneral', 'API 通用', 'api/me/pulse', '待读取', 'API 通用限流：待读取 /api/me/pulse 响应头', f?.apiGeneral)
  ];
  const leftBox = node('div', '', 'settings-quota-box');
  const ring = node('div', '', 'settings-ring');
  ring.dataset.tone = pulseView.tone || 'none';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 104 104');
  for (const cls of ['track', 'bar']) {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '52');
    c.setAttribute('cy', '52');
    c.setAttribute('r', String(R));
    if (cls === 'bar') {
      c.setAttribute('stroke-dasharray', C.toFixed(2));
      c.setAttribute('stroke-dashoffset', (C * (1 - Math.min(100, Math.max(0, pulseView.pct ?? 0)) / 100)).toFixed(2));
    }
    svg.append(c);
  }
  const pctEl = node('div', '', 'settings-ring-pct');
  if (typeof pulseView.pct === 'number') {
    pctEl.append(document.createTextNode(String(pulseView.pct >= 99.95 ? 100 : Math.floor(pulseView.pct))), node('small', '%'));
  } else {
    pctEl.textContent = '—';
  }
  ring.append(svg, pctEl);
  const info = node('div', '', 'settings-quota-info');
  const headRow = node('div', '', 'settings-quota-head');
  const big = node('div', q ? usd(q.balanceRemainingUsd) : '—', 'settings-quota-big');
  big.append(node('span', ' / ' + (q ? shortUsd(q.allowanceUsd) : '—')));
  headRow.append(big);
  if (q?.allowanceTier) headRow.append(node('span', 'tier ' + q.allowanceTier, 'settings-tier-pill'));
  const dl = node('dl', '', 'settings-quota-dl');
  const remainRow = (pulseView.rows || []).find(r => r[0] === '今日剩余');
  const readRow = (pulseView.rows || []).find(r => r[0] === '读取');
  const cleanRead = readRow ? String(readRow[1] || '').replace(/\s*\(\d+ms\)$/, '') : '—';
  const usedText = q ? usd(q.chargedUserTotalUsd) + (q.overLimit === true ? ' (已超限)' : '') : '—';
  for (const [k, v] of [
    ['剩余', remainRow ? remainRow[1] : '—'],
    ['已用', usedText],
    ['读取', cleanRead],
    ['快照', q?.readAt ? shortStamp(q.readAt) : '未读取']
  ]) {
    dl.append(node('dt', k), node('dd', v));
  }
  info.append(headRow, dl);
  leftBox.append(ring, info);

  const rightBox = node('div', '', 'settings-rl-box');
  const rlHead = node('div', '', 'settings-rl-head');
  rlHead.append(node('strong', '接口限流监视（同号 × 当前 IP）'), node('span', '1h 滚动窗口', 'settings-tier-pill'));
  const rlList = node('div', '', 'settings-rl-list');
  for (const item of items) {
    const card = node('div', '', 'task-rl-card');
    card.dataset.tone = item.tone;
    card.dataset.bucket = item.key;
    if (item.tip) card.title = item.tip;
    const top = node('div', '', 'task-rl-top');
    const nameWrap = node('span', '', 'task-rl-name');
    nameWrap.append(node('span', item.label), node('code', item.routeTag, 'task-rl-tag'));
    const meta = node('span', '', 'task-rl-meta');
    const val = node('strong', item.valueText, 'task-rl-val');
    val.dataset.tone = item.tone;
    meta.append(val);
    if (item.waitText) meta.append(node('span', item.waitText, 'task-rl-timer'));
    else if (item.expired) meta.append(node('span', '可使用', 'task-rl-timer'));
    top.append(nameWrap, meta);
    const track = node('div', '', 'task-rl-track');
    const fill = node('div', '', 'task-rl-fill');
    fill.dataset.tone = item.tone;
    fill.style.width = item.pct + '%';
    track.append(fill);
    card.append(top, track);
    rlList.append(card);
  }
  rightBox.append(rlHead, rlList);
  host.replaceChildren(leftBox, rightBox);

  const hasActive = items.some(i => Boolean(i.waitText));
  if (!hasActive) {
    stopQuotaTick();
  } else if (quotaTickTimer === null) {
    quotaTickTimer = setInterval(() => {
      renderQuotaSection(Date.now());
    }, 1000);
    quotaTickTimer?.unref?.();
  }
  return hasActive;
}
async function refreshQuota(force = false) {
  const btn = $('refresh-quota');
  if (btn && force) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({type: 'ATI_PULSE', force});
    if (res?.pulse) pulseState = res.pulse;
    if (res?.accountQuota) accountQuotaState = res.accountQuota;
    if (res?.rateLimits) rateLimitsState = res.rateLimits;
  } catch {}
  if (btn && force) btn.disabled = false;
  renderQuotaSection();
}
const KNOWN_FAMILIES = [
  {family: 'gpt-6', hint: 'luna/sol/astra · low~max'},
  {family: 'gpt-5.6', hint: 'sol/luna/terra · low~max'},
  {family: 'gpt-5.5', hint: 'xhigh'},
  {family: 'gpt-5.4', hint: 'high'},
  {family: 'claude-opus-5.5', hint: 'low~max'},
  {family: 'claude-opus-5', hint: 'low~max'},
  {family: 'claude-sonnet-5.5', hint: 'high/xhigh/max'},
  {family: 'claude-sonnet-5', hint: 'vertex'},
  {family: 'claude-fable-5.1', hint: 'low'},
  {family: 'claude-fable-5', hint: 'v2'},
  {family: 'claude-opus-4-8', hint: 'thinking'},
  {family: 'gemini-3.8-flash', hint: 'low~high'},
  {family: 'gemini-3.7-flash', hint: ''},
  {family: 'grok-4.7', hint: 'xhigh'},
  {family: 'grok-4.6', hint: 'low~high'},
  {family: 'grok-4.5', hint: ''},
  {family: 'glm-5.3', hint: '含 flash'},
  {family: 'glm-5.2', hint: ''},
  {family: 'deepseek-v4.1-flash', hint: 'max'},
  {family: 'deepseek-v4-pro', hint: 'high'},
  {family: 'deepseek-flash', hint: ''},
  {family: 'qwen3.8', hint: 'max / 27b-code'},
  {family: 'kimi-k3', hint: 'v2'},
  {family: 'mimo-v2.6', hint: 'pro / flash'},
  {family: 'muse-spark-1.3', hint: 'max'},
  {family: 'muse-spark-1.2', hint: 'xhigh'},
  {family: 'minimax-m3.1', hint: 'flash-preview'},
  {family: 'mistral-medium-3.5', hint: 'v2'},
  {family: 'nemotron-3-ultra', hint: ''},
  {family: 'step-5-preview', hint: 'agent'}
];
const split = s =>
  String(s || '')
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
function parseIncludeItems(rawText) {
  const items = [];
  const byBase = new Map();
  for (const tok of split(rawText)) {
    const p = P.parseRule ? P.parseRule(tok) : null;
    const base = p ? (p.stem && p.stemTier ? p.stem : p.base) : tok.toLowerCase();
    const tiers = p ? (p.tiers.length ? [...p.tiers] : p.stemTier ? [p.stemTier] : []) : [];
    if (!byBase.has(base)) {
      const entry = {base, tiers: [...tiers]};
      byBase.set(base, entry);
      items.push(entry);
    } else {
      const entry = byBase.get(base);
      for (const t of tiers) if (!entry.tiers.includes(t)) entry.tiers.push(t);
    }
  }
  for (const item of items) item.tiers.sort((a, b) => P.TIERS.indexOf(a) - P.TIERS.indexOf(b));
  return items;
}
function writeIncludeItems(items) {
  $('include').value = items.map(it => (it.tiers.length ? `${it.base}:${it.tiers.join('/')}` : it.base)).join(', ');
  renderIncludeHelpers();
}
function renderIncludeHelpers() {
  const items = parseIncludeItems($('include').value);
  const activeBases = new Set(items.map(it => it.base));
  const box = $('include-tier-box'),
    rowsEl = $('include-tier-rows');
  if (box && rowsEl) {
    box.hidden = items.length === 0;
    rowsEl.replaceChildren(
      ...items.map(item => {
        const row = document.createElement('div');
        row.className = 'include-tier-row';
        const name = document.createElement('code');
        name.className = 'include-model-name';
        name.textContent = item.base;
        const pills = document.createElement('div');
        pills.className = 'include-tier-pills';
        const anyBtn = document.createElement('button');
        anyBtn.type = 'button';
        anyBtn.className = 'tier-chip' + (item.tiers.length === 0 ? ' active' : '');
        anyBtn.textContent = '不限档位';
        anyBtn.onclick = () => {
          item.tiers = [];
          writeIncludeItems(items);
        };
        pills.append(anyBtn);
        for (const t of P.TIERS) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tier-chip' + (item.tiers.includes(t) ? ' active' : '');
          btn.textContent = t;
          btn.onclick = () => {
            if (item.tiers.includes(t)) item.tiers = item.tiers.filter(x => x !== t);
            else item.tiers.push(t);
            item.tiers.sort((a, b) => P.TIERS.indexOf(a) - P.TIERS.indexOf(b));
            $('rules-enabled').checked = true;
            writeIncludeItems(items);
          };
          pills.append(btn);
        }
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'include-remove-btn';
        rm.textContent = '× 移除';
        rm.onclick = () => {
          writeIncludeItems(items.filter(x => x.base !== item.base));
        };
        row.append(name, pills, rm);
        return row;
      })
    );
  }
  const kfEl = $('known-families');
  if (kfEl) {
    kfEl.replaceChildren(
      ...KNOWN_FAMILIES.map(({family, hint}) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isAdded = activeBases.has(family.toLowerCase());
        btn.className = 'known-family-chip' + (isAdded ? ' active' : '');
        btn.title = isAdded ? `点击从白名单移除 ${family}` : `点击将 ${family} 加入白名单`;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = family;
        btn.append(nameSpan);
        if (hint) {
          const sub = document.createElement('small');
          sub.textContent = hint;
          btn.append(sub);
        }
        btn.onclick = () => {
          const cur = parseIncludeItems($('include').value);
          const key = family.toLowerCase();
          if (cur.some(x => x.base === key)) {
            writeIncludeItems(cur.filter(x => x.base !== key));
          } else {
            cur.push({base: key, tiers: []});
            $('rules-enabled').checked = true;
            writeIncludeItems(cur);
          }
        };
        return btn;
      })
    );
  }
}
function updateAdvancedBadge() {
  const badge = $('advanced-badge');
  if (!badge) return;
  let count = 0;
  if ([...$('tiers').querySelectorAll('input:checked')].length > 0) count++;
  if (Number($('target-hits').value) > 0) count++;
  if (Number($('unique-targets').value) > 0) count++;
  if (Number($('max-minutes').value) > 0) count++;
  if ($('min-pulse').value !== '' && $('min-pulse').value !== null) count++;
  if (Number($('failure-limit').value) !== 3) count++;
  badge.textContent = count > 0 ? `已自定义 ${count} 项` : '默认';
  badge.classList.toggle('active', count > 0);
}
for (const tier of P.TIERS) {
  const l = node('label'),
    input = document.createElement('input');
  input.type = 'checkbox';
  input.value = tier;
  l.append(input, document.createTextNode(tier));
  input.addEventListener('change', updateAdvancedBadge);
  $('tiers').append(l);
}
function fillPolicy(p) {
  $('rules-enabled').checked = p.rules.enabled;
  $('include').value = p.rules.include.join(', ');
  $('exclude').value = p.rules.exclude.join(', ');
  for (const input of $('tiers').querySelectorAll('input')) input.checked = p.rules.tiers.includes(input.value);
  for (const [id, key] of [
    ['target-hits', 'targetHits'],
    ['unique-targets', 'uniqueTargets'],
    ['max-minutes', 'maxMinutes'],
    ['min-pulse', 'minPulse'],
    ['failure-limit', 'consecutiveFailures']
  ])
    $(id).value = p.stop[key] ?? '';
  renderIncludeHelpers();
  updateAdvancedBadge();
}
$('include').addEventListener('input', renderIncludeHelpers);
for (const id of ['target-hits', 'unique-targets', 'max-minutes', 'min-pulse', 'failure-limit']) {
  $(id).addEventListener('input', updateAdvancedBadge);
}
$('policy-form').onsubmit = async e => {
  e.preventDefault();
  const button = e.submitter;
  if (button) button.disabled = true;
  try {
    const r = await rpc('ATI_DRAW_POLICY_SET', {
      policy: {
        rules: {
          enabled: $('rules-enabled').checked,
          include: split($('include').value),
          exclude: split($('exclude').value),
          tiers: [...$('tiers').querySelectorAll('input:checked')].map(e => e.value)
        },
        stop: {
          targetHits: Number($('target-hits').value),
          uniqueTargets: Number($('unique-targets').value),
          maxMinutes: Number($('max-minutes').value),
          minPulse: $('min-pulse').value === '' ? null : Number($('min-pulse').value),
          consecutiveFailures: Number($('failure-limit').value)
        }
      }
    });
    fillPolicy(r.policy);
    notice('配置已保存。正在运行的任务继续使用原来的冻结配置。');
  } catch (e) {
    notice(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
};
$('reset-policy').onclick = () => {
  fillPolicy(P.sanitize());
  notice('已填入默认配置；点击保存后才生效。');
};
$('refresh-quota').onclick = () => void refreshQuota(true);
async function init() {
  try {
    renderQuotaSection();
    const r = await rpc('ATI_DRAW_POLICY_GET');
    fillPolicy(r.policy);
    await refreshQuota(false);
  } catch (e) {
    notice(e.message, true);
  }
}
void init();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['ati.rateLimits.v1']) {
    rateLimitsState = changes['ati.rateLimits.v1'].newValue || null;
    renderQuotaSection();
  }
  if (changes['ati.accountQuota.v1']) {
    accountQuotaState = changes['ati.accountQuota.v1'].newValue || null;
    renderQuotaSection();
  }
});

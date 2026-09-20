/* Classic-script bridge for HUD/popup: balance formatting only (no fetch). Keep in sync with billing.js formatBalance / shortNumber. */
(() => {
  const trim = x => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
  const shortNumber = v => typeof v !== 'number' ? '—' : v >= 1e6 ? trim(v / 1e6) + 'M' : v >= 1e3 ? trim(v / 1e3) + 'K' : String(v);
  const stamp = iso => { if (!iso) return '—'; const d = new Date(iso); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function formatBalance(b) {
    if (!b) return {value: '未提供', note: '未读取', short: '—', total: '—', pct: null, tone: 'none', rows: []};
    const n = v => typeof v === 'number' ? v.toLocaleString('zh-CN') : '未提供';
    const pct = typeof b.creditsRemaining === 'number' && typeof b.dailyFreeCredits === 'number' && b.dailyFreeCredits > 0 ? Math.round(b.creditsRemaining / b.dailyFreeCredits * 1000) / 10 : null;
    const tone = pct === null ? 'none' : pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'low';
    const rows = [['剩余', n(b.creditsRemaining) + ' / ' + n(b.dailyFreeCredits)], ['下次额度重置', stamp(b.refreshedAt)], ['读取', stamp(b.receivedAt) + (typeof b.latencyMs === 'number' ? ' (' + b.latencyMs + 'ms)' : '')]];
    return {value: n(b.creditsRemaining) + (pct !== null ? ' · ' + pct + '%' : ''), note: '每日额度 ' + n(b.dailyFreeCredits) + ' credits' + (b.refreshedAt ? ' · 下次额度重置于 ' + stamp(b.refreshedAt) : ''), short: shortNumber(b.creditsRemaining), total: shortNumber(b.dailyFreeCredits), pct, tone, rows};
  }
  globalThis.ArenaBilling = {formatBalance, shortNumber};
})();

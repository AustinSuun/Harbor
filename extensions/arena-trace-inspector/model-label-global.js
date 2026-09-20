/* Classic-script bridge: exposes model-label parsing to HUD/popup without modules. Keep in sync with model-label.js. */
(() => {
  const TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const DATE_RE = /^(\d{8}|\d{4})$/;
  const ANON_RE = /^[a-z]{3,12}-(?:[a-z]{3,12}-)?[a-z0-9]{4,6}$/;
  const KNOWN_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|glm|grok|llama|mistral|kimi|minimax|o\d|fable|nova|command|phi)/i;
  function parseModelLabel(label) {
    if (typeof label !== 'string' || !label || label.length > 200) return null;
    const out = {label, base: label, tier: null, date: null, trailing: [], anonymous: false};
    const segments = label.split('-');
    let at = -1;
    for (let i = 1; i < segments.length; i++) if (TIERS.includes(segments[i])) at = i;
    if (at > 0) {
      out.tier = segments[at]; out.base = segments.slice(0, at).join('-'); out.trailing = segments.slice(at + 1);
      out.date = out.trailing.find(s => DATE_RE.test(s)) || null;
    } else {
      const d = label.match(/-(\d{8}|\d{4})$/); if (d) { out.date = d[1]; out.base = label.slice(0, -d[0].length); }
    }
    if (!out.tier && !out.date && !KNOWN_FAMILY.test(label) && ANON_RE.test(label)) out.anonymous = true;
    return out;
  }
  function describeModelLabel(label) {
    const p = parseModelLabel(label); if (!p) return ''; const parts = [];
    if (p.tier) parts.push('档位后缀 ' + p.tier + '（Arena 配置标签，非供应商确认的推理参数）');
    if (p.date) parts.push('日期戳 ' + p.date);
    const rest = p.trailing.filter(s => s !== p.date);
    if (rest.length) parts.push('档位后另有 -' + rest.join('-'));
    if (p.anonymous) parts.push('匿名代号');
    return parts.join(' · ');
  }
  globalThis.ArenaModelLabel = {parseModelLabel, describeModelLabel, TIERS};
})();

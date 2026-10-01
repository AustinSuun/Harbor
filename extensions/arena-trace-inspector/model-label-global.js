/* Generated classic bridge of model-label.js; parity is regression-tested. */
(() => {
  // Arena internal modelName label parsing (pure, no I/O). Splits an Arena-side configuration label into
  // base / tier suffix / date stamp / anonymous flag. The tier is an Arena configuration label only —
  // never a provider-confirmed reasoning setting. Nothing is inferred when the pattern is absent.
  const TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const DATE_RE = /-(\d{8}|\d{4})$/;
  const ANON_RE = /^[a-z]{3,12}-(?:[a-z]{3,12}-)?[a-z0-9]{4,6}$/; // e.g. phelan-alpha-gbkh, farris-ees5
  const KNOWN_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|glm|grok|llama|mistral|kimi|minimax|mimo|muse|step|nemotron|doubao|o\d|fable|nova|command|phi)/i;

  function parseModelLabel(label) {
    if (typeof label !== 'string' || !label || label.length > 200) return null;
    const out = {label, base: label, tier: null, date: null, anonymous: false};
    const d = label.match(DATE_RE);
    if (d) {
      out.date = d[1];
      out.base = label.slice(0, -d[0].length);
    }
    // Closed list backed by observed labels; never consume an arbitrary trailing word.
    const qualifier = out.base.match(/-(minimal|low|medium|high|xhigh|max)-(vertex|fireworks|agent|public|code-arena-harness)$/i);
    if (qualifier) {
      out.qualifier = qualifier[2].toLowerCase();
      out.base = out.base.slice(0, -qualifier[2].length - 1);
    }
    const t = out.base.match(new RegExp('-(' + TIERS.join('|') + ')$', 'i'));
    if (t) {
      out.tier = t[1].toLowerCase();
      out.base = out.base.slice(0, -t[0].length);
    }
    if (!out.tier && !out.date && !KNOWN_FAMILY.test(label) && ANON_RE.test(label)) out.anonymous = true;
    return out;
  }

  // Short human note for a label; states explicitly what the tier is and is not.
  function describeModelLabel(label) {
    const p = parseModelLabel(label);
    if (!p) return '';
    const parts = [];
    if (p.tier) parts.push('档位后缀 ' + p.tier + '（Arena 配置标签，非供应商确认的推理参数）');
    if (p.date) parts.push('日期戳 ' + p.date);
    if (p.anonymous) parts.push('匿名代号');
    if (p.qualifier) parts.push('附加标记 ' + p.qualifier + '（不据此推断实际供应商）');
    return parts.join(' · ');
  }

  // A single observed namespace/family pair. No URLs, generic path-tail extraction,
  // date stripping, qwen3p8 substitution or learned aliases are allowed here.
  function normalizeServerLabel(label) {
    if (typeof label !== 'string' || label.length > 200) return {label, canonical: label, namespace: null};
    const hit = /^zai-org\/(glm-[a-z0-9]+(?:[._-][a-z0-9]+)*)$/i.exec(label);
    return {label, canonical: hit ? hit[1] : label, namespace: hit ? 'zai-org' : null};
  }
  // New mappings are bounded prefix matches, never arbitrary substring matches.
  function matchModelLabel(internal, server) {
    const p = parseModelLabel(internal);
    if (!p || p.anonymous || typeof server !== 'string' || !server || server.length > 200) return null;
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm(internal) === norm(server)) return 'exact';
    const normalized = normalizeServerLabel(server);
    if (normalized.namespace) return matchModelLabel(internal, normalized.canonical) ? 'namespace' : null;
    if (norm(p.base) === norm(server)) return p.qualifier ? 'prefix-boundary' : 'base';
    const valid = s => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(s);
    if (!valid(internal) || !valid(server)) return null;
    const parts = s => s.toLowerCase().split(/[._-]/),
      a = parts(internal),
      b = parts(server);
    // A numeric continuation can be a model version, not a configuration suffix.
    if (a.length <= b.length || !b.every((v, i) => a[i] === v) || !/^[a-z]/.test(a[b.length])) return null;
    return 'prefix-boundary';
  }
  function matchModelNames(servers, names) {
    const labels = [...new Set((Array.isArray(servers) ? servers : []).filter(x => typeof x === 'string' && x.length > 0 && x.length <= 200))];
    const raw = [...new Set((Array.isArray(names) ? names : []).filter(x => typeof x === 'string' && x.length > 0 && x.length <= 200))];
    const publicNames = raw.filter(x => !parseModelLabel(x)?.anonymous),
      norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return labels.map(serverLabel => {
      const candidates = publicNames.filter(x => matchModelLabel(x, serverLabel));
      const shared = candidates.some(x => new Set(labels.filter(s => matchModelLabel(x, s)).map(s => norm(normalizeServerLabel(s).canonical))).size > 1);
      const status = candidates.length > 1 || shared ? 'conflict' : candidates.length === 1 ? 'matched' : !raw.length ? 'missing' : !publicNames.length ? 'anonymous' : 'mismatch';
      return {serverLabel, status, method: status === 'matched' ? matchModelLabel(candidates[0], serverLabel) : null, candidates};
    });
  }

  globalThis.ArenaModelLabel = {parseModelLabel, describeModelLabel, matchModelLabel, matchModelNames, normalizeServerLabel, TIERS};
})();

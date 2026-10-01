/* Generated classic bridge; parity tested. */
(() => {
  // Explicit request settings only. No network, tokens, text, inference from model labels,
  // response usage, or action-policy decisions. Unknown paths and values are not retained.
  const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  const MODE = new Set(['enabled', 'disabled', 'adaptive']);
  const DEFINITIONS = [
    ['ai.settings.reasoningEffort', 'effort', 'effort'],
    ['gen_ai.request.reasoning_effort', 'effort', 'effort'],
    ['ai.settings.thinking.type', 'mode', 'mode'],
    ['ai.settings.thinking.budgetTokens', 'budgetTokens', 'budget'],
    ...['ai.settings.providerOptions', 'ai.prompt.providerOptions'].flatMap(root => [
      [root + '.openai.reasoningEffort', 'effort', 'effort'],
      [root + '.anthropic.effort', 'effort', 'effort'],
      [root + '.anthropic.thinking.type', 'mode', 'mode'],
      [root + '.anthropic.thinking.budgetTokens', 'budgetTokens', 'budget'],
      [root + '.google.thinkingConfig.thinkingBudget', 'budgetTokens', 'googleBudget'],
      [root + '.google.thinkingConfig.thinkingLevel', 'effort', 'effort'],
      [root + '.google.thinkingConfig.includeThoughts', 'includeThoughts', 'boolean']
    ])
  ];
  const BY_PATH = new Map(DEFINITIONS.map(d => [d[0], d]));
  const CONTAINERS = new Set(['ai.settings.thinking', 'ai.settings.providerOptions', 'ai.prompt.providerOptions']);
  function accepted(v, type) {
    if (type === 'effort') return typeof v === 'string' && EFFORT.has(v);
    if (type === 'mode') return typeof v === 'string' && MODE.has(v);
    if (type === 'boolean') return typeof v === 'boolean';
    return Number.isSafeInteger(v) && v <= 10000000 && v >= (type === 'googleBudget' ? -1 : 0);
  }
  // Supports nested, dotted and mixed objects without choosing a winner when two
  // representations disagree. JSON decoding is restricted to known containers.
  function valuesAt(input, path) {
    const parts = path.split('.'),
      out = [];
    function walk(node, at) {
      if (out.length >= 4) return;
      const prefix = parts.slice(0, at).join('.');
      if (typeof node === 'string' && node.length <= 16384 && CONTAINERS.has(prefix)) {
        try {
          node = JSON.parse(node);
        } catch {
          return;
        }
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (let end = at + 1; end <= parts.length; end++) {
        const key = parts.slice(at, end).join('.');
        if (!Object.hasOwn(node, key)) continue;
        if (end === parts.length) out.push(node[key]);
        else walk(node[key], end);
        if (out.length >= 4) return;
      }
    }
    walk(input, 0);
    return out;
  }
  function finish(fields, rejectedPaths) {
    const unique = [...new Map(fields.map(f => [f.path + '\0' + JSON.stringify(f.value), f])).values()];
    const rejected = [...new Set(rejectedPaths)];
    const conflicts = ['effort', 'mode', 'budgetTokens', 'includeThoughts'].filter(parameter => new Set(unique.filter(f => f.parameter === parameter).map(f => JSON.stringify(f.value))).size > 1);
    return {
      schemaVersion: 1,
      source: 'request-record',
      status: conflicts.length ? 'conflict' : unique.length ? 'present' : rejected.length ? 'invalid' : 'absent',
      fields: unique,
      rejectedPaths: rejected,
      conflicts
    };
  }
  function extractReasoningEvidence(props) {
    const fields = [],
      rejected = [];
    for (const [path, parameter, type] of DEFINITIONS)
      for (const value of valuesAt(props, path)) {
        if (accepted(value, type)) fields.push({path, parameter, value});
        else rejected.push(path);
      }
    return finish(fields, rejected);
  }
  function sanitizeReasoningEvidence(input) {
    if (input?.schemaVersion !== 1 || !Array.isArray(input.fields)) return {...finish([], []), status: 'unrecorded'};
    const fields = [],
      rejected = [];
    for (const f of (Array.isArray(input?.fields) ? input.fields : []).slice(0, 80)) {
      const d = BY_PATH.get(f?.path);
      if (!d) continue;
      if (accepted(f.value, d[2])) fields.push({path: d[0], parameter: d[1], value: f.value});
      else rejected.push(d[0]);
    }
    for (const p of (Array.isArray(input?.rejectedPaths) ? input.rejectedPaths : []).slice(0, 40)) if (BY_PATH.has(p)) rejected.push(p);
    return finish(fields, rejected);
  }

  globalThis.ArenaReasoningEvidence = {extractReasoningEvidence, sanitizeReasoningEvidence};
})();

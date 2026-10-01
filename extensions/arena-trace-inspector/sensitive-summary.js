/* Key-name-only risk summaries for the opt-in raw archive. Values are never inspected or returned. */
const ORDER = ['credentials', 'bodyText', 'reasoning', 'identity', 'clientMetadata'];
const MAX_NODES = 10000,
  MAX_DEPTH = 32;

function classify(key, found) {
  const name = String(key || '');
  if (/(?:token|authorization|cookie|secret|password|api[_-]?key|credential|signature)/i.test(name)) found.add('credentials');
  if (/(?:prompt|content|message|completion|response|output|input|body|text)/i.test(name)) found.add('bodyText');
  if (/(?:reasoning|thinking|chain.?of.?thought|cot)/i.test(name)) found.add('reasoning');
  if (/(?:email|user.?id|account.?id|user(name)?|profile)/i.test(name)) found.add('identity');
  if (/(?:cloudflare|recaptcha|bot.?score|client.?ip|hashed.?ip|user.?agent|client.?asn|client.?city|ja4|fingerprint)/i.test(name)) found.add('clientMetadata');
}

export function summarizeSensitive(value, {hasToken = false} = {}) {
  const found = new Set(),
    seen = new WeakSet();
  if (hasToken) found.add('credentials');
  let nodes = 0,
    truncated = false;
  const walk = (item, depth = 0) => {
    if (truncated || item === null || typeof item !== 'object') return;
    if (depth > MAX_DEPTH || nodes++ >= MAX_NODES) {
      truncated = true;
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1);
      return;
    }
    try {
      for (const key of Object.keys(item)) {
        classify(key, found);
        const child = item[key]; // Used only to continue structural traversal; string values are never inspected.
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    } catch {
      truncated = true;
    }
  };
  walk(value);
  return {schemaVersion: 1, categories: ORDER.filter(category => found.has(category)), ...(truncated ? {truncated: true} : {})};
}

export function summarizeRawRecords(records) {
  const counts = Object.fromEntries(ORDER.map(category => [category, 0]));
  let recordCount = 0,
    truncated = false;
  for (const record of Array.isArray(records) ? records : []) {
    recordCount++;
    const summary = summarizeSensitive(record?.payload, {hasToken: typeof record?.token === 'string' && !!record.token});
    // v2 text is intentionally opaque: don't JSON-parse private bodies to classify them.
    // Warn conservatively that all categories may be present in unfiltered responses.
    if (record?.schemaVersion === 2) summary.categories = [...ORDER];
    for (const category of summary.categories) counts[category]++;
    if (summary.truncated) truncated = true;
  }
  const categories = ORDER.filter(category => counts[category] > 0);
  return {schemaVersion: 1, recordCount, categories, categoryCounts: Object.fromEntries(categories.map(category => [category, counts[category]])), ...(truncated ? {truncated: true} : {})};
}

// Only these observed label values may leave the trace parser. Never retain raw trace.
const fields = {
  model: ['style.accessory.items[icon=tabler-cube].text', 200],
  provider: ['style.icon', 100],
  tokens: ['style.accessory.items[icon=tabler-hash].text', 40],
  cost: ['style.accessory.items[icon=tabler-currency-dollar].text', 40]
};
const time = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
export function sanitizeEvidence(input) {
  if (input?.schemaVersion !== 1) return null;
  const out = {schemaVersion: 1, source: 'Trigger.dev run events', spanName: 'ai.streamText.doStream'};
  for (const [name, [path, max]] of Object.entries(fields)) {
    const entry = input[name];
    if (!entry || typeof entry.value !== 'string' || !entry.value.trim() || entry.value.length > max) continue;
    if (name === 'provider' && !/^ai-provider-[\w.-]+$/.test(entry.value)) continue;
    if (name === 'tokens' && !/^\d[\d,.]*\s*[kmb]?$/i.test(entry.value.trim())) continue;
    if (name === 'cost' && !/^\$\s*\d+(?:\.\d+)?$/.test(entry.value.trim())) continue;
    out[name] = {path, value: entry.value, observedAt: time(entry.observedAt)};
  }
  if (input.flags && typeof input.flags === 'object') {
    out.flags = {observedAt: time(input.flags.observedAt)};
    for (const name of ['isPartial', 'isError', 'isCancelled']) out.flags[name] = typeof input.flags[name] === 'boolean' ? input.flags[name] : null;
  }
  return out;
}
export function createEvidence(labels, event, checkedAt) {
  const out = {schemaVersion: 1, flags: {isPartial: event.isPartial, isError: event.isError, isCancelled: event.isCancelled, observedAt: checkedAt}};
  for (const [name, value] of Object.entries(labels)) if (value != null) out[name] = {value, observedAt: checkedAt};
  return sanitizeEvidence(out);
}
export function mergeEvidence(oldValue, incoming) {
  const old = sanitizeEvidence(oldValue), next = sanitizeEvidence(incoming);
  if (!next) return old;
  // Keep each label's own observation time when a later snapshot omits a field.
  return sanitizeEvidence({...old, ...next});
}

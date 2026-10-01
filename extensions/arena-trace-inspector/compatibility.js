// Fixed protocol checkpoints only. Never retain unknown event keys or values.
const CHECKS = [
  ['trace-events', 'trace.events'],
  ['run-events', 'trace.events[runId]'],
  ['stream-spans', 'events[].message = ai.streamText.doStream'],
  ['span-id', 'events[].spanId'],
  ['accessory-items', 'events[].style.accessory.items'],
  ['model-label', 'items[icon=tabler-cube]']
];
const STATES = new Set(['ok', 'pending', 'missing', 'invalid', 'limited', 'unavailable']);
const stateMap = () => Object.fromEntries(CHECKS.map(([id]) => [id, 'unavailable']));
function levelOf(states) {
  if (states['trace-events'] === 'limited') return 'limited';
  if (Object.values(states).includes('invalid')) return 'incompatible';
  if (states['run-events'] === 'pending' || states['stream-spans'] === 'pending') return 'pending';
  if (Object.values(states).includes('missing')) return 'partial';
  if (CHECKS.every(([id]) => states[id] === 'ok')) return 'compatible';
  return 'unknown';
}
function output(states) {
  return {schemaVersion: 1, level: levelOf(states), checks: CHECKS.map(([id, location]) => ({id, location, status: states[id]}))};
}
function validSpanId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function modelLabel(items) {
  return items.some(item => item?.icon === 'tabler-cube' && typeof item.text === 'string' && item.text.trim() && item.text.length <= 200);
}

export function inspectTraceCompatibility(trace, runId) {
  const states = stateMap();
  if (!Array.isArray(trace?.events) || typeof runId !== 'string' || !runId) {
    states['trace-events'] = 'invalid';
    return output(states);
  }
  states['trace-events'] = 'ok';
  const runEvents = trace.events.filter(event => event && typeof event === 'object' && event.runId === runId);
  if (!runEvents.length) {
    states['run-events'] = 'pending';
    return output(states);
  }
  states['run-events'] = 'ok';
  const streams = runEvents.filter(event => event.message === 'ai.streamText.doStream');
  if (!streams.length) {
    states['stream-spans'] = 'pending';
    return output(states);
  }
  states['stream-spans'] = 'ok';
  states['span-id'] = streams.every(event => validSpanId(event.spanId)) ? 'ok' : 'invalid';
  const itemSets = streams.map(event => event.style?.accessory?.items);
  states['accessory-items'] = itemSets.every(Array.isArray) ? 'ok' : 'invalid';
  states['model-label'] = itemSets.every(items => Array.isArray(items) && modelLabel(items)) ? 'ok' : 'missing';
  return output(states);
}

export function traceCompatibilityFailure(kind = 'invalid') {
  const states = stateMap();
  states['trace-events'] = kind === 'limited' ? 'limited' : 'invalid';
  return output(states);
}

export function sanitizeCompatibility(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.checks)) return null;
  const states = stateMap();
  for (const [id] of CHECKS) {
    const status = value.checks.find(check => check?.id === id)?.status;
    if (STATES.has(status)) states[id] = status;
  }
  return output(states);
}

// In-run model-switch fingerprint. Provider-agnostic and target-agnostic.
// Stage A (suspected): after a labelled doStream span, an unlabelled partial (not error/cancelled) span.
// Stage B (switched): a later labelled span whose model differs from the original.
// An unlabelled partial BEFORE any label is not a switch (counterexample 01a0b159).
// A later label equal to the original clears suspicion.

export function none() {
  return {state: 'none', from: '', to: '', suspectedAt: '', confirmedAt: ''};
}

function label(span) {
  return typeof span?.model === 'string' ? span.model.trim().slice(0, 200) : '';
}

function dead(span) {
  return span?.error === true || span?.cancelled === true;
}

export function detectSwitch(spans) {
  if (!Array.isArray(spans)) return none();
  let from = '',
    suspected = false,
    suspectedAt = '';
  for (const span of spans) {
    if (!span || typeof span !== 'object') continue;
    const model = label(span);
    if (!from) {
      if (model) from = model;
      continue;
    }
    if (!model) {
      if (span.partial === true && !dead(span) && !suspected) {
        suspected = true;
        suspectedAt = typeof span.spanId === 'string' ? span.spanId.slice(0, 128) : '';
      }
      continue;
    }
    if (!suspected) continue;
    if (model === from) {
      suspected = false;
      suspectedAt = '';
      continue;
    }
    return {
      state: 'switched',
      from,
      to: model,
      suspectedAt,
      confirmedAt: typeof span.spanId === 'string' ? span.spanId.slice(0, 128) : ''
    };
  }
  if (suspected && from) return {state: 'suspected', from, to: '', suspectedAt, confirmedAt: ''};
  return none();
}

export function sanitizeSwitch(value) {
  if (!value || typeof value !== 'object') return null;
  const from = typeof value.from === 'string' ? value.from.trim().slice(0, 200) : '';
  if (!from) return null;
  const suspectedAt = typeof value.suspectedAt === 'string' ? value.suspectedAt.slice(0, 128) : '';
  const confirmedAt = typeof value.confirmedAt === 'string' ? value.confirmedAt.slice(0, 128) : '';
  if (value.state === 'suspected') return {state: 'suspected', from, to: '', suspectedAt, confirmedAt: ''};
  if (value.state !== 'switched') return null;
  const to = typeof value.to === 'string' ? value.to.trim().slice(0, 200) : '';
  if (!to || to === from) return null;
  const out = {state: 'switched', from, to, suspectedAt, confirmedAt};
  if (typeof value.at === 'string' && value.at.length <= 40 && Number.isFinite(Date.parse(value.at))) out.at = value.at;
  return out;
}

// Once switched, keep the first confirmation. Suspected is live-only unless overwritten by switched.
export function mergeSwitch(previous, incoming) {
  const old = sanitizeSwitch(previous);
  const next = sanitizeSwitch(incoming);
  if (old?.state === 'switched') return old;
  if (next?.state === 'switched') return {...next, at: next.at || new Date().toISOString()};
  if (next?.state === 'suspected') return next;
  return old || null;
}

// Arena conversation titles cap at 100 characters.
export function renameTitle(model, sw) {
  const name = typeof model === 'string' ? model.trim() : '';
  if (!name) return '';
  if (sanitizeSwitch(sw)?.state === 'switched' && !name.includes('(被路由)')) return (name + '(被路由)').slice(0, 100);
  return name.slice(0, 100);
}

export function pickSwitch(...candidates) {
  const cleaned = candidates.map(sanitizeSwitch);
  return cleaned.find(x => x?.state === 'switched') || cleaned.find(x => x?.state === 'suspected') || null;
}

export function watchStatus(sw, generating) {
  if (!sw || sw.state === 'none') return '';
  if (sw.state === 'switched') return '模型已切换：' + (sw.from || '原模型') + ' → ' + (sw.to || '未知');
  if (sw.state === 'suspected') return generating ? '上游调用挂起，正在核对模型…' : '疑似被路由，下一轮开始时确认';
  return '';
}

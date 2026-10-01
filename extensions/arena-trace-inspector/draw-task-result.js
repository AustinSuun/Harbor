/* Current task outcome is independent of historical failed attempts. No migration writes on read. */
export const FAILURE_STEPS = ['send', 'recognition', 'rename', 'archive', 'cleanup', 'navigation', 'record'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function normalizeRound(input) {
  const r = {...input};
  if (!r.currentFailures || typeof r.currentFailures !== 'object' || Array.isArray(r.currentFailures)) {
    r.currentFailures = {};
    if ((r.failed || r.outcome === 'failed') && ((!r.renamed && !r.archived) || !['kept', 'archived'].includes(r.outcome))) {
      const step = r.renamed || r.archived ? 'record' : r.renameState ? 'rename' : r.runId ? 'recognition' : 'send';
      r.currentFailures[step] = r.reason || 'operation-failed';
    }
    if (r.failed || r.outcome === 'failed') {
      r.failureCount = Math.max(1, r.failureCount || 0);
      r.failureHistoryIncomplete = true;
    }
  } else r.currentFailures = Object.fromEntries(Object.entries(r.currentFailures).filter(([k]) => FAILURE_STEPS.includes(k)));
  r.failureCount = Number.isSafeInteger(r.failureCount) && r.failureCount >= 0 ? r.failureCount : 0;
  if (r.archived && !r.cleanupState) r.cleanupState = 'confirmed'; // 2.5.0 archive-confirmed included local cleanup.
  r.failed = Object.keys(r.currentFailures).length > 0;
  if (r.archived) r.outcome = 'archived';
  else if (r.failed) {
    if (r.outcome !== 'review' || r.mapping === 'matched') r.outcome = 'failed';
  } else if (r.renamed) r.outcome = r.mapping !== 'matched' || r.decision === 'review' ? 'review' : 'kept';
  else if (r.finishedAt || ['failed', 'kept', 'review', 'incomplete'].includes(r.outcome)) r.outcome = r.mapping !== 'matched' ? 'review' : 'incomplete';
  return r;
}
export function failRound(row, step, reason) {
  if (!FAILURE_STEPS.includes(step)) step = 'record';
  row.currentFailures[step] = reason || 'operation-failed';
  row.failureCount++;
  row.failed = true;
}
function resolveStep(row, step) {
  delete row.currentFailures[step];
  row.failed = Object.keys(row.currentFailures).length > 0;
}
export function applyResultEvent(row, type, fields, stamp) {
  if (type === 'rule-evaluated') row.ruleReason = fields.reason;
  if (type === 'send-intent') row.sendIntent = true;
  if (type === 'session-confirmed') {
    row.sent = true;
    resolveStep(row, 'send');
  }
  if (type === 'naming-ready' || type === 'retry-recovered') {
    row.identified = row.mapping === 'matched';
    if (type === 'retry-recovered' || row.identified) resolveStep(row, 'recognition');
  }
  if (type === 'rename-start') row.renameState = 'pending';
  if (type === 'rename-submitted') row.renameState = 'uncertain';
  if (type === 'rename-confirmed' || type === 'retry-rename-confirmed') {
    row.renamed = true;
    row.renameState = 'confirmed';
    row.renameAt = stamp;
    resolveStep(row, 'rename');
  }
  if (type === 'archive-confirmed') {
    row.archived = true;
    row.cleanupState = 'pending';
    resolveStep(row, 'archive');
  }
  if (type === 'cleanup-confirmed' || type === 'retry-cleanup-confirmed') {
    row.cleanupState = 'confirmed';
    resolveStep(row, 'cleanup');
  }
  if (type === 'cleanup-failed') {
    row.cleanupState = 'failed';
    failRound(row, 'cleanup', fields.reason || 'cleanup-failed');
  }
  if (type === 'round-failed') failRound(row, fields.failureStep || 'record', fields.reason);
  if (type === 'retry-failed') {
    const step = {recover: 'recognition', rename: 'rename', cleanup: 'cleanup'}[row.retryAction] || 'record';
    if (step === 'cleanup') row.cleanupState = 'failed';
    failRound(row, step, fields.reason);
  }
  if (type.startsWith('retry-')) row.retryState = type === 'retry-start' ? 'pending' : type === 'retry-failed' ? 'failed' : 'complete';
  if (type === 'round-finished' || type === 'round-failed') row.finishedAt = stamp;
  // Null outcome means a new round is still in progress, not a successful round.
  if (type === 'round-failed' && !own(fields, 'outcome') && !row.outcome) row.outcome = 'failed';
  return normalizeRound(row);
}

import './collection-global.js';
export const {sanitizeCollection, withPersistence, collectionRows, freshnessView, sanitizeFreshness, freshnessRows} = globalThis.ArenaCollection;

// Failure diagnostics cannot repair a failed write by claiming that it was saved.
// No fallback key, no automatic retry, no writes for a stale page/turn.
export async function persistCollectionFailure({history, sessionId, runId, diagnostic, isCurrent}) {
  if (!isCurrent()) return null;
  try {
    const saved = await history.saveCollection(sessionId, runId, diagnostic, isCurrent);
    return isCurrent() ? saved : null;
  } catch {
    return isCurrent() ? withPersistence(diagnostic, 'failed') : null;
  }
}

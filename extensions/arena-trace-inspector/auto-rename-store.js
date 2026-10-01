// Two-phase automatic naming. A lease prevents concurrent UI attempts; only a
// confirmed successful UI result writes the legacy completed marker.
import {conversationUrl} from './history.js';
const RENAME_LIMITS = {leaseMs: 60000, retryMs: 2000, maxAttempts: 2};
const ENABLED = 'ati.autoRename.enabled.v1',
  DONE = 'ati.autoRename.attempted.v1.',
  PENDING = 'ati.autoRename.pending.v2.',
  RETRY = 'ati.autoRename.retry.v2.';
export function createAutoRenameStore(area, {now = Date.now, id = () => crypto.randomUUID()} = {}) {
  let queue = Promise.resolve();
  const enqueue = task => {
    const work = queue.then(task);
    queue = work.catch(() => {});
    return work;
  };
  const get = async key => (await area.get(key))[key];
  const canUpgrade = (prev, title, internal) => !prev || (!(typeof prev === 'object' && prev.internal === true) && internal && title && prev.title !== title);
  return {
    get: () => enqueue(async () => ({enabled: (await get(ENABLED)) === true})),
    set: enabled =>
      enqueue(async () => {
        if (typeof enabled !== 'boolean') throw Error('Invalid preference');
        await area.set({[ENABLED]: enabled});
        return {enabled};
      }),
    reserve: (sessionId, {title, internal = false, owner, runId, previousTitle = null, serverTitle = null} = {}) =>
      enqueue(async () => {
        conversationUrl(sessionId);
        if (typeof title !== 'string' || !title.trim() || title.length > 100 || !Number.isInteger(owner) || typeof runId !== 'string') throw Error('Invalid rename reservation');
        if ((await get(ENABLED)) !== true) return {claimed: false, disabled: true};
        const completed = await get(DONE + sessionId);
        if (!canUpgrade(completed, title, internal)) return {claimed: false, final: true};
        const pending = await get(PENDING + sessionId);
        if (pending && pending.expiresAt > now()) return {claimed: false, busy: true, retryAfterMs: Math.min(2000, pending.expiresAt - now())};
        const retry = await get(RETRY + sessionId);
        if (retry?.uncertain) return {claimed: false, final: true, failed: true};
        if (retry?.title === title) {
          if (retry.failures >= RENAME_LIMITS.maxAttempts || retry.uncertain) return {claimed: false, final: true, failed: true};
          if (retry.nextRetryAt > now()) return {claimed: false, retryAfterMs: retry.nextRetryAt - now()};
        }
        // Preserve an expired attempt's original title. UI must not overwrite a user edit.
        const expectedTitle = retry?.title === title ? retry.previousTitle : pending?.title === title ? pending.previousTitle : completed ? completed.title || serverTitle : previousTitle;
        // An old boolean marker has no original title. Only a known server label
        // may authorize its one-time upgrade; never infer from a user's new title.
        if (completed && typeof expectedTitle !== 'string') return {claimed: false, final: true, failed: true};
        const lease = {
          leaseId: id(),
          sessionId,
          runId,
          owner,
          title,
          internal: internal === true,
          previousTitle: typeof expectedTitle === 'string' ? expectedTitle.slice(0, 300) : null,
          expiresAt: now() + RENAME_LIMITS.leaseMs
        };
        await area.set({[PENDING + sessionId]: lease});
        return {claimed: true, leaseId: lease.leaseId, title, internal: lease.internal, previousTitle: lease.previousTitle, expiresAt: lease.expiresAt};
      }),
    finish: (sessionId, {leaseId, owner, success = false, title, previousTitle = null, retryable = false, submitted = false, aborted = false} = {}) =>
      enqueue(async () => {
        conversationUrl(sessionId);
        const key = PENDING + sessionId,
          lease = await get(key);
        if (!lease || lease.leaseId !== leaseId || lease.owner !== owner) return {ok: false, stale: true};
        if (success && title === lease.title) {
          // The UI has observed the target title and closed dialog (or was unchanged).
          await area.set({[DONE + sessionId]: {title: lease.title, internal: lease.internal, at: new Date(now()).toISOString()}});
          await area.remove([key, RETRY + sessionId]);
          return {ok: true, completed: true};
        }
        if (aborted && !submitted) {
          await area.remove(key);
          return {ok: true, released: true};
        }
        const old = await get(RETRY + sessionId),
          failures = (old?.title === lease.title ? old.failures || 0 : 0) + 1;
        const canRetry = retryable && !submitted && failures < RENAME_LIMITS.maxAttempts;
        const record = {
          title: lease.title,
          failures,
          previousTitle: typeof previousTitle === 'string' ? previousTitle.slice(0, 300) : lease.previousTitle,
          nextRetryAt: now() + RENAME_LIMITS.retryMs,
          uncertain: submitted || !retryable
        };
        await area.set({[RETRY + sessionId]: record});
        await area.remove(key);
        return {ok: true, completed: false, ...(canRetry ? {retryAfterMs: RENAME_LIMITS.retryMs} : {final: true})};
      }),
    releaseOwner: owner =>
      enqueue(async () => {
        const all = await area.get(null),
          keys = Object.keys(all).filter(k => k.startsWith(PENDING) && all[k]?.owner === owner);
        if (keys.length) await area.remove(keys);
      })
  };
}

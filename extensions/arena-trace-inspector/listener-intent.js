// Browser-session-only per-tab listening intent. No tokens or run data persist.
// Explicit stop, a safety block, external debugger cancellation and leaving Arena
// clear intent. A route change within Arena does not.
const KEY = 'ati.listening.session.v1';
export function createListenerIntent(area) {
  const tabs = new Set();
  let queue = Promise.resolve();
  const ready = (async () => {
    if (!area) return;
    try {
      for (const id of (await area.get(KEY))[KEY]?.tabs || []) if (Number.isInteger(id) && id >= 0) tabs.add(id);
    } catch {}
  })();
  return {
    ready,
    has: id => tabs.has(id),
    set(id, enabled) {
      const work = queue.then(async () => {
        await ready;
        if (enabled) tabs.add(id);
        else tabs.delete(id);
        if (area) await area.set({[KEY]: {tabs: [...tabs]}});
      });
      queue = work.catch(() => {});
      return work;
    }
  };
}

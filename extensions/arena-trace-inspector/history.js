import {sanitizeCollection, withPersistence} from './collection.js';
import {mergeUsage, summarizeUsage} from './usage.js';
import {cleanProvider} from './core.js';
import {sanitizeDetail} from './agent-detail.js';
import {sanitizeSwitch, mergeSwitch} from './model-switch.js';
import {accountKeyPart} from './account.js';
import {sanitizeCompatibility} from './compatibility.js';
export const HISTORY_PREFIX = 'ati.conversation.v1.';
// 2.3.0: records are scoped per account -> ati.conversation.v2.<accountId>.<sessionId>
export const HISTORY_PREFIX_V2 = 'ati.conversation.v2.';
export const UNKNOWN_ACCOUNT = 'unknown';

export function historyKey(accountId, sessionId) {
  conversationUrl(sessionId);
  return HISTORY_PREFIX_V2 + accountKeyPart(accountId || UNKNOWN_ACCOUNT) + '.' + sessionId;
}

export function conversationUrl(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('会话 ID 无效');
  return 'https://arena.ai/agent/' + sessionId;
}

export function cleanRecordProviders(record) {
  if (!record) return record;
  const result = {...record, observations: (record.observations || []).map(o => ({...o, provider: cleanProvider(o.provider)}))};
  const conv = sanitizeSwitch(record.switch);
  if (conv?.state === 'switched') result.switch = conv;
  else delete result.switch;
  if (record.runs)
    result.runs = record.runs.map(r => {
      const run = {...r, spans: (r.spans || []).map(s => ({...s, provider: cleanProvider(s.provider)}))},
        compatibility = sanitizeCompatibility(r.compatibility);
      const collection = sanitizeCollection(r.collection);
      if (collection) run.collection = collection;
      else delete run.collection;
      if (compatibility) run.compatibility = compatibility;
      else delete run.compatibility;
      return run;
    });
  return result;
}
export function mergeRecord(previous, input) {
  const url = conversationUrl(input.sessionId);
  if (!Array.isArray(input.models) || !input.models.length) throw new Error('没有已确认模型，不能保存');
  const time = input.checkedAt || new Date().toISOString();
  const old = previous?.sessionId === input.sessionId ? cleanRecordProviders(previous) : null;
  const observations = [...(old?.observations || [])];
  for (const model of input.models) {
    if (typeof model.model !== 'string' || !model.model.trim()) continue;
    // Explicit allowlist: never persist the token, raw trace or message text.
    const entry = {
      model: model.model.slice(0, 200),
      provider: cleanProvider(model.provider),
      runId: String(input.runId || '').slice(0, 128),
      spanId: String(model.spanId || '').slice(0, 128),
      partial: !!model.partial,
      firstSeen: time,
      lastSeen: time
    };
    const index = observations.findIndex(x => x.runId === entry.runId && x.model === entry.model && x.provider === entry.provider);
    if (index < 0) observations.push(entry);
    else observations[index] = {...entry, firstSeen: observations[index].firstSeen};
  }
  if (!observations.length) throw new Error('没有有效模型标签');
  const runs = mergeUsage(old?.runs, input.usage);
  for (const r of runs) {
    const priorRun = old?.runs?.find(x => x.runId === r.runId);
    const d = sanitizeDetail(priorRun?.detail);
    if (d) r.detail = d;
    const collection = sanitizeCollection(r.runId === input.runId ? input.collection : null) || sanitizeCollection(priorRun?.collection);
    if (collection) r.collection = collection;
    else delete r.collection;
    const incoming = r.runId === input.usage?.runId ? input.usage?.switch : null;
    const persisted = mergeSwitch(priorRun?.switch, incoming);
    if (persisted?.state === 'switched') r.switch = persisted;
    else delete r.switch;
  }
  const conv = runs.map(r => r.switch).find(s => s?.state === 'switched') || sanitizeSwitch(old?.switch);
  // 2.4.0: chat transcripts moved OUT of this record into ati.chat.v1.* (chat-store.js).
  // Model metadata and conversation text are stored and exported separately.
  const account = input.account && typeof input.account === 'object' ? input.account : old?.account || null;
  return {
    schemaVersion: 2,
    kind: 'metadata',
    sessionId: input.sessionId,
    url,
    ...(account ? {account} : {}),
    title: String(input.title || old?.title || 'Arena 会话').slice(0, 300),
    firstSeen: old?.firstSeen || time,
    lastSeen: time,
    observations,
    runs,
    totals: summarizeUsage(runs),
    ...(conv?.state === 'switched' ? {switch: conv} : {})
  };
}

export function createHistoryStore(area) {
  let queue = Promise.resolve();
  // Records written before 2.3.0 live under ati.conversation.v1.<sessionId> with
  // schemaVersion 1 and no account. They stay readable; nothing is rewritten in place.
  const validRecord = r => r && (r.schemaVersion === 1 || r.schemaVersion === 2) && Array.isArray(r.observations);
  const keyOf = (accountId, sessionId) => historyKey(accountId, sessionId);
  // Single-key gets only: chrome.storage accepts arrays, but the test doubles (and the
  // documented mini-API) implement get(key) / get(null). Keep to that contract.
  async function findExisting(area, sessionId, accountId) {
    const v2 = keyOf(accountId, sessionId);
    const current = (await area.get(v2))[v2];
    if (current) return {key: v2, record: current};
    const legacyKey = HISTORY_PREFIX + sessionId;
    const legacy = (await area.get(legacyKey))[legacyKey];
    if (legacy) return {key: v2, record: legacy, legacyKey};
    return {key: v2, record: undefined};
  }
  async function removalSnapshot(sessionId) {
    conversationUrl(sessionId);
    const all = await area.get(null);
    const keys = Object.keys(all)
      .filter(k => (k.startsWith(HISTORY_PREFIX_V2) || k.startsWith(HISTORY_PREFIX)) && k.endsWith('.' + sessionId))
      .sort();
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(keys.map(k => [k, all[k]]))));
    return {keys, fingerprint: [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('')};
  }
  return {
    removalFingerprint(sessionId) {
      const work = queue.then(async () => (await removalSnapshot(sessionId)).fingerprint);
      queue = work.catch(() => {});
      return work;
    },
    removeIfUnchanged(sessionId, fingerprint) {
      const work = queue.then(async () => {
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('缺少本地记录版本，未清理');
        const snapshot = await removalSnapshot(sessionId);
        if (!snapshot.keys.length) return {removed: 0};
        if (snapshot.fingerprint !== fingerprint) throw Object.assign(Error('本地记录已变化，未删除新数据'), {code: 'cleanup-changed'});
        await area.remove(snapshot.keys);
        return {removed: snapshot.keys.length};
      });
      queue = work.catch(() => {});
      return work;
    },
    save(input) {
      const work = queue.then(async () => {
        const accountId = input.account?.accountId || UNKNOWN_ACCOUNT;
        const {key, record: old, legacyKey} = await findExisting(area, input.sessionId, accountId);
        const record = mergeRecord(old, input);
        const diagnostic = sanitizeCollection(input.collection),
          run = record.runs?.find(r => r.runId === input.runId);
        if (diagnostic && run) {
          const prior = sanitizeCollection(old?.runs?.find(r => r.runId === input.runId)?.collection);
          run.collection = diagnostic.persistence === 'saved-detail' && JSON.stringify(diagnostic) === JSON.stringify(prior) ? prior : withPersistence(diagnostic, 'saved-metadata');
        }
        await area.set({[key]: record});
        // Upgrade in place: the v1 copy is removed only after the v2 write succeeded.
        if (legacyKey) await area.remove(legacyKey);
        return record;
      });
      queue = work.catch(() => {});
      return work;
    },
    saveDetail(sessionId, runId, detail, diagnostic = null) {
      const work = queue.then(async () => {
        conversationUrl(sessionId);
        const all = await area.get(null);
        const key = Object.keys(all).find(k => (k.startsWith(HISTORY_PREFIX_V2) || k.startsWith(HISTORY_PREFIX)) && k.endsWith('.' + sessionId) && validRecord(all[k]));
        const record = key ? structuredClone(all[key]) : null;
        if (!record) throw new Error('会话记录不存在');
        const clean = sanitizeDetail(detail);
        if (!clean) throw new Error('span 详情无效');
        const run = (record.runs || []).find(r => r.runId === runId);
        if (!run) throw new Error('运行记录不存在');
        run.detail = clean;
        const collection = sanitizeCollection(diagnostic);
        if (collection && clean.spans.every(s => collection.spans.some(row => row.state === 'validated' && row.spanId === s.spanId && row.kind === s.kind && row.turn === s.turn)))
          run.collection = withPersistence(collection, 'saved-detail', clean.spans.length);
        else delete run.collection;
        await area.set({[key]: record});
        return clean;
      });
      queue = work.catch(() => {});
      return work;
    },
    // Latest diagnostic for an already-existing run only. Never creates a metadata record.
    saveCollection(sessionId, runId, diagnostic, isCurrent = () => true) {
      const work = queue.then(async () => {
        conversationUrl(sessionId);
        const clean = sanitizeCollection(diagnostic);
        if (!clean || !isCurrent()) return null;
        const all = await area.get(null);
        const key = Object.keys(all).find(k => (k.startsWith(HISTORY_PREFIX_V2) || k.startsWith(HISTORY_PREFIX)) && k.endsWith('.' + sessionId) && validRecord(all[k]));
        const record = key ? structuredClone(all[key]) : null,
          run = record?.runs?.find(r => r.runId === runId);
        if (!run || !isCurrent()) return null;
        run.collection = withPersistence(clean, 'saved-metadata');
        await area.set({[key]: record});
        return run.collection;
      });
      queue = work.catch(() => {});
      return work;
    },
    remove(sessionId) {
      const work = queue.then(async () => {
        conversationUrl(sessionId); // Validate before constructing a storage key.
        const all = await area.get(null);
        const keys = Object.keys(all).filter(k => (k.startsWith(HISTORY_PREFIX_V2) || k.startsWith(HISTORY_PREFIX)) && k.endsWith('.' + sessionId));
        if (keys.length) await area.remove(keys);
      });
      queue = work.catch(() => {});
      return work;
    },
    // Targeted single-key reads first. A full get(null) scan would both defeat the
    // per-key read ordering the late-write guard depends on and read all of storage
    // to answer one session. The scan stays only as a last resort for records saved
    // under an account id this caller does not know.
    async get(sessionId, accountId) {
      const url = conversationUrl(sessionId);
      await queue;
      const candidates = [historyKey(accountId, sessionId), HISTORY_PREFIX + sessionId];
      let record = null;
      for (const key of candidates) {
        const found = (await area.get(key))[key];
        if (validRecord(found)) {
          record = found;
          break;
        }
      }
      if (!record) {
        const all = await area.get(null);
        const key = Object.keys(all).find(k => k.startsWith(HISTORY_PREFIX_V2) && k.endsWith('.' + sessionId) && validRecord(all[k]));
        if (key) record = all[key];
      }
      return record && record.sessionId === sessionId && record.url === url ? cleanRecordProviders(record) : null;
    },
    async list() {
      await queue;
      const all = await area.get(null);
      return Object.entries(all)
        .filter(([key, r]) => (key.startsWith(HISTORY_PREFIX_V2) || key.startsWith(HISTORY_PREFIX)) && validRecord(r))
        .map(([, r]) => cleanRecordProviders(r))
        .filter(r => {
          try {
            return r.url === conversationUrl(r.sessionId);
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    }
  };
}

// Completed auto-name markers remain independent of captured history.
export {createAutoRenameStore} from './auto-rename-store.js';

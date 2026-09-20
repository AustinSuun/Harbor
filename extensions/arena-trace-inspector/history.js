import {mergeUsage, summarizeUsage} from './usage.js';
import {cleanProvider} from './core.js';
import {sanitizeDetail} from './agent-detail.js';
export const HISTORY_PREFIX = 'ati.conversation.v1.';

export function conversationUrl(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('会话 ID 无效');
  return 'https://arena.ai/agent/' + sessionId;
}

export function cleanRecordProviders(record) {
  if(!record)return record;
  const result={...record,observations:(record.observations||[]).map(o=>({...o,provider:cleanProvider(o.provider)}))};
  if(record.runs)result.runs=record.runs.map(r=>({...r,spans:(r.spans||[]).map(s=>({...s,provider:cleanProvider(s.provider)}))}));
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
    const entry = {model: model.model.slice(0, 200), provider: cleanProvider(model.provider), runId: String(input.runId || '').slice(0, 128), spanId: String(model.spanId || '').slice(0, 128), partial: !!model.partial, firstSeen: time, lastSeen: time};
    const index = observations.findIndex(x => x.runId === entry.runId && x.model === entry.model && x.provider === entry.provider);
    if (index < 0) observations.push(entry);
    else observations[index] = {...entry, firstSeen: observations[index].firstSeen};
  }
  if (!observations.length) throw new Error('没有有效模型标签');
  const runs = mergeUsage(old?.runs, input.usage);
  for (const r of runs) { const prior = old?.runs?.find(x => x.runId === r.runId)?.detail; const d = sanitizeDetail(prior); if (d) r.detail = d; }
  return {schemaVersion: 1, sessionId: input.sessionId, url, title: String(input.title || old?.title || 'Arena 会话').slice(0, 300), firstSeen: old?.firstSeen || time, lastSeen: time, observations, runs, totals: summarizeUsage(runs)};
}

export function createHistoryStore(area) {
  let queue = Promise.resolve();
  return {
    save(input) {
      const work = queue.then(async () => {
        const key = HISTORY_PREFIX + input.sessionId;
        const old = (await area.get(key))[key];
        const record = mergeRecord(old, input);
        await area.set({[key]: record});
        return record;
      });
      queue = work.catch(() => {});
      return work;
    },
    saveDetail(sessionId, runId, detail) {
      const work = queue.then(async () => {
        conversationUrl(sessionId);
        const key = HISTORY_PREFIX + sessionId;
        const record = (await area.get(key))[key];
        if (!record || record.schemaVersion !== 1) throw new Error('会话记录不存在');
        const clean = sanitizeDetail(detail);
        if (!clean) throw new Error('span 详情无效');
        const run = (record.runs || []).find(r => r.runId === runId);
        if (!run) throw new Error('运行记录不存在');
        run.detail = clean;
        await area.set({[key]: record});
        return clean;
      });
      queue = work.catch(() => {});
      return work;
    },
    remove(sessionId) {
      const work = queue.then(async () => {
        conversationUrl(sessionId); // Validate before constructing a storage key.
        await area.remove(HISTORY_PREFIX + sessionId);
      });
      queue = work.catch(() => {});
      return work;
    },
    async get(sessionId) {
      const url = conversationUrl(sessionId);
      await queue;
      const key = HISTORY_PREFIX + sessionId;
      const record = (await area.get(key))[key];
      return record?.schemaVersion === 1 && record.sessionId === sessionId && record.url === url && Array.isArray(record.observations) ? cleanRecordProviders(record) : null;
    },
    async list() {
      await queue;
      const all = await area.get(null);
      return Object.entries(all).filter(([key, r]) => key.startsWith(HISTORY_PREFIX) && r?.schemaVersion === 1 && Array.isArray(r.observations))
        .map(([,r]) => cleanRecordProviders(r)).filter(r => { try { return r.url === conversationUrl(r.sessionId); } catch { return false; } })
        .sort((a,b) => b.lastSeen.localeCompare(a.lastSeen));
    }
  };
}

// Independent of captured records: deleting history must not re-arm auto rename.
export function createAutoRenameStore(area) {
  let queue=Promise.resolve();
  const enabledKey='ati.autoRename.enabled.v1';
  function enqueue(task){const work=queue.then(task);queue=work.catch(()=>{});return work;}
  return {
    get:()=>enqueue(async()=>({enabled:(await area.get(enabledKey))[enabledKey]===true})),
    set:enabled=>enqueue(async()=>{if(typeof enabled!=='boolean')throw Error('Invalid preference');await area.set({[enabledKey]:enabled});return {enabled};}),
    // One auto rename per session, plus at most one *upgrade*: a session first named with the server label may be renamed
    // once more when the Arena internal modelName (from span detail) becomes available. Never downgrades, never repeats.
    claim:(sessionId,{title,internal=false}={})=>enqueue(async()=>{
      conversationUrl(sessionId);
      const key='ati.autoRename.attempted.v1.'+sessionId;
      const data=await area.get(null);
      if(data[enabledKey]!==true)return false;
      const prev=data[key];
      if(prev){
        const prevInternal=prev&&typeof prev==='object'&&prev.internal===true;
        const prevTitle=prev&&typeof prev==='object'?prev.title:undefined;
        if(prevInternal||!internal||!title||prevTitle===title)return false;
      }
      await area.set({[key]:{title:typeof title==='string'?title.slice(0,200):null,internal:internal===true,at:new Date().toISOString()}});return true;
    })
  };
}

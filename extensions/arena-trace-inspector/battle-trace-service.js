import './battle-core.js';
import './battle-trace-core.js';
const C=globalThis.ArenaBattleCore,T=globalThis.ArenaBattleTrace;
export function createBattleTraceService({fetch:request,storage,tabs,ready=Promise.resolve(true)}){
 const store=T.createStore(storage),active=new Map();
 async function current(tabId,sessionId,signal){if(signal?.aborted)throw Error('Code trace 读取已取消');const tab=await tabs.get(tabId);if(C.sessionFromUrl(tab.pendingUrl||tab.url)!==sessionId)throw Error('会话已切换，未保存旧 trace');}
 async function body(url,options,signal,check,type){await check();const r=await request(url,{...options,redirect:'error',signal});await check();if(!r.ok)throw Error('Code trace 请求被拒绝（HTTP '+r.status+'）；自动读取已暂停');if(!r.headers.get('content-type')?.includes(type))throw Error('Code trace 响应类型不符；未继续查询');const reader=r.body.getReader(),decoder=new TextDecoder();let raw='',bytes=0;while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>6*1024*1024){await reader.cancel();throw Error('Code trace 响应超限');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();await check();return raw;}
 async function read(tabId,sessionId,force=false){
  if(!Number.isInteger(tabId)||!C.sessionFromUrl('https://arena.ai/c/'+sessionId))throw Error('Code trace 会话无效');if(active.has(tabId))throw Error('Code trace 正在读取，请等待');if(!await ready)throw Error('本地存储不可用');if(active.has(tabId))throw Error('Code trace 正在读取，请等待');
  const abort=new AbortController();active.set(tabId,abort);const timeout=setTimeout(()=>abort.abort(),90000),check=()=>current(tabId,sessionId,abort.signal);
  try{
   const raw=await body('https://arena.ai/c/'+sessionId,{credentials:'include',headers:{RSC:'1'}},abort.signal,check,'text/x-component');
   const all=T.bindings(raw,sessionId),done=all.filter(b=>b.status==='success'),rounds=[...new Set(done.map(b=>b.round))].sort((x,y)=>x-y);
   // Auto reads only the latest 2 rounds; manual (force) reads up to the latest 6. Pending messages are never read (resume/partial spans in progress).
   const keep=new Set(rounds.slice(force?-6:-2)),bindings=done.filter(b=>keep.has(b.round));const old=await store.get(sessionId);await check();
   if(!bindings.length)return {ok:true,status:all.length?'pending':'no-workflow',record:old,cached:true};
   let fetched=0;const runs=[];
   for(const binding of bindings){await check();const prior=old?.runs.find(r=>r.runId===binding.runId);if(prior&&(prior.messageId!==binding.messageId||prior.position!==binding.position||prior.evaluationId!==binding.evaluationId))throw Error('历史 trace 关联冲突');if(prior?.complete&&!force){runs.push(prior);continue;}
    let credentials;try{
     credentials=JSON.parse(await body('https://arena.ai/api/evaluation/webdev/'+encodeURIComponent(binding.messageId)+'/stream-credentials',{credentials:'include'},abort.signal,check,'application/json'));
     T.authorize(credentials,binding);const base='https://api.trigger.dev/api/v1/runs/'+encodeURIComponent(binding.runId),headers={Authorization:'Bearer '+credentials.publicAccessToken,Accept:'application/json'};
     const events=JSON.parse(await body(base+'/events',{credentials:'omit',headers},abort.signal,check,'application/json')),selection=T.selectEvents(events,binding.runId),spans=[];
     for(const event of selection.selected){T.authorize(credentials,binding);const detail=JSON.parse(await body(base+'/spans/'+event.spanId,{credentials:'omit',headers},abort.signal,check,'application/json'));spans.push(T.parseSpan(detail,event,binding.runId));}
     const complete=selection.complete&&!spans.some(s=>s.partial)&&['model','usage','cost'].every(k=>spans.some(s=>s.kind===k));runs.push({...binding,eventCount:selection.eventCount,complete,spans});fetched++;
    }finally{if(credentials)credentials.publicAccessToken='';}
   }
   await check();const record=await store.save({schemaVersion:1,source:'trigger-run-spans',mode:'battle',modality:'webdev',sessionId,observedAt:new Date().toISOString(),runs},check);await check();
   return {ok:true,status:'read',record,cached:fetched===0,limited:rounds.length>keep.size,pendingRuns:all.length-done.length,checkedAt:new Date().toISOString(),unchanged:!!old&&T.fingerprint(old)===T.fingerprint(record)};
  }catch(e){if(abort.signal.aborted)throw Error('Code trace 超时或会话已切换；保留历史，可手动重试');throw e instanceof SyntaxError?Error('Code trace 数据格式不符；未保存'):e;}
  finally{clearTimeout(timeout);if(active.get(tabId)===abort)active.delete(tabId);}
 }
 return {read,get:store.get,list:store.list,cancel:tabId=>active.get(tabId)?.abort()};
}

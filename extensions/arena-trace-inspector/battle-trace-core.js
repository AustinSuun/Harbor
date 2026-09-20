/* Battle Code trace: whitelist-only data, never credentials or full event payloads. */
(() => {
  const C=globalThis.ArenaBattleCore,PREFIX='ati.battle.trace.v1.';
  const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)?v:null;
  const runId=v=>typeof v==='string'&&/^run_[a-zA-Z0-9]{1,100}$/.test(v)?v:null;
  const spanId=v=>typeof v==='string'&&/^[a-f0-9]{16,32}$/.test(v)?v:null;
  const text=v=>typeof v==='string'&&!/[\u0000-\u001f\u007f]/.test(v)&&!v.includes('Bearer ')&&!/^eyJ[^ ]+\.[^ ]+\./.test(v)?v.slice(0,200):null;
  const counts=['inputTokens','outputTokens','totalTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens'];
  const amounts=['costUsd','effectiveCostUsd','chargedUsd','effectiveChargedUsd'];
  const labels=['modelId','modelName','apiModelName','provider','usageSource','costSource','costKind','modelVisibility','modelStatus','pricingStrategy','model','model_name'];
  const refs=['messageId','modelMessageId','modelBMessageId','parentAssistantMessageId'];
  const flags=['costIsFallback','costIsLongContext'];
  function properties(v={}){const out={};for(const k of counts)out[k]=Number.isSafeInteger(v?.[k])&&v[k]>=0?v[k]:null;for(const k of amounts)out[k]=typeof v?.[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0?v[k]:null;for(const k of labels)out[k]=text(v?.[k]);for(const k of refs)out[k]=id(v?.[k]);for(const k of flags)out[k]=typeof v?.[k]==='boolean'?v[k]:null;return out;}
  function kind(message){if(typeof message!=='string')return null;if(message.startsWith('Using webdev stream for '))return 'model';if(message==='token.usage.recorded')return 'usage';if(message==='spend.recorded')return 'cost';if(message==='webdev.call.trigger.task_execution')return 'task';if(/^\[(SUCCESS|FAILED)\] Code arena tool execution$/.test(message))return 'tool';return null;}
  function bindings(raw,sessionId){
    if(!C.sessionFromUrl('https://arena.ai/c/'+sessionId))throw Error('Battle 会话无效');
    const rows=C.flightRows(raw),seen=new WeakSet(),found=new Map();let visits=0;
    function resolve(v,n=0){if(n>30)return null;if(typeof v==='string'){const m=v.match(/^\$(?:@|L)?([a-f0-9]+)$/);if(m&&rows.has(m[1]))return resolve(rows.get(m[1]),n+1);}return v;}
    function walk(value,n=0){const v=resolve(value);if(!v||typeof v!=='object'||n>45||seen.has(v))return;seen.add(v);if(++visits>100000)throw Error('RSC 结构超限');
      const state=resolve(v.initialState);
      if(state?.id===sessionId&&state.mode==='battle'&&(state.modality===undefined||state.modality==='webdev')){
        const messages=resolve(state.messages);if(Array.isArray(messages))for(const val of messages){const m=resolve(val),meta=resolve(m?.metadata);if(m?.role!=='assistant'||m.evaluationSessionId!==sessionId||!id(m.id)||!['a','b'].includes(m.participantPosition))continue;
          const active=runId(m.activeWorkflowRunId),past=runId(meta?.workflowRunId);if(active&&past&&active!==past)throw Error('工作流关联冲突');const run=active||past;if(!run)continue;
          const b={messageId:m.id,evaluationId:id(m.evaluationId),position:m.participantPosition,runId:run,status:text(m.status),createdAt:typeof m.createdAt==='string'&&Number.isFinite(Date.parse(m.createdAt))?m.createdAt:null,metadataCostUsd:typeof meta?.cost?.actual?.totalCostUsd==='number'&&Number.isFinite(meta.cost.actual.totalCostUsd)&&meta.cost.actual.totalCostUsd>=0?meta.cost.actual.totalCostUsd:null,metadataTotalTokens:Number.isSafeInteger(meta?.usage?.totalTokens)&&meta.usage.totalTokens>=0?meta.usage.totalTokens:null};
          const old=found.get(b.messageId);if(old&&(old.runId!==run||old.position!==b.position||old.evaluationId!==b.evaluationId))throw Error('消息工作流关联冲突');found.set(b.messageId,b);
        }
      }
      for(const [k,x]of Object.entries(v))if(!['content','parts','metadata','headers','cookies','request','userMessage'].includes(k))walk(x,n+1);
    }
    for(const v of rows.values())walk(v);
    const out=[...found.values()].sort((x,y)=>(x.createdAt||'').localeCompare(y.createdAt||''));if(new Set(out.map(b=>b.runId)).size!==out.length)throw Error('A/B 不能复用同一个工作流');
    // Round index: cluster all successful bindings by createdAt (a turn's A/B messages are created within ms of each other; turns are seconds+ apart). evaluationId is session-level on arena.ai (verified 2026-09-16: identical across 3 rounds) so it cannot number turns; per-side counting would drift when one side lacks a run.
    if(out.every(b=>b.createdAt)){const sorted=[...out].sort((x,y)=>Date.parse(x.createdAt)-Date.parse(y.createdAt)||x.messageId.localeCompare(y.messageId));let round=0,last=null;for(const b of sorted){const t=Date.parse(b.createdAt);if(last===null||t-last>5000)round++;last=t;b.round=round;}}else for(const b of out)b.round=null;return out;
  }
  function authorize(credentials,binding,now=Date.now()/1000){
    if(credentials?.runId!==binding.runId||!runId(binding.runId)||typeof credentials.publicAccessToken!=='string'||credentials.publicAccessToken.length>16384)throw Error('运行凭据与消息不匹配');
    let c;try{const s=credentials.publicAccessToken.split('.');if(s.length!==3)throw Error();const b=s[1].replace(/-/g,'+').replace(/_/g,'/');c=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b+'='.repeat((4-b.length%4)%4)),x=>x.charCodeAt(0))));}catch{throw Error('运行授权格式无效');}
    const aud=Array.isArray(c.aud)?c.aud:[c.aud];
    if(c.pub!==true||c.iss!=='https://id.trigger.dev'||!aud.includes('https://api.trigger.dev')||!Number.isFinite(c.exp)||c.exp<=now+5)throw Error('运行授权无效或已过期');
    if(!Array.isArray(c.scopes)||!c.scopes.includes('read:runs:'+binding.runId)||c.scopes.filter(s=>typeof s==='string'&&s.startsWith('read:runs:')).some(s=>s!=='read:runs:'+binding.runId))throw Error('未取得精确的单运行读取授权');
    return {runId:binding.runId,expiresAt:c.exp};
  }
  function selectEvents(value,run){
    if(!Array.isArray(value?.events)||value.events.length>5000)throw Error('trace events 格式不符或超限');const selected=new Map();
    const root=value.events.find(e=>e.runId===run&&e.parentId===null&&e.message==='code-arena-webdev');if(!root)throw Error('不是已验证的 Code 工作流 trace');
    for(const e of value.events){const k=kind(e.message);if(e.runId!==run||!k)continue;if(!spanId(e.spanId))throw Error('span ID 无效');const item={spanId:e.spanId,message:e.message,kind:k,partial:e.isPartial!==false};const old=selected.get(e.spanId);if(old&&old.message!==item.message)throw Error('span 关联冲突');selected.set(e.spanId,item);}
    if(selected.size>24)throw Error('相关 span 超过单次读取上限 24；未自动扩大查询');
    return {eventCount:value.events.filter(e=>e.runId===run).length,complete:root.isPartial===false&&root.isError!==true&&root.isCancelled!==true,selected:[...selected.values()]};
  }
  function parseSpan(value,event,run){if(value?.runId!==run||value.spanId!==event.spanId||value.message!==event.message)throw Error('span 与运行不匹配');return {spanId:event.spanId,kind:event.kind,message:text(value.message),partial:event.partial||value.isPartial!==false,values:properties(value.properties)};}
  function sanitizeRecord(input){
    const sessionId=id(input?.sessionId);if(input?.schemaVersion!==1||input.source!=='trigger-run-spans'||!C.sessionFromUrl('https://arena.ai/c/'+sessionId)||input.mode!=='battle'||input.modality!=='webdev'||!Array.isArray(input.runs)||input.runs.length>200)throw Error('Code trace 记录无效');
    const seen=new Set();const runs=input.runs.map(r=>{if(!id(r.messageId)||!runId(r.runId)||!['a','b'].includes(r.position)||!Array.isArray(r.spans)||r.spans.length>24||seen.has(r.runId))throw Error('Code trace 关联无效');seen.add(r.runId);const spans=new Set();return {messageId:r.messageId,evaluationId:id(r.evaluationId),position:r.position,runId:r.runId,round:Number.isSafeInteger(r.round)&&r.round>0?r.round:null,metadataCostUsd:typeof r.metadataCostUsd==='number'&&Number.isFinite(r.metadataCostUsd)&&r.metadataCostUsd>=0?r.metadataCostUsd:null,metadataTotalTokens:Number.isSafeInteger(r.metadataTotalTokens)&&r.metadataTotalTokens>=0?r.metadataTotalTokens:null,complete:r.complete===true,eventCount:Number.isSafeInteger(r.eventCount)&&r.eventCount>=0?r.eventCount:null,spans:r.spans.map(s=>{if(!spanId(s.spanId)||!kind(s.message)||s.kind!==kind(s.message)||spans.has(s.spanId))throw Error('span 记录无效');spans.add(s.spanId);return {spanId:s.spanId,kind:s.kind,message:text(s.message),partial:s.partial!==false,values:properties(s.values)};})};});
    if(runs.some(r=>r.complete&&r.spans.some(s=>s.partial)))throw Error('不完整 span 不能标记完成');
    return {schemaVersion:1,source:'trigger-run-spans',mode:'battle',modality:'webdev',sessionId,url:'https://arena.ai/c/'+sessionId,observedAt:typeof input.observedAt==='string'&&Number.isFinite(Date.parse(input.observedAt))?input.observedAt:new Date().toISOString(),runs};
  }
  function fingerprint(r){const v=sanitizeRecord(r);return JSON.stringify({sessionId:v.sessionId,runs:v.runs.map(r=>({...r,spans:[...r.spans].sort((a,b)=>a.spanId.localeCompare(b.spanId))})).sort((a,b)=>a.runId.localeCompare(b.runId))});}
  function createStore(area){let queue=Promise.resolve();const serial=fn=>{const t=queue.then(fn);queue=t.catch(()=>{});return t;};const get=async sid=>{if(!C.sessionFromUrl('https://arena.ai/c/'+sid))throw Error('会话无效');const v=(await area.get(PREFIX+sid))[PREFIX+sid];try{return v?sanitizeRecord(v):null;}catch{return null;}};return {get:sid=>serial(()=>get(sid)),list:()=>serial(async()=>{const data=await area.get(null),out=[];for(const [k,v]of Object.entries(data))if(k.startsWith(PREFIX))try{out.push(sanitizeRecord(v));}catch{}return out.sort((a,b)=>b.observedAt.localeCompare(a.observedAt));}),save:(input,check=async()=>{})=>serial(async()=>{const r=sanitizeRecord(input),old=await get(r.sessionId);if(old){const map=new Map(old.runs.map(x=>[x.runId,x]));for(const run of r.runs){const prior=map.get(run.runId);if(prior&&(prior.messageId!==run.messageId||prior.position!==run.position||prior.evaluationId!==run.evaluationId))throw Error('存储运行关联冲突');map.set(run.runId,prior?.complete&&!run.complete?prior:run);}r.runs=[...map.values()];if(fingerprint(r)===fingerprint(old))return old;}const clean=sanitizeRecord(r);await check();await area.set({[PREFIX+r.sessionId]:clean});return clean;})};}
  const number=v=>v===null||v===undefined?'未提供':String(v);
  const money=v=>v===null||v===undefined?'未提供':v===0?'$0':v<1e-8?'$'+v.toExponential(6):'$'+v.toFixed(10).replace(/0+$/,'').replace(/\.$/,'');
  /* Attribution: every span that names a message must name THIS run's message; the paired id (modelBMessageId) must be the sibling, never used for position. */
  function attribution(run,siblings=[]){
    const own=run.messageId,issues=[];const sib=siblings.find(s=>s.runId!==run.runId&&s.round===run.round&&s.position!==run.position)?.messageId||null;
    const names=run.spans.map(s=>[s,s.values.messageId||s.values.modelMessageId||null]).filter(([,v])=>v);
    for(const [s,v] of names)if(v!==own)issues.push(s.kind+' span 指向其他消息');
    const paired=[...new Set(run.spans.map(s=>s.values.modelBMessageId).filter(Boolean))];
    if(paired.length>1)issues.push('配对消息 ID 不一致');else if(paired.length===1){if(paired[0]===own)issues.push('配对消息 ID 指向自身');else if(sib&&paired[0]!==sib)issues.push('配对消息 ID 不是同轮对侧');}
    const labelSets={modelName:new Set(),apiModelName:new Set(),provider:new Set()};
    for(const s of run.spans){const v=s.values;if(v.modelName)labelSets.modelName.add(v.modelName);if(v.model_name)labelSets.modelName.add(v.model_name);if(v.apiModelName)labelSets.apiModelName.add(v.apiModelName);if(v.model)labelSets.apiModelName.add(v.model);if(v.provider)labelSets.provider.add(v.provider);}
    const conflicts=Object.entries(labelSets).filter(([,set])=>set.size>1).map(([k])=>k);
    const spansWithLabel=run.spans.filter(s=>s.values.apiModelName||s.values.model).length;
    const parent=[...new Set(run.spans.map(s=>s.values.parentAssistantMessageId).filter(Boolean))];
    const prev=siblings.find(s=>s.position===run.position&&s.round===(run.round||0)-1)?.messageId||null;
    let chain='未提供';if(parent.length>1){chain='冲突';issues.push('上一轮指针不一致');}else if(parent.length===1){chain=prev?(parent[0]===prev?'与上一轮同侧一致':'与上一轮同侧不符'):'指向未在本会话记录的消息';if(prev&&parent[0]!==prev)issues.push('上一轮指针不符');}else if(run.round===1||!prev)chain=run.round===1?'首轮（无上一轮）':'未提供';
    return {checked:names.length,consistent:issues.length===0&&conflicts.length===0,issues,conflicts,labelSpans:spansWithLabel,pairedMessageId:paired[0]||null,parentMessageId:parent[0]||null,chain};
  }
  function view(run,siblings=[]){
    const unique=k=>[...new Set(run.spans.map(s=>s.values[k]).filter(Boolean))].join(' / ')||'未提供';
    const usages=run.spans.filter(s=>s.kind==='usage'),costs=run.spans.filter(s=>s.kind==='cost'),tools=run.spans.filter(s=>s.kind==='tool');const u=usages.length===1?usages[0].values:{},c=costs.length===1?costs[0].values:{};
    const a=attribution(run,siblings);const failedTools=tools.filter(s=>s.message.startsWith('[FAILED]')).length;
    const same=(x,y)=>x!==null&&y!==null&&Math.abs(x-y)<=1e-12;
    const metaCost=run.metadataCostUsd,metaTok=run.metadataTotalTokens;
    const costCompare=c.costUsd===null||c.costUsd===undefined?'trace 未提供':metaCost===null?'metadata 未提供':same(c.costUsd,metaCost)?'与 metadata 一致（同一数据，只计一次）':'与 metadata 不一致：'+money(metaCost);
    const tokCompare=u.totalTokens===null||u.totalTokens===undefined?'trace 未提供':metaTok===null?'metadata 未提供':u.totalTokens===metaTok?'与 metadata 一致':'与 metadata 不一致：'+metaTok;
    const title=run.position.toUpperCase()+(run.round?' · 第 '+run.round+' 轮':'')+' · '+unique('modelName');
    return {title,rows:[
      ['API 配置标签',unique('apiModelName')+(a.labelSpans>1?'（'+a.labelSpans+' 处 span 一致）':'')+(a.conflicts.length?'（冲突：'+a.conflicts.join('、')+'）':'')],
      ['执行日志 provider',unique('provider')],
      ['目录 modelId',unique('modelId')],
      ['配置可见性 / 状态',(u.modelVisibility||'未提供')+' / '+(u.modelStatus||'未提供')+(u.modelVisibility==='private'?'（不在公开目录）':'')],
      ['归属校验',a.consistent?'一致（'+a.checked+' 处消息 ID 均为本侧）':'不确定：'+[...a.issues,...a.conflicts.map(k=>k+' 不一致')].join('；')],
      ['同侧上一轮',a.chain],
      ['工具调用',tools.length?tools.length+' 次'+(failedTools?'（失败 '+failedTools+' 次，模型标签不变）':''):'未提供'],
      ['输入 / 输出 Token',number(u.inputTokens)+' / '+number(u.outputTokens)],
      ['缓存读（已含于总量） / 推理（未含于总量）',number(u.cacheReadTokens)+' / '+number(u.reasoningTokens)],
      ['总 Token（日志值）',number(u.totalTokens)+' · '+tokCompare],
      ['模型成本 costUsd',money(c.costUsd)+' · '+costCompare],
      ['平台 effectiveCostUsd（含义未公布）',money(c.effectiveCostUsd)],
      ['用户实付 chargedUsd',money(c.chargedUsd)],
      ['价格来源 costSource（非调用链路）',c.costSource||'未提供'],
      ['定价策略',c.pricingStrategy||'未提供'],
      ['runId',run.runId]],
      warning:(run.complete?'已完成快照。':'运行未完成／结果不完整，请稍后手动刷新。')+(usages.length>1||costs.length>1?' 存在多条用量／费用事件，不自动求和，请展开查看。':' 推理 Token 不另加到总量；costUsd 是模型成本，不是用户收费。')+(c.costIsFallback===true||c.costSource==='unpriced'?' 未定价／回退值不能证明调用免费。':'')+(a.consistent?'':' 归属存在疑点，请勿据此判断 A/B。'),
      attribution:a,
      details:run.spans.map(s=>({title:s.message+' · '+s.spanId,rows:Object.entries(s.values).filter(([,v])=>v!==null).map(([k,v])=>['properties.'+k,typeof v==='number'&&amounts.includes(k)?money(v):String(v)])}))};
  }
  globalThis.ArenaBattleTrace={PREFIX,bindings,authorize,selectEvents,parseSpan,sanitizeRecord,properties,fingerprint,createStore,view,attribution,kind};
})();

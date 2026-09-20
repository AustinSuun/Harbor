/* Pure Battle adapter: parse server RSC data only after feedback reveals a pair. */
(() => {
  const PREFIX='ati.battle.v1.';
  const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x)?x:null;
  const text=(x,max=200)=>typeof x==='string'&&!/[\u0000-\u001f\u007f]/.test(x)?x.slice(0,max):'';
  // Only these explicit usage/cost/timing fields may cross the storage boundary.
  const tokenKeys=['inputTokens','outputTokens','totalTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens'];
  const actualKeys=['totalCostUsd','inputTokensCostUsd','outputTokensCostUsd','cacheReadTokensCostUsd','cacheWriteTokensCostUsd'];
  const chargeKeys=['basePriceUsd','totalChargedUsd','totalChargedCredits','costMultiplier','discountPercent','marginMultiplier'];
  const timingKeys=['streamDurationMs','timeToFirstTokenMs','timeToFirstContentTokenMs','timeToFirstReasoningTokenMs','timeToStreamCompleteMs'];
  const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
  const amount=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
  const flag=x=>typeof x==='boolean'?x:null;
  const label=x=>text(x,100)||null;
  const pick=(o,keys,clean)=>Object.fromEntries(keys.map(k=>[k,clean(o?.[k])]));
  function sanitizeCallData(input){
    if(input?.schemaVersion!==1||input.source!=='battle-message-metadata')return null;
    const usage={...pick(input.usage,tokenKeys,count),usageSource:label(input.usage?.usageSource)};
    const actual={...pick(input.cost?.actual,actualKeys,amount),source:label(input.cost?.actual?.source),isFallback:flag(input.cost?.actual?.isFallback),isLongContext:flag(input.cost?.actual?.isLongContext)};
    const cost={actual,...pick(input.cost,chargeKeys,amount),pricingStrategy:label(input.cost?.pricingStrategy)};
    const timing=pick(input.timing,timingKeys,amount),aiSdkVersion=label(input.aiSdkVersion);
    if(![...Object.values(usage),...Object.values(actual),...chargeKeys.map(k=>cost[k]),cost.pricingStrategy,...Object.values(timing),aiSdkVersion].some(v=>v!==null))return null;
    return {schemaVersion:1,source:'battle-message-metadata',usagePath:input.usagePath==='metadata (legacy)'?'metadata (legacy)':'metadata.usage',usage,cost,timing,aiSdkVersion};
  }
  function extractCallData(value,resolve=x=>x){
    const obj=v=>{const o=resolve(v);return o&&typeof o==='object'&&!Array.isArray(o)?o:{};};
    const m=obj(value),nested=resolve(m.usage),hasUsage=nested&&typeof nested==='object'&&!Array.isArray(nested);
    const u=hasUsage?nested:m,c=obj(m.cost),a=obj(c.actual);
    const select=(o,keys)=>Object.fromEntries(keys.map(k=>[k,resolve(o[k])]));
    return sanitizeCallData({schemaVersion:1,source:'battle-message-metadata',usagePath:hasUsage?'metadata.usage':'metadata (legacy)',
      usage:select(u,[...tokenKeys,'usageSource']),cost:{...select(c,[...chargeKeys,'pricingStrategy']),actual:select(a,[...actualKeys,'source','isFallback','isLongContext'])},
      timing:select(m,timingKeys),aiSdkVersion:resolve(m.aiSdkVersion)});
  }
  function callDataView(value,historical=false){
    const d=sanitizeCallData(value);if(!d)return {source:'调用数据未提供 · 旧记录可重新读取补充',rows:[],details:[],warning:''};
    const n=x=>x===null?'未提供':String(x);
    const usd=x=>x===null?'未提供':x===0?'$0':x<0.00000001?'$'+x.toExponential(6):'$'+x.toFixed(10).replace(/0+$/,'').replace(/\.$/,'');
    const u=d.usage,c=d.cost,a=c.actual;
    const uncertain=a.source==='unpriced'||a.isFallback===true;
    const reported=usd(a.totalCostUsd)+(a.source==='unpriced'?'（未定价）':a.isFallback===true?'（回退值）':'');
    return {source:(historical?'历史调用数据 · 本次未重新取得 · ':'调用数据 · ')+'Battle 消息元数据（非 trace）',
      rows:[['输入 / 输出 Token',n(u.inputTokens)+' / '+n(u.outputTokens)],['总 Token（服务器值）',n(u.totalTokens)],['推理 Token（未含于总量）',n(u.reasoningTokens)],['缓存读（已含于总量） / 写 Token',n(u.cacheReadTokens)+' / '+n(u.cacheWriteTokens)],['用量来源',u.usageSource||'未提供'],['模型成本 totalCostUsd（= trace costUsd）',reported],['价格来源 source（非调用链路）',a.source||'未提供'],['用户实付 totalChargedUsd',usd(c.totalChargedUsd)+(c.totalChargedUsd===0&&c.discountPercent===1?'（100% 折扣，非缺失）':c.totalChargedUsd===0&&c.costMultiplier===0?'（成本倍率 0，非缺失）':'')],['定价策略',c.pricingStrategy||'未提供'],['流式耗时 ms',n(d.timing.streamDurationMs)]],
      details:[['成本回退标记',a.isFallback===null?'未提供':a.isFallback?'是':'否'],['长上下文定价',a.isLongContext===null?'未提供':a.isLongContext?'是':'否'],['输入成本 USD',usd(a.inputTokensCostUsd)],['输出成本 USD',usd(a.outputTokensCostUsd)],['缓存读取成本 USD',usd(a.cacheReadTokensCostUsd)],['缓存写入成本 USD',usd(a.cacheWriteTokensCostUsd)],['基础价格 basePriceUsd（含义未公布）',usd(c.basePriceUsd)],['收费 Credits',n(c.totalChargedCredits)],['成本倍率 / 利润倍率',n(c.costMultiplier)+' / '+n(c.marginMultiplier)],['折扣比例（原始字段）',n(c.discountPercent)],...timingKeys.filter(k=>k!=='streamDurationMs').map(k=>[k+' (ms)',n(d.timing[k])]),['AI SDK',d.aiSdkVersion||'未提供'],['用量字段路径',d.usagePath]],
      warning:uncertain?'未定价／回退成本不能证明真实调用免费。':'模型成本不等于用户实付；与同一消息的 Code trace costUsd 是同一数据，只计一次；推理 Token 不叠加到服务器总量。'};
  }
  function sessionFromUrl(raw){try{const u=new URL(raw);return u.origin==='https://arena.ai'?u.pathname.match(/^\/c\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null:null;}catch{return null;}}
  function sanitizeRecord(input){
    const sessionId=id(input?.sessionId);if(!sessionId||!sessionFromUrl('https://arena.ai/c/'+sessionId))throw Error('Battle 会话 ID 无效');
    if(input?.source!=='official-reveal-rsc'||!Array.isArray(input.pairs)||!input.pairs.length||input.pairs.length>100)throw Error('没有已确认的 Battle 揭示记录');
    const pairs=input.pairs.map(p=>{
      if(!id(p.feedbackId)||!Array.isArray(p.sides)||p.sides.length!==2)throw Error('Battle A/B 数据不完整');
      const sides=['a','b'].map(position=>{
        const m=p.sides.find(x=>x.position===position);if(!m||!id(m.messageId)||!id(m.modelId)||!text(m.displayName))throw Error('Battle 型号关联不完整');
        return {position,messageId:m.messageId,evaluationId:id(m.evaluationId),modelId:m.modelId,displayName:text(m.displayName),name:text(m.name),publicName:text(m.publicName),provider:text(m.provider,100),organization:text(m.organization,100),callData:sanitizeCallData(m.callData),callDataHistorical:!!sanitizeCallData(m.callData)&&m.callDataHistorical===true};
      });
      if(sides[0].messageId===sides[1].messageId)throw Error('Battle A/B 消息重复');
      return {feedbackId:p.feedbackId,vote:text(p.vote,40),sides};
    });
    return {schemaVersion:1,mode:'battle',sessionId,url:'https://arena.ai/c/'+sessionId,source:'official-reveal-rsc',observedAt:typeof input.observedAt==='string'&&Number.isFinite(Date.parse(input.observedAt))?input.observedAt:new Date().toISOString(),pairs};
  }
function flightRows(raw){
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>6*1024*1024)throw Error('Battle RSC 响应超限');
 const bytes=new TextEncoder().encode(raw),decode=new TextDecoder(),rows=new Map();let p=0;
 while(p<bytes.length){
  if(bytes[p]===10||bytes[p]===13){p++;continue;}
  const colon=bytes.indexOf(58,p);if(colon<0||colon-p>16)throw Error('Unsupported Flight frame');
  const id=decode.decode(bytes.subarray(p,colon));if(!id){const e=bytes.indexOf(10,colon);p=e<0?bytes.length:e+1;continue;}if(!/^[a-f0-9]+$/.test(id))throw Error('Unsupported Flight row ID');
  const start=colon+1;
  if(bytes[start]===84){const comma=bytes.indexOf(44,start);if(comma<0)throw Error('Incomplete text header');const hex=decode.decode(bytes.subarray(start+1,comma));if(!/^[a-f0-9]+$/.test(hex))throw Error('Invalid text length');const length=parseInt(hex,16),end=comma+1+length;if(end>bytes.length)throw Error('Truncated text');rows.set(id,decode.decode(bytes.subarray(comma+1,end)));p=end;}
  else{let end=bytes.indexOf(10,start);if(end<0)end=bytes.length;const body=decode.decode(bytes.subarray(start,end));try{rows.set(id,JSON.parse(body));}catch{}p=end+1;}
 }
 return rows;
}
  function parseFlight(raw,sessionId){
    if(typeof raw!=='string'||raw.length>6*1024*1024)throw Error('Battle RSC 响应超限');
    if(!sessionFromUrl('https://arena.ai/c/'+sessionId))throw Error('Battle 会话 ID 无效');
    let rows;try{rows=flightRows(raw);}catch{return {status:'unsupported',message:'Battle RSC 帧格式不符；未读取或猜测型号'};}
    function resolve(v,depth=0){if(depth>32)return null;if(typeof v==='string'){const m=v.match(/^\$(?:@|L)?([0-9a-f]+)$/);if(m&&rows.has(m[1]))return resolve(rows.get(m[1]),depth+1);}return v;}
    const models=new Map(),states=[],actions=[],seen=new WeakSet();let visited=0;
    function directory(value){const v=resolve(value);if(Array.isArray(v)){for(const item of v)directory(item);return;}if(v&&typeof v==='object'&&id(v.id)&&text(v.displayName)){const clean={modelId:v.id,displayName:text(v.displayName),name:text(v.name),publicName:text(v.publicName),provider:text(v.provider,100),organization:text(v.organization,100)};const old=models.get(v.id);if(old&&JSON.stringify(old)!==JSON.stringify(clean))throw Error('模型目录存在冲突');models.set(v.id,clean);}}
    function walk(value,depth=0){const v=resolve(value);if(!v||typeof v!=='object'||depth>48||seen.has(v))return;seen.add(v);if(++visited>100000)throw Error('Battle RSC 结构超限');
      if(Array.isArray(v)){for(const item of v)walk(item,depth+1);return;}
      if(v.initialState){const s=resolve(v.initialState);if(s?.id===sessionId&&s.mode==='battle')states.push(s);}
      if(v.initialModels)directory(v.initialModels);
      const data=resolve(v.data);if(data?.messageAId&&data?.messageBId&&data?.modelAId&&data?.modelBId)actions.push(data);
      for(const [key,val] of Object.entries(v)){if(['content','parts','metadata','userMessage','request','headers','cookies'].includes(key))continue;walk(val,depth+1);}
    }
    for(const value of rows.values())walk(value);
    if(!states.length)return {status:'unsupported',message:'尚未取得当前 Battle 会话的官方数据；不会套用 Agent 检测'};
    const pairs=new Map();
    for(const state of states){
      const ms=resolve(state.messages),fs=resolve(state.pairwiseFeedbacks);if(!Array.isArray(ms)||!Array.isArray(fs))continue;
      const messages=new Map(ms.map(m=>resolve(m)).filter(m=>m?.role==='assistant'&&m.evaluationSessionId===sessionId&&id(m.id)).map(m=>[m.id,m]));
      for(const fv of fs){const f=resolve(fv);if(!f||!id(f.id)||!f.value)continue;
        const a=messages.get(f.messageAId),b=messages.get(f.messageBId);if(!a||!b)continue;
        if(a.participantPosition!=='a'||b.participantPosition!=='b'||a.id===b.id)throw Error('官方 A/B 位置关联冲突');
        if(a.modelId!==f.modelAId||b.modelId!==f.modelBId)throw Error('官方揭示与消息型号关联不一致；未保存');
        if(a.pairwiseFeedbackId&&a.pairwiseFeedbackId!==f.id||b.pairwiseFeedbackId&&b.pairwiseFeedbackId!==f.id)throw Error('反馈与消息关联冲突');
        const action=actions.find(x=>x.messageAId===a.id&&x.messageBId===b.id);if(action&&(action.modelAId!==a.modelId||action.modelBId!==b.modelId))throw Error('投票返回结果与会话数据冲突');
        const ma=models.get(a.modelId),mb=models.get(b.modelId);if(!ma||!mb)continue;
        pairs.set(f.id,{feedbackId:f.id,vote:f.value,sides:[{position:'a',messageId:a.id,evaluationId:a.evaluationId,...ma,callData:extractCallData(a.metadata,resolve)},{position:'b',messageId:b.id,evaluationId:b.evaluationId,...mb,callData:extractCallData(b.metadata,resolve)}]});
      }
    }
    if(!pairs.size)return {status:'unrevealed',message:'尚未确认官方揭示；请按实际回答评分，官方揭示后会自动读取。不会根据投票请求 ID 猜型号。'};
    return {status:'revealed',record:sanitizeRecord({sessionId,source:'official-reveal-rsc',observedAt:new Date().toISOString(),pairs:[...pairs.values()]})};
  }
  function fingerprint(input){
    const r=sanitizeRecord(input);return JSON.stringify({sessionId:r.sessionId,pairs:[...r.pairs].sort((a,b)=>a.feedbackId.localeCompare(b.feedbackId))});
  }
  function createStore(area){let queue=Promise.resolve();const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};return {
    save:input=>serial(async()=>{
      const r=sanitizeRecord(input),key=PREFIX+r.sessionId,stored=(await area.get(key))[key];let old=null;
      try{if(stored)old=sanitizeRecord(stored);}catch{}
      if(old){
        const pairs=new Map(old.pairs.map(p=>[p.feedbackId,p]));
        for(const p of r.pairs){const prior=pairs.get(p.feedbackId);
          if(prior&&p.sides.some((m,i)=>m.messageId!==prior.sides[i].messageId||m.modelId!==prior.sides[i].modelId))throw Error('同一反馈的身份关联发生冲突');
          if(prior)for(const [i,m] of p.sides.entries())if(!m.callData&&prior.sides[i].callData){m.callData=prior.sides[i].callData;m.callDataHistorical=true;}
          pairs.set(p.feedbackId,p);
        }
        r.pairs=[...pairs.values()];
        if(fingerprint(old)===fingerprint(r))return old;
      }
      const clean=sanitizeRecord(r);await area.set({[key]:clean});return clean;
    }),
    get:sessionId=>serial(async()=>{if(!sessionFromUrl('https://arena.ai/c/'+sessionId))throw Error('会话 ID 无效');const v=(await area.get(PREFIX+sessionId))[PREFIX+sessionId];if(!v)return null;try{return sanitizeRecord(v);}catch{return null;}}),
    list:()=>serial(async()=>{const all=await area.get(null),out=[];for(const [k,v] of Object.entries(all)){if(!k.startsWith(PREFIX))continue;try{out.push(sanitizeRecord(v));}catch{}}return out.sort((a,b)=>b.observedAt.localeCompare(a.observedAt));})
  };}
  globalThis.ArenaBattleCore={PREFIX,sessionFromUrl,flightRows,parseFlight,sanitizeRecord,sanitizeCallData,extractCallData,callDataView,fingerprint,createStore};
})();

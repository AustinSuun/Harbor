/* Battle-only content UI. Reads normal same-origin RSC; never sends messages or votes. */
(() => {
  let host,root,message,body,readButton,exportButton,record=null,historical=false,currentPath='',version=0,busy=false,controller=null,timer,lastReadAt=null,needsRetry=false;
  const core=ArenaBattleCore;
  let traceRecord=null,traceHistorical=true,traceBusy=false,traceVersion=0,traceButton,traceBody,traceMessage;
  let traceStatus='Code 工作流可读取执行 trace；纯文字没有工作流时不会套用此链路。';
  function resetTrace(){traceVersion++;traceBusy=false;traceRecord=null;traceHistorical=true;traceStatus='Code 工作流可读取执行 trace；纯文字没有工作流时不会套用此链路。';}
  function renderTrace(){if(!traceBody)return;traceButton.disabled=traceBusy||!core.sessionFromUrl(location.href);traceButton.textContent=traceBusy?'Code trace 读取中…':'读取 Code trace';traceMessage.textContent=traceStatus;ArenaBattleTraceUI.render(traceBody,traceRecord,traceHistorical);}
  async function readTrace(force=true){
    const sessionId=core.sessionFromUrl(location.href);if(!sessionId||!battlePage()||traceBusy)return;
    traceBusy=true;const ticket=++traceVersion;traceStatus='正在核验当前 Code 工作流授权并读取 trace…';renderTrace();
    try{const r=await chrome.runtime.sendMessage({type:'ATI_BATTLE_TRACE_READ',sessionId,pageUrl:location.href,force});if(ticket!==traceVersion||core.sessionFromUrl(location.href)!==sessionId||!battlePage())return;if(r?.error)throw Error(r.error);if(!r?.ok)throw Error('Code trace 读取失败');traceRecord=r.record||null;traceHistorical=!!r.cached;
      traceStatus=r.status==='no-workflow'?'该会话无执行 trace 入口（纯文字 Battle 不经 Trigger.dev，2026-09-16 验证）；Token/费用请看官方 metadata 区域。':r.status==='pending'?'Code 工作流尚在生成（刷新恢复中亦不读取，避免部分 span）；完成后可点击读取。':r.cached?'已核对会话关联，复用已完成 trace；手动读取可重新验证。':r.unchanged?'Code trace 已核对，数据未变化；未重复保存。':'Code trace 已读取并保存；令牌仅在内存使用。';if(r.limited)traceStatus+=force?' 手动读取最多覆盖最近 6 轮，更早轮次保留历史。':' 自动读取仅覆盖最近 2 轮；点击“读取 Code trace”可扩展到最近 6 轮。';if(r.pendingRuns)traceStatus+=' 另有 '+r.pendingRuns+' 个运行尚未完成。';
    }catch(e){if(ticket===traceVersion){traceHistorical=true;traceStatus=(e.message||'Code trace 读取失败')+'；保留历史，可手动重试。';}}
    finally{if(ticket===traceVersion){traceBusy=false;renderTrace();}}
  }
  const automatic=ArenaBattleAuto.create({read:options=>read(options)});
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const battlePage=()=>{
    const modes=[...document.querySelectorAll('main button[role="combobox"]')].filter(b=>b.getClientRects().length);
    const isBattle=modes.some(b=>b.textContent.trim()==='Battle Mode');
    return !!core.sessionFromUrl(location.href)?!modes.length||isBattle:['/','/text','/code'].includes(location.pathname)&&isBattle;
  };
  function render(){if(!host)return;renderTrace();body.replaceChildren();readButton.disabled=busy||!core.sessionFromUrl(location.href);readButton.textContent=busy?'读取中…':needsRetry?'重试读取':'重新读取';
    if(!record){body.append(el('p','muted','等待评分／官方揭示。揭示后自动读取并保存 A/B 型号；不会自动提问或投票。'));return;}
    body.append(el('p','source',historical?'本地历史 · 非重新验证':'本次读取 · 官方揭示后数据'));
    for(const [i,p] of record.pairs.entries()){
      if(record.pairs.length>1)body.append(el('h3','',`对比 ${i+1}`));
      for(const m of p.sides){const card=el('article','model-card');card.append(el('small','position','模型 '+m.position.toUpperCase()),el('h3','',m.displayName));
        for(const [label,value] of [['配置名 name',m.name],['公开名 publicName',m.publicName],['目录供应商',m.provider],['目录组织',m.organization],['modelId',m.modelId]])card.append(el('p','field',label+'：'+(value||'未提供')));
        const view=core.callDataView(m.callData,historical||m.callDataHistorical);
        const calls=el('section','call-data');calls.append(el('p','source',view.source));
        for(const [label,value] of view.rows)calls.append(el('p','field',label+'：'+value));
        if(view.details.length){const detail=el('details');detail.append(el('summary','','成本分项与耗时证据'));for(const [label,value] of view.details)detail.append(el('p','field',label+'：'+value));calls.append(detail);}
        if(view.warning)calls.append(el('p','muted',view.warning));card.append(calls);
        body.append(card);
      }
      body.append(el('p','muted','投票值：'+p.vote+' · 按消息 ID 与 participantPosition 对齐'));
    }
    body.append(el('p','muted','保存时间：'+new Date(record.observedAt).toLocaleString()+(lastReadAt?' · 本次核对：'+new Date(lastReadAt).toLocaleTimeString():'')),el('p','muted','名称来自 Arena 官方目录，不等同于供应商 API 原始型号或底层权重证明。'));
  }
  function mount(){host=el('div');host.id='arena-battle-inspector-hud';host.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647';root=host.attachShadow({mode:'closed'});const style=el('style');style.textContent=`:host{all:initial}.panel{width:360px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto;background:#111c22;color:#e0eee8;border:1px solid #496b64;border-radius:14px;padding:16px;box-sizing:border-box;font:12px/1.6 system-ui,sans-serif;box-shadow:0 10px 35px #0005}h2{font-size:15px;margin:0}h3{font-size:17px;color:#a5ebcc;margin:4px 0;overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}button{cursor:pointer;border:1px solid #426453;background:#1c372c;color:#d0efdf;border-radius:6px;padding:6px 9px;font:11px system-ui}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid #a5ebcc}.model-card{border:1px solid #345146;border-radius:9px;background:#162920;padding:12px;margin:9px 0}.call-data{border-top:1px solid #345146;margin-top:12px;padding-top:8px}.call-data summary{font-size:11px;margin:8px 0}.field{font:10px/1.65 ui-monospace,monospace;margin:4px 0;overflow-wrap:anywhere}.muted{font-size:10px;color:#94aca5}.source,.position{color:#a5ebcc;font-size:10px}.status{color:#b9d6ca;font-size:11px;overflow-wrap:anywhere}summary{cursor:pointer;list-style:none}summary:after{content:'  ▾';float:right}`;
    const panel=el('details','panel');panel.open=true;const title=el('summary','','Arena · Battle Inspector');const actions=el('div','actions');readButton=el('button','','读取官方揭示');readButton.type='button';readButton.addEventListener('click',()=>void automatic.manual());exportButton=el('button','','导出 Battle 记录');exportButton.type='button';exportButton.addEventListener('click',async()=>{try{const r=await chrome.runtime.sendMessage({type:'ATI_BATTLE_LIST'});if(r?.error)throw Error(r.error);const traces=await chrome.runtime.sendMessage({type:'ATI_BATTLE_TRACE_LIST',sessionId:core.sessionFromUrl(location.href),pageUrl:location.href});if(traces?.error)throw Error(traces.error);const u=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:1,mode:'battle',exportedAt:new Date().toISOString(),records:r.records||[],codeTraces:traces.records||[]},null,2)],{type:'application/json'}));const a=el('a');a.href=u;a.download='arena-battle-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){message.textContent=e.message||'导出失败';}});traceButton=el('button','','读取 Code trace');traceButton.type='button';traceButton.addEventListener('click',()=>void readTrace(true));actions.append(readButton,traceButton,exportButton);message=el('p','status');message.setAttribute('role','status');body=el('div');traceMessage=el('p','status');traceMessage.setAttribute('role','status');traceBody=el('div');panel.append(title,actions,message,body,el('h3','','Code 执行 trace'),traceMessage,traceBody);root.append(style,panel);document.documentElement.append(host);render();}
  async function read(options={}){
    const sessionId=core.sessionFromUrl(location.href);
    if(!sessionId||busy||!battlePage()||options.sessionId&&options.sessionId!==sessionId)return {status:'stale'};
    busy=true;needsRetry=false;const ticket=++version;controller=new AbortController();const abort=controller;
    const timeout=setTimeout(()=>abort.abort(),15000);message.textContent=options.automatic?'正在自动核对官方揭示…':'只读获取当前会话的官方 RSC 数据…';render();
    try{
      const response=await fetch('/c/'+sessionId,{method:'GET',headers:{RSC:'1'},credentials:'same-origin',redirect:'error',signal:abort.signal});
      if(!response.ok)throw Error('读取失败（HTTP '+response.status+'），自动读取已暂停；请检查页面后手动重试');
      if(!response.headers.get('content-type')?.includes('text/x-component'))throw Error('响应不是预期 RSC 数据，自动读取已暂停');
      const reader=response.body.getReader(),decoder=new TextDecoder();let raw='',bytes=0;
      while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>6*1024*1024){await reader.cancel();throw Error('RSC 响应超限');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
      if(ticket!==version||core.sessionFromUrl(location.href)!==sessionId)return {status:'stale'};
      const workflows=ArenaBattleTrace.bindings(raw,sessionId);if(workflows.some(b=>b.status==='success'))void readTrace(false);
      const parsed=core.parseFlight(raw,sessionId);raw='';
      if(parsed.status!=='revealed'){needsRetry=parsed.status==='unsupported';message.textContent=parsed.message;return {status:parsed.status};}
      const unchanged=record&&core.fingerprint(record)===core.fingerprint(parsed.record);
      let saved=null;
      if(!unchanged)saved=await chrome.runtime.sendMessage({type:'ATI_BATTLE_SAVE',pageUrl:location.href,record:parsed.record});
      if(ticket!==version||core.sessionFromUrl(location.href)!==sessionId)return {status:'stale'};
      if(!unchanged&&(!saved?.ok||!saved?.record)){
        // Do not treat a displayed-but-unsaved result as persisted on the next retry.
        needsRetry=true;message.textContent='已读取官方揭示，但本地保存失败；请点击重试读取';
        return {status:'error'};
      }
      lastReadAt=new Date().toISOString();historical=false;
      if(!unchanged)record=saved.record;
      message.textContent=unchanged?'官方揭示已核对，数据未变化；未重复保存':'官方揭示已自动读取并保存；未保存正文或原始 RSC';
      return {status:'revealed',unchanged:!!unchanged};
    }catch(e){if(ticket===version){needsRetry=true;message.textContent=e.name==='AbortError'?'读取超时或取消，自动读取已暂停；保留已有记录，可手动重试':e.message||'读取失败';}return {status:ticket===version?'error':'stale'};}
    finally{clearTimeout(timeout);if(ticket===version){busy=false;render();}}
  }
  async function sync(){const path=location.pathname;if(!battlePage()){resetTrace();automatic.enter(null);version++;controller?.abort();host?.remove();host=null;currentPath='';busy=false;record=null;return;}
    if(currentPath===path&&host?.isConnected)return;resetTrace();automatic.enter(null);currentPath=path;const ticket=++version;controller?.abort();busy=false;record=null;historical=false;lastReadAt=null;needsRetry=false;host?.remove();mount();const sessionId=core.sessionFromUrl(location.href);message.textContent=sessionId?'等待评分／官方揭示；揭示后自动读取':'Battle 模式 · 请正常提问并按实际回答评分';
    if(sessionId){const tt=traceVersion;void chrome.runtime.sendMessage({type:'ATI_BATTLE_TRACE_GET',sessionId,pageUrl:location.href}).then(r=>{if(tt===traceVersion&&r?.record){traceRecord=r.record;traceHistorical=true;renderTrace();}}).catch(()=>{});try{const r=await chrome.runtime.sendMessage({type:'ATI_BATTLE_GET',sessionId,pageUrl:location.href});if(ticket!==version)return;if(r?.record){record=r.record;historical=true;render();}}catch{}
      if(ticket===version)automatic.enter(sessionId);
    }
  }
  const voteLabels=new Set(['A is better','B is better','Both good','Both bad','Tie','A 更好','B 更好','A更好','B更好','左边更好','右边更好','都好','都不好']);
  let voteVisible=false,revealSignature='';
  function watchVoteControls(){
    if(!core.sessionFromUrl(location.href)||!battlePage()){voteVisible=false;revealSignature='';return;}
    const buttons=[...document.querySelectorAll('main button')];
    const visible=buttons.some(b=>b.getClientRects().length&&voteLabels.has(b.textContent.trim()));
    if(voteVisible&&!visible)automatic.trigger('vote');
    voteVisible=visible;
    // Observed official model-header layout; never use answer text as identity.
    const labels=[...document.querySelectorAll('main span.font-mono > span.truncate')]
      .filter(e=>e.getClientRects().length&&!e.closest('.prose'))
      .map(e=>e.textContent.trim()).filter(t=>t&&!/^(Assistant|助手)\s*[AB]$/i.test(t));
    const signature=labels.length>=2?location.pathname+'|'+JSON.stringify(labels):'';
    if(signature&&signature!==revealSignature){revealSignature=signature;automatic.trigger('vote');}
  }
  document.addEventListener('click',event=>{
    const b=event.target?.closest?.('button');
    if(b?.closest('main')&&voteLabels.has(b.textContent.trim())&&core.sessionFromUrl(location.href))automatic.trigger('vote');
  },true);
  const schedule=()=>{if(timer)return;timer=setTimeout(()=>{timer=null;void sync();watchVoteControls();},250);};
  const routeChanged=()=>{void sync();schedule();};
  window.navigation?.addEventListener('navigatesuccess',routeChanged);window.addEventListener('popstate',routeChanged);window.addEventListener('pageshow',schedule);new MutationObserver(schedule).observe(document,{childList:true,subtree:true});
  globalThis.ArenaBattleInspector={read,readTrace,sync,getState:()=>({record,historical,busy,traceRecord,traceBusy,traceStatus,needsRetry,lastReadAt,path:currentPath,automatic:automatic.state()})};void sync();
})();

/* Bounded, opt-in UI automation. Requires active listening; no send retries. */
(() => {
  let running=false,cancelled=false,progress='请先开启监听，再设置轮数并开始抽卡',phase='idle',sent=false,sessionId=null;
  let total=5,round=0,completed=0,failed=0,archived=0;
  let notify=()=>{},readState=()=>null;
  // 2.0.0: the message text and the keep-only filter come from ArenaDrawPrefs and are frozen for the whole job.
  let prompt='1+1=',keepOnly=false;
  const prefsApi=()=>globalThis.ArenaDrawPrefs||null;
  const visible=e=>!!e?.isConnected&&e.getClientRects().length>0;
  // Arena's mode trigger reads "Agent" while its option still reads "Agent ModeBuilt for complex tasks" (observed 2026-09-18).
  // Both are matched on the shared prefix, so a copy change on either side cannot break a run again.
  const MODE_PREFIX='Agent';
  const isMode=e=>e.textContent.trim().startsWith(MODE_PREFIX);
  const isDisabled=e=>e.hasAttribute('data-disabled')||e.getAttribute('aria-disabled')==='true';
  const combos=()=>[...document.querySelectorAll('button[role="combobox"]')].filter(visible);
  const modeReady=()=>combos().some(isMode);
  // Radix Select opens on pointerdown; a bare click() never opens it, so the menu stayed empty and the run timed out.
  function press(el){
    const o={bubbles:true,cancelable:true,composed:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
    el.dispatchEvent(new PointerEvent('pointerdown',{...o,buttons:1}));
    el.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));
    el.dispatchEvent(new MouseEvent('click',{...o,buttons:0}));
  }
  const session=()=>location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  const status=()=>({running,phase,progress,sent,sessionId,total,round,completed,failed,archived,prompt,keepOnly});
  const publish=(p,text)=>{phase=p;progress=text;notify(status());};
  // fatal: the job must stop (user draft, listening lost, navigation, cancel, unconfirmed send). Everything else is a
  // transient failure of one round: it is recorded and the next round proceeds, bounded by the round count and 3 consecutive failures.
  const fatal=m=>Object.assign(Error(m),{fatal:true});
  const generating=()=>visible(document.querySelector('button[aria-label="Stop generating"]'));
  function guard(){if(cancelled)throw fatal('已停止自动抽卡；已发送的消息不会撤回');if(location.origin!=='https://arena.ai')throw fatal('已离开 Arena，自动抽卡已停止');}
  async function wait(check,message,ms=15000){const end=Date.now()+ms;while(Date.now()<end){guard();const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,250));}throw Error(message);}
  const editors=()=>[...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
  const editorText=e=>(e?.innerText??e?.textContent??'').trim();
  function noDraft(allowPrompt=false){if(editors().some(e=>editorText(e)&&!(allowPrompt&&editorText(e)===prompt)))throw fatal('输入框有未发送内容，已停止；不会覆盖草稿');}
  async function newChat(allowPrompt=false){
    guard();noDraft(allowPrompt&&!session());
    const links=[...document.querySelectorAll('a[href]')].filter(a=>{try{return new URL(a.href).origin==='https://arena.ai'&&new URL(a.href).pathname==='/agent'&&['New Chat','新建聊天','新对话'].includes(a.textContent.trim());}catch{return false;}});
    if(!links.length)throw Error('未找到 New Chat 入口，已停止');
    links[0].click();await wait(()=>location.pathname.replace(/\/$/,'')==='/agent','新建聊天超时');
    await wait(()=>editors().length===1,'等待新聊天输入框超时');noDraft(allowPrompt);
  }
  async function mode(){
    if(modeReady())return;
    const combo=await wait(()=>combos()[0],'未找到模式选择器');
    press(combo);
    const option=await wait(()=>[...document.querySelectorAll('[role="option"]')].find(e=>visible(e)&&isMode(e)&&!isDisabled(e)),'未找到 Agent Mode 选项');press(option);
    await wait(modeReady,'未能确认 Agent Mode');
  }
  async function nextBlank(){
    await newChat(true);await mode();guard();
    const editor=editors()[0];
    // Arena may restore the just-submitted prompt as its new-chat draft.
    // Clear only this exact owned prompt, never another user draft.
    if(editorText(editor)===prompt){
      editor.focus();const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('delete',false))throw Error('已进入新聊天，但残留提示未能清理；未再次发送');
      await wait(()=>!editorText(editors()[0]),'新聊天草稿未能清空；未再次发送');
    }
    noDraft();
  }
  // Archive the just-drawn chat through Arena's own UI (same ticket chain as the HUD button): background invalidates the
  // capture and issues a ticket, the page performs the archive, background deletes the local record only after confirmation.
  async function archiveChat(isCurrent){
    const prep=await chrome.runtime.sendMessage({type:'ATI_ARCHIVE_PREPARE',sessionId,pageUrl:location.href});
    if(!prep?.ticket)throw Error(prep?.error||'归档准备失败');
    const result=await ArenaConversationRename.archive({sessionId,isCurrent});
    if(!result?.archived)throw Error('未确认归档，本地记录保留');
    const removed=await chrome.runtime.sendMessage({type:'ATI_ARCHIVE_FINISH',ticket:prep.ticket,archived:true});
    if(!removed?.ok)throw Error(removed?.error||'聊天已归档，但本地记录清理失败');
  }
  async function listen(enabled){const r=await chrome.runtime.sendMessage({type:'ATI_SET_LISTENING',enabled,pageUrl:location.href});if(r?.error||!!r?.enabled!==enabled)throw Error(r?.error||'监听状态切换失败');return r;}
  async function requireListening(){
    const state=await chrome.runtime.sendMessage({type:'ATI_STATUS',pageUrl:location.href});
    if(state?.enabled!==true||state.restoring||state.error)throw Error('请先开启监听；未发送消息');
    return state;
  }
  async function start(rounds=5){
    if(running)return status();
    const count=Number(rounds);
    if(!Number.isInteger(count)||count<1||count>100){publish('blocked','轮数必须是 1–100 的整数');return status();}
    if(readState()?.enabled!==true){publish('blocked','请先开启监听，再开始自动抽卡');return status();}
    running=true;cancelled=false;sent=false;sessionId=null;total=count;round=0;completed=0;failed=0;archived=0;
    let ownListening=false,consecutiveFailures=0,halted=false;
    publish('checking','正在确认当前页监听状态…');
    try{
      // Preferences are read once per job. The text is normalized (one line, <=200 chars, non-empty) before anything is typed.
      const p=prefsApi();let saved=null;
      try{const r=await chrome.runtime.sendMessage({type:'ATI_DRAW_PREFS_GET',pageUrl:location.href});saved=r?.prefs||null;}catch{saved=null;}
      const prefs=p?p.sanitize(saved):{prompt:'1+1=',keepOnly:false};prompt=prefs.prompt;keepOnly=prefs.keepOnly;
      await requireListening();guard();
      for(round=1;round<=total;round++){
        sent=false;sessionId=null;
        publish('new-chat',`${round}/${total} · 正在新建聊天`);
        try{
      if(ArenaConversationRename.isBusy())throw Error('聊天操作正在进行，请稍后重试');
      noDraft(!session());
      if(generating()){publish('waiting',`${round}/${total} · 上一条回复仍在生成，等待结束后再新建聊天（最多 240 秒）`);await wait(()=>!generating(),'上一条回复超过 240 秒仍在生成，本轮跳过',240000);}
      await newChat(true);publish('mode',`${round}/${total} · 正在确认 Agent Mode`);await mode();
      guard();if(location.pathname.replace(/\/$/,'')!=='/agent')throw Error('页面已变化，未发送');
      publish('listen',`${round}/${total} · 开启监听`);await listen(true);ownListening=true;
      guard();if(session())throw Error('新聊天状态已变化，未发送');noDraft(true);
      const editor=editors()[0];if(!editor)throw Error('输入框不可用');
      if(editorText(editor)!==prompt){
      editor.focus();const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('insertText',false,prompt))throw Error('输入消息失败；未发送');
      }
      const button=await wait(()=>[...document.querySelectorAll('button[aria-label="Send message"]')].find(b=>visible(b)&&!b.disabled),'发送按钮不可用；未发送');
      guard();if(editorText(editor)!==prompt||session())throw Error('输入或页面已变化；未发送');
      if(!modeReady())throw Error('模式已变化；未发送');
      await requireListening();guard();if(session())throw Error('页面已变化，未发送');
      sent=true;publish('detect',`${round}/${total} · 已发送「${prompt.length>20?prompt.slice(0,20)+'…':prompt}」，等待完成检测（最多 180 秒）`);button.click();
      try{sessionId=await wait(()=>session(),'发送后未确认新会话；不重发',30000);}catch(e){throw e?.fatal?e:fatal(e?.message||'发送后未确认新会话；不重发');}
      const detectStart=Date.now();
      const detectCheck=()=>{
        if(session()!==sessionId)throw fatal('已切换到其他聊天，停止抽卡');
        if(readState()?.enabled===false&&!readState()?.initializing)throw fatal('监听已停止，自动抽卡终止');
        const state=readState();if(state?.sessionId!==sessionId||state.historical||!state.saved)return null;
        const view=ArenaTraceView.build(state);
        return view.models.length&&view.completion==='调用已完成'?{state,view}:null;
      };
      let detected=null;
      // 180 s base; while Arena still shows "Stop generating" keep waiting (long reasoning runs), hard cap 600 s.
      while(!detected){
        try{detected=await wait(detectCheck,'detect-timeout',180000);}
        catch(e){
          if(e?.message!=='detect-timeout')throw e;
          const elapsed=Math.round((Date.now()-detectStart)/1000);
          if(!generating()||elapsed>=600)throw Error(`检测超时（${elapsed} 秒），不重发`);
          publish('detect',`${round}/${total} · 回复仍在生成，继续等待（已 ${elapsed} 秒，上限 600 秒）`);
        }
      }
      guard();
      // Always let span detail land before touching the chat. Renaming or navigating away invalidates
      // the pending detail read, which is why the Arena internal name only ever appeared after a
      // second message. Bounded at 20 s; a slow read only delays, it never fails the round.
      publish('detail',`${round}/${total} · 检测完成，等待 span 详情以补全模型信息（最多 20 秒）`);
      try{detected=await wait(()=>{const r=detectCheck();return r&&!r.state.detailPending?r:null;},'detail-timeout',20000);}catch(e){if(e?.message!=='detail-timeout')throw e;detected=detectCheck()||detected;}
      guard();
      if(keepOnly){
        const keep=prefsApi()?prefsApi().shouldKeep(detected.view.models):true;
        if(!keep){
          const label=detected.view.models[0].model;
          publish('archive',`${round}/${total} · ${label} 不在保留列表，正在归档聊天`);
          try{await archiveChat(()=>!cancelled&&session()===sessionId);archived++;}
          finally{
            // ATI_ARCHIVE_PREPARE stops this tab's capture. Turn listening back on whether or not the archive succeeded,
            // so a failed archive is a skippable round (the chat is simply kept) and the next round can proceed.
            if(!cancelled&&location.origin==='https://arena.ai'){try{await listen(true);ownListening=true;}catch{}}
          }
          guard();
          publish('next',`${round}/${total} · 已归档 ${label}，正在进入新的空白聊天`);await nextBlank();
          completed++;consecutiveFailures=0;
          guard();continue;
        }
      }
      publish('rename',`${round}/${total} · 检测完成，正在重命名`);guard();
      const model=detected.view.models[0].model;
      await ArenaConversationRename.rename({sessionId,model,isCurrent:()=>!cancelled&&session()===sessionId&&readState()?.runId===detected.state.runId});
      guard();
      publish('next',`${round}/${total} · 已重命名，正在进入新的空白聊天`);await nextBlank();
      completed++;consecutiveFailures=0;
        }catch(e){
          if(cancelled)throw e;
          failed++;consecutiveFailures++;
          const message=e?.message||'本轮失败';
          // Skippable: nothing was sent this round (retrying is safe), or the send is confirmed on this very chat and only
          // detection/rename failed. Never continue after a fatal condition (draft, listening lost, navigation, unconfirmed send).
          const listening=readState()?.enabled===true;
          const canSkip=!e?.fatal&&listening&&(!sent||(sessionId&&session()===sessionId));
          if(!canSkip||consecutiveFailures>=3){halted=true;publish('skipped',message+(consecutiveFailures>=3?'；连续失败 3 次，已停止':'；已停止抽卡'));break;}
          publish('skipped',`${round}/${total} · ${message}；${sent?'保留聊天，':''}跳过本轮`);
        }
        guard();
      }
      round=Math.min(round,total);
      if(!halted)publish('done',`抽卡结束：成功 ${completed} 轮${keepOnly?`（归档 ${archived} 个非保留模型）`:''}，跳过 ${failed} 轮；不再自动发送`);
    }catch(e){publish(cancelled?'stopped':'skipped',e?.message||'自动抽卡已停止');}
    finally{
      // Listening is deliberately left on when the run ends: the last round's span detail is still
      // being read, and turning capture off here also cost the user a manual re-arm every run.
      running=false;notify(status());
    }
    return status();
  }
  function stop(){if(running){cancelled=true;publish('stopping','正在停止；不会再发送新消息');}}
  globalThis.ArenaAutoDraw={start,stop,status,configure(options){readState=options.readState;notify=options.onProgress||(()=>{});notify(status());}};
})();

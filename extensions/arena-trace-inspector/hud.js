(() => {
  let host,panel,status,dot,compactDot,shell,content,compact,compactName,expandButton,listenButton,balanceHost;
  let balanceInfo=null,balanceError='',balanceLoading=false,balanceRunKey='';
  let requestVersion=0,displayedSession=null,latestState=null,retryTimer;
  let prefs,loadedPrefs=false,interactionVersion=0,drag=null,sizeObserver=null,layoutError='',listenError='',listenPending=false,pageKey=location.pathname;
  // Stays false until the stored preference arrives: claiming before that would act on a guess.
  let autoRename=false,autoLoaded=false,autoPending=false,autoChecking=false,deletePending=false,archivePending=false;
  let drawStart,drawStop,drawStatus,drawRounds,drawMenu,drawMenuButton,drawMenuOpen=false;
  let drawRoundValue=5;
  // 2.0.0 auto-draw settings (prompt text + keep-only filter): loaded from the extension once, saved on change, frozen per job by auto-draw.js.
  let drawPrompt,drawKeep,drawPrefs=null,drawPrefsLoaded=false,drawPrefsSaving=false,drawPrefsError='';
  const drawing=()=>!!globalThis.ArenaAutoDraw?.status().running;
  function updateDraw(){if(!drawStart)return;const s=ArenaAutoDraw.status();const count=Number(drawRounds?.value);drawStart.disabled=s.running||archivePending||deletePending||listenPending||!latestState?.enabled||latestState?.initializing||latestState?.connectionError||!Number.isInteger(count)||count<1||count>100;if(drawRounds)drawRounds.disabled=s.running;if(drawPrompt){drawPrompt.disabled=s.running||drawPrefsSaving;drawKeep.disabled=s.running||drawPrefsSaving;if(document.activeElement!==drawPrompt&&drawPrefs&&drawPrompt.value!==drawPrefs.prompt)drawPrompt.value=drawPrefs.prompt;if(drawPrefs)drawKeep.checked=drawPrefs.keepOnly;}drawStop.disabled=!s.running;drawStatus.textContent=!s.running&&!latestState?.enabled?((s.phase!=='idle'&&s.progress&&!/请先开启监听/.test(s.progress))?s.progress+' · ':'')+'请先开启监听，再开始自动抽卡。':s.phase==='idle'&&latestState?.enabled?'监听中 · 设置轮数后点击「开始抽卡」；每轮新建聊天并发送 1 条消息「'+(drawPrefs?.prompt||'1+1=')+'」'+(drawPrefs?.keepOnly?'；非 gpt-6 / fable-5（含 5.1）的聊天将直接归档':'')+(drawPrefsError?' · '+drawPrefsError:''):s.progress;if(drawMenuButton){const live=s.running&&Number.isInteger(s.round)&&Number.isInteger(s.total);drawMenuButton.textContent=live?`抽卡 ${s.round}/${s.total}`:s.running?'抽卡中…':'自动抽卡';drawMenuButton.classList.toggle('active',!!s.running);drawMenuButton.title=s.running?'自动抽卡进行中 · 点击查看进度或停止':'打开自动抽卡菜单';}updateListenControl();}
  const drawPrefsApi=()=>globalThis.ArenaDrawPrefs||null;
  async function loadDrawPrefs(){
    if(drawPrefsLoaded||!drawPrefsApi())return;drawPrefsLoaded=true;
    try{const r=await chrome.runtime.sendMessage({type:'ATI_DRAW_PREFS_GET',pageUrl:location.href});if(r?.error||!r?.prefs)throw Error(r?.error||'读取失败');drawPrefs=drawPrefsApi().sanitize(r.prefs);drawPrefsError='';}
    catch{drawPrefsLoaded=false;drawPrefs=drawPrefs||drawPrefsApi().defaults();drawPrefsError='抽卡设置读取失败，使用默认值';}
    updateDraw();
  }
  async function saveDrawPrefs(patch){
    if(!drawPrefsApi()||drawing())return;
    const next=drawPrefsApi().sanitize({...(drawPrefs||drawPrefsApi().defaults()),...patch});
    drawPrefsSaving=true;updateDraw();
    try{const r=await chrome.runtime.sendMessage({type:'ATI_DRAW_PREFS_SET',prefs:next,pageUrl:location.href});if(r?.error||!r?.prefs)throw Error(r?.error||'保存失败');drawPrefs=drawPrefsApi().sanitize(r.prefs);drawPrefsError='';}
    catch{drawPrefsError='抽卡设置保存失败，本次启动仍按输入框内容执行前请重试';}
    finally{drawPrefsSaving=false;updateDraw();}
  }
  function setDrawMenu(open){if(!drawMenu)return;drawMenuOpen=!!open;drawMenu.hidden=!drawMenuOpen;drawMenuButton.setAttribute('aria-expanded',String(drawMenuOpen));if(drawMenuOpen){void loadDrawPrefs();updateDraw();(drawRounds?.disabled?drawStop:drawRounds)?.focus?.({preventScroll:true});}}
  globalThis.ArenaAutoDraw?.configure({readState:()=>latestState,onProgress:()=>{updateDraw();}});
  const attemptedHere=new Map(); // sessionId -> true when the internal name was used (no further upgrade)
  function repaint(){if(latestState)render(latestState);}
  // Account balance: read via background (same-origin cookies); refreshed on HUD creation, on user click, and once after each completed run.
  async function loadBalance(force=false){
    if(balanceLoading||!chrome.runtime?.id)return;balanceLoading=true;paintBalance();
    try{const r=await chrome.runtime.sendMessage({type:'ATI_BALANCE',force,pageUrl:location.href});if(r?.balance)balanceInfo=r.balance;balanceError=r?.error||'';}
    catch{balanceError='余额读取失败';}
    finally{balanceLoading=false;paintBalance();}
  }
  function paintBalance(){
    const f=globalThis.ArenaBilling?.formatBalance(balanceInfo)||{value:'未提供',note:''};
    panel?.setBalance?.({...f,loading:balanceLoading,error:balanceError,onRefresh:()=>void loadBalance(true)});
  }
  async function loadAutoRename(){
    if(autoLoaded||latestState?.initializing||latestState?.connectionError)return;autoLoaded=true;
    try{const r=await chrome.runtime.sendMessage({type:'ATI_AUTO_RENAME_GET',pageUrl:location.href});if(r?.error)throw Error(r.error);if(!autoPending)autoRename=!!r.enabled;repaint();}
    catch{autoLoaded=false;}
  }
  async function setAutoRename(enabled){
    if(autoPending)return;autoPending=true;repaint();
    try{const r=await chrome.runtime.sendMessage({type:'ATI_AUTO_RENAME_SET',enabled,pageUrl:location.href});if(r?.error)throw Error(r.error);autoRename=!!r.enabled;listenError='';}
    catch{listenError='自动重命名设置保存失败，请重试';}
    finally{autoPending=false;repaint();}
  }
  async function maybeAutoRename(view){
    if(drawing()||archivePending||!autoRename||autoPending||autoChecking||view.historical||!latestState?.saved||!view.sessionId||!view.models.length||view.completion!=='调用已完成')return;
    const internal=view.models[0].internal===true;
    // Prefer the Arena internal modelName: wait while span detail is still being read; once named with the internal name, stop.
    if(view.detailPending&&!internal)return;
    const done=attemptedHere.get(view.sessionId);
    if(done===true||(done===false&&!internal))return;
    autoChecking=true;const session=view.sessionId,title=view.models[0].model;
    try{
      const r=await chrome.runtime.sendMessage({type:'ATI_AUTO_RENAME_CLAIM',sessionId:session,runId:view.runId,pageUrl:location.href,title,internal});
      if(r?.error)throw Error(r.error);
      if(r?.claimed){attemptedHere.set(session,internal);if(autoRename&&currentSession()===session&&latestState?.runId===view.runId)await panel.renameModel(title,view);}
      else if(!internal)attemptedHere.set(session,false);else attemptedHere.set(session,true);
    }catch{listenError='自动重命名未执行：状态校验失败，可手动重试';showSaveStatus();}
    finally{autoChecking=false;}
  }
  async function deleteCurrentRecord(view){
    if(drawing()||archivePending||deletePending||view.sessionId!==currentSession())return;
    if(!window.confirm('删除当前会话的扩展本地记录及累计用量？此操作无法撤销，不会删除 Arena 对话。继续监听后可能生成新记录。'))return;
    deletePending=true;repaint();
    try{const r=await chrome.runtime.sendMessage({type:'ATI_HISTORY_DELETE',sessionId:view.sessionId,pageUrl:location.href});if(!r?.ok)throw Error(r?.error);listenError='本地记录已删除';refresh();}
    catch{listenError='删除记录失败，请重试';}
    finally{deletePending=false;repaint();}
  }
  async function archiveCurrentChat(view){
    if(drawing()||archivePending||deletePending||autoChecking||ArenaConversationRename.isBusy()||view.sessionId!==currentSession())return;
    // ATI_ARCHIVE_PREPARE detaches this tab's capture, so a manual archive used to leave listening
    // switched off until the user re-armed it by hand. Remember the state and restore it below.
    const wasListening=latestState?.enabled===true;
    archivePending=true;repaint();let archived=false;
    try{
      const prep=await chrome.runtime.sendMessage({type:'ATI_ARCHIVE_PREPARE',sessionId:view.sessionId,pageUrl:location.href});
      if(!prep?.ticket)throw Error(prep?.error||'归档准备失败');
      const result=await ArenaConversationRename.archive({sessionId:view.sessionId,isCurrent:()=>archivePending&&currentSession()===view.sessionId});
      if(!result?.archived)throw Error('未确认归档，本地记录保留');archived=true;
      const removed=await chrome.runtime.sendMessage({type:'ATI_ARCHIVE_FINISH',ticket:prep.ticket,archived:true});
      if(!removed?.ok)throw Error(removed?.error||'本地记录清理失败');
      listenError='聊天已归档，本地记录已删除';
    }catch(e){listenError=archived?'聊天已归档，但本地记录清理失败；请在扩展会话列表删除记录':(e?.message||'归档失败，本地记录保留');}
    finally{
      archivePending=false;
      if(wasListening&&location.origin==='https://arena.ai'){
        try{await chrome.runtime.sendMessage({type:'ATI_SET_LISTENING',enabled:true,pageUrl:location.href});}catch{}
      }
      repaint();
    }
  }
  const currentSession=()=>location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const viewport=()=>({width:window.innerWidth,height:window.innerHeight});
  function moveTo(point){if(!host)return;const p=ArenaHudLayout.clamp(point,host.getBoundingClientRect(),viewport());host.style.left=p.x+'px';host.style.top=p.y+'px';}
  function placeSaved(){if(host)moveTo(ArenaHudLayout.position(prefs.position,host.getBoundingClientRect(),viewport()));}
  function keepVisible(){if(host){const r=host.getBoundingClientRect();moveTo({x:r.left,y:r.top});}}
  function rememberPosition(){if(!host)return;const r=host.getBoundingClientRect();prefs.position=ArenaHudLayout.normalize({x:r.left,y:r.top},r,viewport());}
  function showSaveStatus(){
    // HUD-local messages (listen/rename/archive/delete errors, layout save errors) stay next to the listen button;
    // the background pipeline status (latestState.status) is rendered inside the 状态 metric card by panel.render.
    if(status){const text=[listenError,layoutError].filter(Boolean).join(' · ');status.textContent=text;status.hidden=!text;}
  }
  async function savePrefs(){
    try{const result=await chrome.runtime.sendMessage({type:'ATI_HUD_SAVE',prefs});if(result?.error||!result?.prefs)throw Error('save failed');layoutError='';}
    catch{layoutError='位置／收起状态未能保存，本页操作仍然有效';}
    showSaveStatus();
  }
  function loadPrefs(){
    if(loadedPrefs)return;loadedPrefs=true;const version=interactionVersion;
    chrome.runtime.sendMessage({type:'ATI_HUD_GET'}).then(result=>{
      if(result?.error||!result?.prefs)return;
      if(version!==interactionVersion)return; // A late read must not undo a user's drag.
      prefs=ArenaHudLayout.sanitize({...result.prefs,collapsed:false}); // New page visits always open expanded; keep the saved position.
      if(host){applyMode();placeSaved();}
    }).catch(()=>{});
  }
  function applyMode(){
    if(!shell)return;shell.classList.toggle('collapsed',prefs.collapsed);content.hidden=prefs.collapsed;compact.hidden=!prefs.collapsed;
    host.setAttribute('data-collapsed',String(prefs.collapsed));
  }
  function setCollapsed(value){
    interactionVersion++;if(value)setDrawMenu(false);const r=host.getBoundingClientRect();prefs.collapsed=value;applyMode();moveTo({x:r.left,y:r.top});rememberPosition();void savePrefs();
    if(value)expandButton.focus({preventScroll:true});else shell.querySelector('.collapse-button').focus({preventScroll:true});
  }
  function updateListenControl(){
    if(!listenButton)return;
    const enabled=!!latestState?.enabled,initializing=!!latestState?.initializing;
    listenButton.disabled=drawing()||archivePending||listenPending||initializing;
    listenButton.textContent=listenPending?'处理中…':initializing?'读取状态…':latestState?.connectionError?'重试连接':enabled?'停止监听':'开启监听';
    listenButton.setAttribute('aria-pressed',String(enabled));
    listenButton.title=initializing?'正在连接扩展':latestState?.connectionError?'扩展连接暂时不可用':enabled?'当前页监听中 · 点击停止':'当前页未监听 · 点击开启';
  }
  async function changeListening(){
    if(drawing()||archivePending||listenPending||latestState?.initializing)return;
    if(latestState?.connectionError){listenError='';render({...latestState,initializing:true,connectionError:false,status:'正在重新连接扩展…'});refresh();return;}
    const session=currentSession(),path=location.pathname;
    listenPending=true;listenError='';updateListenControl();if(globalThis.ArenaAutoDraw)updateDraw();showSaveStatus();
    try{
      const result=await chrome.runtime.sendMessage({type:'ATI_SET_LISTENING',enabled:!latestState?.enabled,pageUrl:location.href});
      if(path!==location.pathname||session!==currentSession())return;
      if(!result||result.restoring||(result.sessionId&&result.sessionId!==session))throw Error('页面状态已变化，请稍后重试');
      if(result.error)listenError=result.error;
      render(result);
    }catch(error){if(path===location.pathname)listenError=error?.message||'操作失败，请重新加载扩展后刷新页面';}
    finally{listenPending=false;updateListenControl();if(globalThis.ArenaAutoDraw)updateDraw();showSaveStatus();}
  }
  function addDrag(handle){
    handle.tabIndex=0;handle.setAttribute('role','group');handle.setAttribute('aria-label','拖动浮层；也可用方向键移动，Home 键复位');
    handle.title='按住拖动 · 方向键微调 · Home 回到右下角';
    handle.addEventListener('pointerdown',event=>{
      if(!event.isPrimary||event.button!==0||event.target.closest('button,a,input,select,textarea,.draw-menu'))return;
      event.preventDefault();interactionVersion++;const r=host.getBoundingClientRect();
      drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,left:r.left,top:r.top,moved:false};
      handle.setPointerCapture(event.pointerId);host.classList.add('dragging');
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;event.preventDefault();
      const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;
      moveTo({x:drag.left+dx,y:drag.top+dy});
    });
    const finish=event=>{
      if(!drag||drag.id!==event.pointerId)return;const moved=drag.moved;drag=null;host?.classList.remove('dragging');
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      if(moved){rememberPosition();void savePrefs();}
    };
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish);
    handle.addEventListener('keydown',event=>{
      if(event.target!==handle)return;const steps={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
      if(event.key==='Home'){event.preventDefault();interactionVersion++;prefs.position={x:1,y:1};placeSaved();void savePrefs();return;}
      if(!steps[event.key])return;event.preventDefault();interactionVersion++;const r=host.getBoundingClientRect(),d=steps[event.key],step=event.shiftKey?40:10;
      moveTo({x:r.left+d[0]*step,y:r.top+d[1]*step});rememberPosition();void savePrefs();
    });
  }
  function createHost(){
    sizeObserver?.disconnect();drag=null;
    host=el('div');host.id='arena-trace-inspector-hud';
    host.style.cssText='position:fixed;left:12px;top:12px;z-index:2147483647';
    const root=host.attachShadow({mode:'closed'}),style=el('style');
    style.textContent=`
:host{all:initial}.shell{box-sizing:border-box;width:370px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;border:1px solid #3b554a;border-radius:15px;background:#111a20;color:#e8f1f0;font:12px/1.55 system-ui,sans-serif;box-shadow:0 12px 48px #0007;overflow:hidden}.shell *{box-sizing:border-box}[hidden]{display:none!important}.header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2b3b42;flex-shrink:0}.header strong{font-size:12px;flex:1}.drag-handle{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}.drag-handle:active{cursor:grabbing}.dot{width:6px;height:6px;border-radius:50%;background:#92e4b9;flex-shrink:0}button{font:12px system-ui,sans-serif;border:1px solid #3b5147;border-radius:6px;background:transparent;color:#bce7d0;cursor:pointer;padding:3px 8px}button:focus-visible,.drag-handle:focus-visible{outline:2px solid #9ae9ca;outline-offset:-3px}.content{min-height:0;max-height:70vh;overflow:auto;padding:13px}.header{position:relative}.draw-menu-button{padding:3px 9px;white-space:nowrap;font-variant-numeric:tabular-nums}.draw-menu-button[aria-expanded="true"]{background:#ffffff12}.draw-menu-button.active{border-color:#5f9a85;background:#235b4b;color:#e3fff1;font-weight:650}.draw-menu{position:absolute;top:calc(100% + 6px);right:12px;z-index:5;width:288px;max-width:calc(100% - 24px);padding:12px 13px 11px;border:1px solid #3d5a50;border-radius:11px;background:#17242b;box-shadow:0 14px 36px #000a;cursor:default;user-select:text;-webkit-user-select:text}.draw-menu:before{content:'';position:absolute;top:-6px;right:58px;width:10px;height:10px;transform:rotate(45deg);background:#17242b;border-left:1px solid #3d5a50;border-top:1px solid #3d5a50}
.draw-menu-head{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}.draw-menu-head strong{font-size:12px;color:#d8ece4}.draw-menu-hint{font-size:10px;color:#8fa6a2}.draw-settings{display:flex;flex-direction:column;gap:7px;margin-bottom:9px;padding-bottom:9px;border-bottom:1px solid #2b3f3a}.draw-prompt-row{display:flex;align-items:center;gap:7px}.draw-prompt-label{font-size:11px;color:#aac1b8;white-space:nowrap}.draw-prompt{flex:1;min-width:0;border:1px solid #3b5147;border-radius:6px;background:#111a20;color:#d6eee2;padding:6px 8px;font:12px system-ui}.draw-prompt:disabled{opacity:.5}.draw-keep{display:flex;align-items:center;gap:6px;font-size:11px;color:#bad9ce;cursor:pointer;user-select:none;-webkit-user-select:none}.draw-keep input{accent-color:#9ae9ca;width:14px;height:14px;margin:0}.draw-controls{display:flex;gap:7px;align-items:center}.draw-rounds-label{font-size:11px;color:#aac1b8;white-space:nowrap}.draw-rounds{width:56px;min-width:48px;border:1px solid #3b5147;border-radius:6px;background:#111a20;color:#d6eee2;padding:6px;font:12px system-ui}.draw-rounds:disabled{opacity:.5}.draw-controls button{padding:6px 10px}.draw-start{border-color:#5f9a85;background:#235b4b;color:#e3fff1;font-weight:650}.draw-stop{color:#f0b3ad;border-color:#78504d}.draw-controls button:disabled{opacity:.4;cursor:default}.draw-status{font-size:10px;line-height:1.6;color:#9bb6ae;margin:9px 0 0;overflow-wrap:anywhere;min-height:16px}.listen-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:8px;align-items:stretch;margin-bottom:10px}.listen-button{min-height:62px;padding:8px 10px;border-color:#5f9a85;border-radius:12px;background:#235b4b;color:#e3fff1;font-size:14px;font-weight:650;letter-spacing:.3px}.listen-button[aria-pressed="true"]{background:#1c3f36;border-color:#3f6e5c;color:#cfeedd}.listen-button:disabled{opacity:.6;cursor:wait}.balance-slot{min-width:0;min-height:62px;display:flex;flex-direction:column;justify-content:stretch}.balance-slot .quota{flex:1}.status{color:#e6c598;font-size:11px;margin:0 0 10px;overflow-wrap:anywhere}.content::-webkit-scrollbar{width:5px}.content::-webkit-scrollbar-thumb{background:#3d5054;border-radius:4px}.shell.collapsed{width:196px;border-color:#3b555b;border-radius:10px;background:#18262b}.collapsed .header{display:none}.compact{padding:6px 8px;overflow:hidden}.compact-head{display:flex;align-items:center;gap:6px;min-height:22px}
.compact-name{flex:1;min-width:0;font:600 13px/1.35 system-ui,sans-serif;color:#b0f0de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.expand-button{flex:0 0 auto;width:20px;height:20px;padding:0;font-size:14px;color:#b7d5c7;background:#ffffff04}
`;
    shell=el('section','shell');shell.setAttribute('aria-label','Arena 模型运行信息');
    const header=el('header','header drag-handle');dot=el('span','dot');
    // The version is on the title so a page can be checked for a stale content script without
  // opening the popup: after reloading the extension the page must be refreshed to match.
  const title=el('strong','','Arena · Trace Inspector'),toggle=el('button','collapse-button','收起');toggle.type='button';toggle.setAttribute('aria-expanded','true');toggle.addEventListener('click',()=>setCollapsed(true));
    title.title='Arena Trace Inspector v2.3.0';
    header.append(dot,title);
    if(globalThis.ArenaAutoDraw){
      drawMenuButton=el('button','draw-menu-button','自动抽卡');drawMenuButton.type='button';drawMenuButton.setAttribute('aria-haspopup','true');drawMenuButton.setAttribute('aria-expanded','false');drawMenuButton.setAttribute('aria-controls','ati-draw-menu');drawMenuButton.addEventListener('click',()=>setDrawMenu(!drawMenuOpen));
      drawMenu=el('div','draw-menu');drawMenu.id='ati-draw-menu';drawMenu.hidden=true;drawMenu.setAttribute('role','group');drawMenu.setAttribute('aria-label','自动抽卡');
      const menuHead=el('div','draw-menu-head');menuHead.append(el('strong','','自动抽卡'),el('span','draw-menu-hint','按轮数新建聊天并记录模型'));
      const drawControls=el('div','draw-controls');const roundsLabel=el('label','draw-rounds-label','轮数');roundsLabel.htmlFor='ati-draw-rounds';drawRounds=el('input','draw-rounds');drawRounds.id='ati-draw-rounds';drawRounds.type='number';drawRounds.min='1';drawRounds.max='100';drawRounds.step='1';drawRounds.value=String(drawRoundValue);drawRounds.setAttribute('aria-label','自动抽卡轮数');drawRounds.title='自动抽卡轮数（1–100）';drawRounds.addEventListener('input',()=>{drawRoundValue=drawRounds.value;updateDraw();});
      drawStart=el('button','draw-start','开始抽卡');drawStop=el('button','draw-stop','停止');drawStart.type=drawStop.type='button';drawStart.addEventListener('click',()=>{if(!drawStart.disabled&&latestState?.enabled&&!archivePending&&!deletePending)void ArenaAutoDraw.start(Number(drawRounds.value));});drawStop.addEventListener('click',()=>ArenaAutoDraw.stop());
      drawStatus=el('p','draw-status');drawStatus.setAttribute('role','status');drawControls.append(roundsLabel,drawRounds,drawStart,drawStop);
      // 2.0.0 settings: the message text sent each round, and the keep-only filter (archive non gpt-6 / fable-5 chats instead of renaming).
      // "fable-5" is a major-version match (5, 5.1, 5-1, 5.x …), "gpt-6" likewise (gpt-6-astra-low, 6.x …); see ArenaDrawPrefs.shouldKeep.
      const settings=el('div','draw-settings');
      const promptLabel=el('label','draw-prompt-label','发送内容');promptLabel.htmlFor='ati-draw-prompt';
      drawPrompt=el('input','draw-prompt');drawPrompt.id='ati-draw-prompt';drawPrompt.type='text';drawPrompt.maxLength=200;drawPrompt.spellcheck=false;drawPrompt.autocomplete='off';drawPrompt.placeholder='1+1=';drawPrompt.setAttribute('aria-label','每轮自动发送的消息内容');drawPrompt.title='每轮新建聊天后发送的这一条消息；单行，最多 200 字，留空则用 1+1=';
      drawPrompt.addEventListener('change',()=>void saveDrawPrefs({prompt:drawPrompt.value}));
      drawPrompt.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();drawPrompt.blur();}event.stopPropagation();});
      const keepLabel=el('label','draw-keep');drawKeep=el('input');drawKeep.type='checkbox';drawKeep.id='ati-draw-keep';drawKeep.addEventListener('change',()=>void saveDrawPrefs({keepOnly:drawKeep.checked}));
      keepLabel.append(drawKeep,el('span','','只保留 gpt-6 / fable-5（含 5.1）'));keepLabel.title='勾选后：每轮检测到模型时，若不是 gpt-6 或 fable-5，跳过重命名，直接归档该聊天并删除本地记录；保留的模型照常重命名。按大版本匹配：fable-5 包含 claude-fable-5.1-high / claude-fable-5-1 等所有 5.x，gpt-6 包含 gpt-6-astra-low 等所有 6.x；Arena 内部名或服务端标签任一命中即保留；匿名代号一律不保留';
      const promptRow=el('div','draw-prompt-row');promptRow.append(promptLabel,drawPrompt);settings.append(promptRow,keepLabel);
      drawMenu.append(menuHead,settings,drawControls,drawStatus);
      drawMenu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();setDrawMenu(false);drawMenuButton.focus({preventScroll:true});}});
      header.append(drawMenuButton,drawMenu);
    }
    header.append(toggle);addDrag(header);header.removeAttribute('title');header.setAttribute('aria-label','浮层标题栏');
    compact=el('section','compact');compact.setAttribute('aria-label','精简模型信息');
    const compactHead=el('div','compact-head drag-handle');compactDot=el('span','dot compact-dot');compactName=el('div','compact-name drag-handle');addDrag(compactName);expandButton=el('button','expand-button','↗');expandButton.type='button';expandButton.title='展开详细面板';expandButton.setAttribute('aria-label','展开详细面板');expandButton.setAttribute('aria-expanded','false');expandButton.addEventListener('click',()=>setCollapsed(false));compactHead.append(compactDot,compactName,expandButton);addDrag(compactHead);
    compact.append(compactHead);
    content=el('div','content');status=el('p','status');status.setAttribute('role','status');status.hidden=true;const controls=el('div','listen-controls');listenButton=el('button','listen-button','读取状态…');listenButton.type='button';listenButton.disabled=true;listenButton.addEventListener('click',()=>void changeListening());balanceHost=el('div','balance-slot');controls.append(listenButton,balanceHost);content.append(controls,status);
    if(globalThis.ArenaAutoDraw)updateDraw();
      panel=ArenaTracePanel.create(content,{getCatalog:names=>chrome.runtime.sendMessage({type:'ATI_CATALOG',names,pageUrl:location.href})
      .then(r=>r||{rows:null,error:''}).catch(()=>({rows:null,error:''})),balanceHost,onArchive:archiveCurrentChat,onDelete:deleteCurrentRecord,onAutoRenameChange:setAutoRename,onRename:(model,view)=>{
      if(archivePending||drawing())throw Error('自动流程正在进行，请稍候');
      const isCurrent=()=>view.sessionId===currentSession()&&latestState?.sessionId===view.sessionId&&latestState?.runId===view.runId&&ArenaTraceView.build(latestState).models.some(m=>m.model===model);
      if(!isCurrent())throw Error('当前对话或模型已变化，请重试');
      return ArenaConversationRename.rename({sessionId:view.sessionId,model,isCurrent});
    }});
    shell.append(header,compact,content);root.append(style,shell);document.documentElement.append(host);applyMode();
    if(drawMenu){root.addEventListener('pointerdown',event=>{if(!drawMenuOpen)return;const path=event.composedPath?.()||[];if(!path.includes(drawMenu)&&!path.includes(drawMenuButton))setDrawMenu(false);});document.addEventListener('pointerdown',event=>{if(drawMenuOpen&&event.target!==host)setDrawMenu(false);},true);}
    if(typeof ResizeObserver==='function'){sizeObserver=new ResizeObserver(()=>{if(!drag&&host?.isConnected)keepVisible();});sizeObserver.observe(shell);}
  }
  const agentPage=()=>/^\/agent(?:\/|$)/.test(location.pathname);
  function render(state){
    if(!agentPage()){host?.remove();host=null;latestState=null;return;}
    if(!state||state.restoring)return;if(state.sessionId&&state.sessionId!==currentSession())return;
    latestState=state;
    prefs??=ArenaHudLayout.defaults();const created=!host?.isConnected;if(created)createHost();
    displayedSession=state.sessionId||null;for(const indicator of [dot,compactDot]){indicator.style.background=state.enabled?'#92e4b9':'#d5bd83';indicator.title=state.enabled?'监听中':state.historical?'本地历史 · 未开启监听':'未开启监听';indicator.setAttribute('role','img');indicator.setAttribute('aria-label',indicator.title);}
    const view=ArenaTraceView.build(state);const fullView={...view,sessionId:state.sessionId,statusText:typeof state.status==='string'?state.status:'',autoRename,autoRenamePending:autoPending||archivePending||drawing(),deletePending:deletePending||archivePending||drawing(),archivePending:archivePending||drawing()};panel.render(fullView);void maybeAutoRename(fullView);
    compactName.textContent=view.models.length?[...new Set(view.models.map(m=>m.model))].join(' / '):'模型待确认';compactName.title=compactName.textContent;
    if(globalThis.ArenaAutoDraw)updateDraw();updateListenControl();showSaveStatus();if(created)placeSaved();else if(!drag)keepVisible();loadPrefs();void loadAutoRename();
    paintBalance();
    // Trace accounting is authoritative now that arena.ai retired the billing route, so the
    // endpoint is only consulted while no run has supplied a snapshot yet.
    if(created){if(!view.quota)void loadBalance();}
    else if(!view.quota&&!view.historical&&view.runId&&view.completion==='调用已完成'&&!state.detailPending&&balanceRunKey!==view.runId){balanceRunKey=view.runId;void loadBalance(true);}
  }
  window.addEventListener('resize',()=>{if(host?.isConnected&&!drag)placeSaved();});
  chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='ATI_STATE')render(msg.state);});
  function refresh() {
    if(!agentPage()){requestVersion++;clearTimeout(retryTimer);host?.remove();host=null;latestState=null;return;}
    if(pageKey!==location.pathname){pageKey=location.pathname;listenError='';if(prefs)prefs.collapsed=false;host?.remove();host=null;latestState=null;}
    if (displayedSession !== currentSession()) { host?.remove(); host=null; }
    if(!host)render({enabled:false,sessionId:currentSession(),models:[],initializing:true,status:'正在读取监听状态…'});
    const version = ++requestVersion;
    clearTimeout(retryTimer);
    const delays = [250, 750, 1500, 3000];
    function request(attempt) {
      if (version !== requestVersion) return;
      const retry = () => {
        if(version!==requestVersion)return;
        if(attempt<delays.length)retryTimer=setTimeout(()=>request(attempt+1),delays[attempt]);
        else render({...latestState,sessionId:currentSession(),initializing:false,connectionError:true,status:'扩展连接暂时不可用，点击“重试连接”或重新加载扩展后刷新页面。'});
      };
      // Extension startup and overlapping navigation may briefly have no receiver.
      // Retry only a local state read; never send an Agent message or start capture.
      chrome.runtime.sendMessage({type:'ATI_STATUS',pageUrl:location.href}).then(state => {
        if (version !== requestVersion) return;
        if (!state || state.restoring || (state.sessionId && state.sessionId !== currentSession())) retry(); else render(state);
      }).catch(retry);
    }
    request(0);
  }
  window.addEventListener('pageshow', refresh);
  window.navigation?.addEventListener('navigatesuccess', refresh);
  window.addEventListener('popstate', () => { host?.remove(); host=null; refresh(); });
  // Coming back to the tab is when a stale reading is most misleading -- someone may have
  // switched account meanwhile. Re-read if the shown value is older than the cache window.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refresh();
    const at = balanceInfo?.receivedAt ? Date.parse(balanceInfo.receivedAt) : NaN;
    if (!Number.isFinite(at) || Date.now() - at > 60000) void loadBalance(true);
  });
  // Arena can replace root-level DOM during hydration. Recreate only this view,
  // never a previous conversation's overlay, and never fetch or attach here.
  new MutationObserver(() => {
    if (host && !host.isConnected && latestState && latestState.sessionId === currentSession()) render(latestState);
  }).observe(document, {childList: true, subtree: true});
  refresh();
})();

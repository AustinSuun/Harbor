/* Rename through Arena's own UI. No private API calls, tokens or guessed endpoints. */
(() => {
  let busy=false;
  const sessionFromPath=path=>path.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  function validate(sessionId,model){
    if(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))throw Error('请先进入一个已保存的 Arena 对话');
    if(typeof model!=='string'||!model.trim())throw Error('尚未识别模型，不能自动重命名');
    const title=model.trim();
    if(title.length>100)throw Error('模型名称超过 Arena 的 100 字符上限，请手动重命名');
    if(/[\u0000-\u001f\u007f]/.test(title))throw Error('模型名称包含不支持的控制字符');
    return title;
  }
  const visible=e=>{
    if(!e?.isConnected||!e.getClientRects().length)return false;
    // Radix tooltip triggers (including visible chat links) also carry state=closed.
    if(['menu','dialog','alertdialog'].includes(e.getAttribute('role'))&&e.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(e);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  const sidebarExpanded=e=>visible(e)&&!e.closest?.('[data-state="collapsed"][data-collapsible]');
  async function revealCurrentLink(links,guard,wait){
    guard();
    const find=()=>links().find(a=>sidebarExpanded(a));
    if(!find()){
      const buttons=[...document.querySelectorAll('button[aria-label]')].filter(b=>visible(b)&&!b.disabled);
      const opener=buttons.find(b=>['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏'].includes(b.getAttribute('aria-label')))
        ||buttons.find(b=>['Toggle Sidebar','Toggle sidebar','切换侧栏'].includes(b.getAttribute('aria-label'))&&b.closest?.('[data-state="collapsed"]'));
      if(opener){guard();opener.click();}
    }
    const a=await wait(()=>{guard();return find();},'自动展开侧栏后仍未找到当前聊天；本地记录保留');
    a.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
    return a;
  }
  const text=e=>(e?.textContent||'').trim();
  const exact=(e,words)=>words.includes(text(e));
  async function rename({sessionId,model,isCurrent=()=>true}){
    const title=validate(sessionId,model);
    if(busy)throw Error('正在重命名，请稍候');
    const guard=()=>{if(location.origin!=='https://arena.ai'||sessionFromPath(location.pathname)!==sessionId||!isCurrent())throw Error('当前对话或模型已变化，已停止重命名');};
    const link=()=>{const matches=[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(a=>{try{const u=new URL(a.href);return u.origin==='https://arena.ai'&&sessionFromPath(u.pathname)===sessionId;}catch{return false;}});return matches.find(visible)||matches[0]||null;};
    const wait=(check,message,timeout=6000)=>new Promise((resolve,reject)=>{
      let observer,timer,interval,done=false;
      const finish=(error,value)=>{if(done)return;done=true;observer?.disconnect();clearTimeout(timer);clearInterval(interval);error?reject(error):resolve(value);};
      const tick=()=>{try{guard();const value=check();if(value)finish(null,value);}catch(error){finish(error);}};
      observer=new MutationObserver(tick);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>finish(Error(message)),timeout);interval=setInterval(tick,100);tick();
    });
    guard();busy=true;let dialog=null,menu=null,submitted=false,oldTitle='';
    try{
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('请先关闭页面上已打开的对话框，再重试');
      const a=link();if(!a)throw Error('未找到当前对话的侧栏入口，请展开 Arena 侧栏后重试');
      oldTitle=text(a);if(oldTitle===title)return {title,previousTitle:oldTitle,unchanged:true};
      const row=a.closest('[data-sidebar="menu-item"]');
      const trigger=row?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前对话的菜单不可用，未作修改');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(m=>m.getAttribute('aria-labelledby')===trigger.id&&visible(m));
      if(!getMenu()){
        guard();trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));
        trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));trigger.click();
      }
      menu=await wait(getMenu,'无法打开当前对话菜单，未作修改');
      const item=[...menu.querySelectorAll('[role="menuitem"]')].find(e=>exact(e,['Rename','重命名','重命名对话'])&&!e.hasAttribute('data-disabled'));
      if(!item)throw Error('未找到 Arena 的重命名入口，未作修改');
      guard();item.click();
      dialog=await wait(()=>[...document.querySelectorAll('[role="dialog"]')].find(d=>visible(d)&&exact(d.querySelector('h2'),['Rename chat','Rename conversation','重命名对话','重命名聊天'])),'未出现重命名对话框，未作修改');
      const inputs=[...dialog.querySelectorAll('input')].filter(e=>visible(e)&&!e.disabled&&['text',''].includes(e.getAttribute('type')||''));
      if(inputs.length!==1)throw Error('重命名输入框不明确，未作修改');
      const input=inputs[0];
      if(input.value!==oldTitle||text(link())!==oldTitle)throw Error('对话名称已被其他操作修改，请重试');
      if(input.maxLength>0&&title.length>input.maxLength)throw Error('模型名称超过页面允许的长度，请手动重命名');
      guard();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,title);
      input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const submit=await wait(()=>[...dialog.querySelectorAll('button[type="submit"]')].find(b=>!b.disabled&&exact(b,['Rename','重命名','保存'])),'页面未接受新名称，未提交');
      guard();if(input.value!==title||text(link())!==oldTitle)throw Error('名称或对话已变化，未提交');
      submitted=true;submit.click();
      await wait(()=>text(link())===title&&!visible(dialog),'未能确认重命名成功，请检查 Arena 的提示后再重试',10000);
      return {title,previousTitle:oldTitle,unchanged:false};
    }finally{
      // Close only UI that this operation opened, and only before submission.
      if(!submitted&&location.origin==='https://arena.ai'&&sessionFromPath(location.pathname)===sessionId){
        if(visible(dialog)){const input=dialog.querySelector('input');if(input&&[title,oldTitle].includes(input.value)){const cancel=[...dialog.querySelectorAll('button[type="button"]')].find(b=>exact(b,['Cancel','取消']));cancel?.click();}}
        else if(visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      }
      busy=false;
    }
  }
  async function archive({sessionId,isCurrent=()=>true}) {
    validate(sessionId,'archive');
    if(busy)throw Error('正在操作聊天，请稍后再试');
    const guard=()=>{if(location.origin!=='https://arena.ai'||sessionFromPath(location.pathname)!==sessionId||!isCurrent())throw Error('当前聊天已变化，已停止归档');};
    const links=()=>[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(a=>{try{const u=new URL(a.href);return u.origin==='https://arena.ai'&&sessionFromPath(u.pathname)===sessionId;}catch{return false;}});
    const wait=(check,message)=>new Promise((resolve,reject)=>{let timer,interval;const finish=(error,value)=>{clearTimeout(timer);clearInterval(interval);error?reject(error):resolve(value);};const tick=()=>{try{const value=check();if(value)finish(null,value);}catch(e){finish(e);}};timer=setTimeout(()=>finish(Error(message)),10000);interval=setInterval(tick,100);tick();});
    guard();busy=true;let menu=null,dialog=null,submitted=false;
    try {
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('请先关闭页面对话框');
      const a=await revealCurrentLink(links,guard,wait);
      const sidebar=a.closest('[data-sidebar="sidebar"]')||a.closest('[data-sidebar="content"]');
      if(!sidebar)throw Error('无法确认聊天侧栏，未作修改');
      const trigger=a.closest('[data-sidebar="menu-item"]')?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前聊天菜单不可用');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(m=>m.getAttribute('aria-labelledby')===trigger.id&&visible(m));
      if(!getMenu()){guard();trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));trigger.click();}
      menu=await wait(()=>{guard();return getMenu();},'无法打开聊天菜单，未归档');
      const items=[...menu.querySelectorAll('[role="menuitem"]')].filter(e=>exact(e,['Archive','归档','归档聊天','归档对话'])&&!e.hasAttribute('data-disabled'));
      if(items.length!==1)throw Error('未找到唯一的 Archive 入口；不会以其他操作代替归档');
      guard();submitted=true;items[0].click();
      let stableSince=0;
      await wait(()=>{
        if(location.origin!=='https://arena.ai')throw Error('页面已离开 Arena，无法确认归档；本地记录保留');
        const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
        if(dialogs.length){
          guard();
          if(dialogs.length!==1||!exact(dialogs[0].querySelector('h2'),['Archive chat','Archive conversation','归档聊天','归档对话']))throw Error('出现未识别的确认框，请手动处理；本地记录保留');
          if(!dialog){dialog=dialogs[0];const buttons=[...dialog.querySelectorAll('button')].filter(b=>!b.disabled&&exact(b,['Archive','归档']));if(buttons.length!==1)throw Error('归档确认按钮不明确');guard();buttons[0].click();}
          stableSince=0;return false;
        }
        // Require a stable, still-visible sidebar, not just a disappearing document.
        if((visible(sidebar)||[...document.querySelectorAll('[data-sidebar="sidebar"]')].some(sidebarExpanded))&&!links().length&&!getMenu()){
          if(!stableSince)stableSince=Date.now();return Date.now()-stableSince>=1000;
        }
        stableSince=0;return false;
      },'未能确认归档成功；请检查 Arena，本地记录尚未删除');
      return {archived:true,sessionId};
    } finally {
      if(!submitted&&visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      busy=false;
    }
  }
  globalThis.ArenaConversationRename={rename,archive,validate,sessionFromPath,isBusy:()=>busy};
})();

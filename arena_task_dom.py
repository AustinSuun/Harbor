"""Arena Agent DOM adapter. No tokens, model/extension listening, or network hooks."""
from contextlib import asynccontextmanager

# Agent transcript markers do not encode role: the user bubble uses scroll-mt-*.
# Only accept these markers inside the transcript log, never a preview or HUD.
DOM_HELPERS = r'''
 const excluded='textarea,[contenteditable="true"],#arena-trace-inspector-hud,#arena-runner-float,#arena-debug-panel,iframe';
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
 const user='[data-message-role="user"],[data-message-author-role="user"],[data-role="user"],[data-agent-transcript-message="true"][class*="scroll-mt-"]';
 const assistantRoots=()=>{
  for(const selector of ['[role="log"] [data-agent-transcript-message="true"][data-chat-message-id]','[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"]','[data-testid="assistant-message"],[data-testid="assistant-turn"]']){
   const els=[...document.querySelectorAll(selector)].filter(e=>!e.closest(user+','+excluded));
   const roots=els.filter(e=>!els.some(o=>o!==e&&o.contains(e)));
   if(roots.length)return roots;
  }
  return [];
 };
 const label=b=>(b.getAttribute('aria-label')||b.title||b.textContent||'').trim();
 const controls=[...document.querySelectorAll('button,[role="button"]')].filter(b=>visible(b)&&!b.closest(excluded));
 // This is Arena's own end-of-turn review panel, outside model output. Never
 // click/vote here. The panel replaces the composer after a completed Agent turn.
 const reviewReady=()=>controls.some(b=>{
  if(!/^(Close review panel|关闭评审面板|关闭评价面板)$/i.test(label(b))||b.closest('[role="log"],[data-agent-transcript-message],[data-message-role],[data-message-author-role],[data-role="assistant"]'))return false;
  for(let n=b.parentElement,depth=0;n&&depth<5;n=n.parentElement,depth++){
   if(n.querySelector('[role="log"],[data-agent-transcript-message]'))return false;
   const labels=[...n.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true').map(label);
   if(labels.some(s=>/^(Yes|是)$/i.test(s))&&labels.some(s=>/^(No|否)$/i.test(s))&&labels.some(s=>/^(Continue working|继续工作)$/i.test(s)))return true;
  }
  return false;
 });
'''

READ_REPLY = '() => {\n' + DOM_HELPERS + r'''
 const roots=assistantRoots(),last=roots.at(-1);
 const stream='[data-is-streaming="true"],[data-streaming="true"],[data-state="streaming"],[aria-busy="true"]';
 const stop=controls.some(b=>/^(stop|stop generating|stop generation|stop response|停止|停止生成|停止响应)$/i.test(label(b)));
 const generating=stop||!!(last&&(last.matches(stream)||[...last.querySelectorAll(stream)].some(visible)));
 const review=!!last&&reviewReady();
 const explicitDone=!!last&&(review||last.matches('[data-state="completed"],[data-state="complete"],[data-status="completed"],[data-status="complete"]'));
 const editorReady=[...document.querySelectorAll('textarea,[contenteditable="true"][data-lexical-editor],.ProseMirror[contenteditable="true"],[role="textbox"][contenteditable="true"]')].some(e=>visible(e)&&!e.closest('#arena-trace-inspector-hud,#arena-runner-float,#arena-debug-panel,[role="dialog"]')&&!e.disabled&&!e.readOnly&&e.getAttribute('aria-disabled')!=='true');
 // Relative timestamps update even when the answer is complete. Do not let
 // those UI changes reset the output stability timer.
 const prose=last?[...last.querySelectorAll('.prose')].filter(e=>!e.parentElement.closest('.prose')):[];
 const text=prose.length?prose.map(e=>e.innerText||e.textContent||'').join('\n'):(last?(last.innerText||last.textContent||''):'');
 return {key:last?(last.getAttribute('data-chat-message-id')||last.getAttribute('data-message-id')||last.getAttribute('data-id')||last.id||''):'',count:roots.length,text,generating,explicitDone,editorReady,reviewReady:review,adapter:last?.hasAttribute('data-agent-transcript-message')?'agent-transcript':'legacy'};
}'''

HIDE_HUD = r'''() => {
 const token='harbor-send-'+Math.random().toString(36).slice(2);
 const style=document.createElement('style');style.id=token;style.textContent='#arena-trace-inspector-hud {visibility:hidden!important}';document.documentElement.appendChild(style);
 const e=document.getElementById('arena-trace-inspector-hud');
 const state={token,value:e?.style.getPropertyValue('visibility')||'',priority:e?.style.getPropertyPriority('visibility')||''};
 if(e){e.dataset.harborSendGuard=token;e.style.setProperty('visibility','hidden','important');}
 return state;
}'''
RESTORE_HUD = r'''state => {
 if(!state)return;
 document.getElementById(state.token)?.remove();
 const e=document.getElementById('arena-trace-inspector-hud');
 if(!e||e.dataset.harborSendGuard!==state.token)return;
 if(state.value)e.style.setProperty('visibility',state.value,state.priority);else e.style.removeProperty('visibility');
 delete e.dataset.harborSendGuard;
}'''

@asynccontextmanager
async def send_surface(page):
    """Hide only our HUD while composing/clicking; keep ordinary actionability.

    No force click, retry, extension storage changes or listener activation.
    Restore on errors/cancellation too; navigation may already remove the node.
    """
    state=await page.evaluate(HIDE_HUD)
    try:
        yield
    finally:
        if state:
            try:
                await page.evaluate(RESTORE_HUD,state)
            except Exception:
                pass  # A detached/closed page has no HUD left to restore.

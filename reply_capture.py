"""Capture visible answer source for browser tasks; no numeric-test dependency."""

READ_OUTPUT = r'''() => {
 const user='[data-message-role="user"],[data-message-author-role="user"],[data-role="user"]';
 let roots=[];
 for(const selector of ['[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"]','[data-testid="assistant-message"],[data-testid="assistant-turn"]']){
  const els=[...document.querySelectorAll(selector)].filter(e=>!e.closest(user+',textarea,[contenteditable="true"]'));
  roots=els.filter(e=>!els.some(o=>o!==e&&o.contains(e)));
  if(roots.length)break;
 }
 const latest=roots.at(-1);
 if(!latest)return {text:'',count:0,source:'no-assistant-root',truncated:false};
 const clone=latest.cloneNode(true);
 clone.querySelectorAll('script,style,button,[role="button"],[role="status"],[data-part-type="reasoning"],[data-type="reasoning"],[data-testid="reasoning-panel"],[data-testid="reasoning-block"],[data-testid="thinking-panel"],[data-testid="thinking-block"],[data-part-type^="tool"],[data-type^="tool"],[data-testid^="tool-"],[data-tool-name],[data-tool-call-id]').forEach(e=>e.remove());
 // Keep code blocks and their source, never execute or render extracted HTML.
 clone.querySelectorAll('p,div,pre,li,br').forEach(e=>e.appendChild(document.createTextNode('\n')));
 const text=(clone.textContent||'').trim();
 return {text:text.slice(0,1000000),count:roots.length,source:'latest-assistant-excluding-reasoning-tools',truncated:text.length>1000000};
}'''

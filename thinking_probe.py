"""Read-only, selected-page diagnostics. No prompt/body/URL/cookie capture.
Human annotations are observations of UI, not proof of hidden internal reasoning.
"""
import asyncio
from collections import OrderedDict
import json
import time
import uuid
from urllib.parse import urlparse
from fastapi import HTTPException
from experiments.gacha_probe.probe import READ_STATUS

DISCOVER = r'''() => {
const old=OLD_DETECTOR();
const existing={state:old.state,thinking:old.thinking_explicit,generating:old.generating,reasoning_panel:old.reasoning_panel_visible,stop_count:old.stop_count,composer_ready:old.composer_ready,has_turn_id:!!old.turn_id};
const visible=e=>{if(!e||!e.isConnected||e.closest('[hidden],[aria-hidden="true"]'))return false;const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false}return true};
const excluded=e=>!!e.closest('pre,code,blockquote,textarea,input,[contenteditable="true"],iframe,[data-testid*="preview"],.preview,[data-message-role="user"],[data-message-author-role="user"],[data-role="user"]');
let roots=[...document.querySelectorAll('[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"],[data-testid="assistant-turn"]')].filter(visible);
roots=roots.filter(e=>!roots.some(p=>p!==e&&p.contains(e)));const last=roots.at(-1);
function path(e){const a=[];for(let n=e;n&&n.nodeType===1&&a.length<9;n=n.parentElement){let index=1;for(let p=n.previousElementSibling;p;p=p.previousElementSibling)if(p.tagName===n.tagName)index++;a.unshift(n.tagName.toLowerCase()+':nth-of-type('+index+')');if(n===document.body)break}return a.join(' > ')}
function meta(e){const a={};for(const x of e.attributes){if(Object.keys(a).length>=12)break;if(!/^(role|data-[a-z0-9_-]+|aria-busy|aria-expanded|aria-hidden)$/.test(x.name))continue;if(/^(true|false|open|closed|complete|completed|done|streaming|thinking|reasoning|pending|running|loading|in-progress|button|status|alert|assistant|user)$/i.test(x.value)||x.name==='data-testid'&&/^[a-z_-]*(thinking|reasoning|streaming|loading|message|assistant)[a-z_-]*$/i.test(x.value))a[x.name]=x.value}
const s=getComputedStyle(e);return {tag:e.tagName.toLowerCase(),attributes:a,signal_classes:[...e.classList].filter(x=>/think|reason|stream|load|spin|pulse|shimmer|animate/.test(x)&&/^[a-zA-Z0-9_:.-]{1,70}$/.test(x)).slice(0,8),animated:s.animationName!=='none',animation_names:s.animationName.split(',').map(x=>x.trim()).filter(x=>/^[a-zA-Z0-9_-]{1,60}$/.test(x)).slice(0,4)}}
function label(e){let text=(e.getAttribute('aria-label')||e.textContent||'').trim();if(text.length>100)return null;text=text.replace(/\s+/g,' ');
if(/^(thinking|思考中|正在思考)(?:[.。… ]|\d|s|秒)*$/i.test(text))return 'thinking';
if(/^(thought for .{1,70}|已思考.{0,50}|思考了.{0,50})$/i.test(text))return 'thought-duration';
if(/^(reasoning|推理中)(?:\.{1,3}|…)?$/i.test(text))return 'reasoning-label';
if(/^(stop|stop generating|stop generation|stop response|停止|停止生成|停止响应)$/i.test(text))return 'stop-control';return null}
const labels=[],stops=[];let inspected=0;
for(const e of document.querySelectorAll('button,[role="button"],[role="status"],summary,span,div,[data-testid]')){
if(++inspected>8000)break;if(excluded(e)||!visible(e))continue;const kind=label(e);if(!kind)continue;
// Keep the deepest matching label, instead of repeatedly recording wrapper text.
if([...e.children].some(c=>visible(c)&&label(c)===kind))continue;
const row={kind,path:path(e),in_last_assistant:last?last.contains(e):null,in_form:!!e.closest('form'),ancestors:[]};
for(let n=e,i=0;n&&i<5;n=n.parentElement,i++)row.ancestors.push(meta(n));
if(kind==='stop-control'){if(stops.length<8)stops.push(row)}else if(labels.length<12)labels.push(row);
}
return {existing,assistant_roots:roots.length,discovered_labels:labels,discovered_stop_controls:stops,scan_truncated:inspected>8000};
}'''.replace('OLD_DETECTOR()', '('+READ_STATUS+')()')


def allowed(page):
    p=urlparse(page.url)
    return p.scheme=='https' and p.netloc=='arena.ai' and (p.path=='/agent' or p.path.startswith('/agent/'))


class ThinkingProbe:
    def __init__(self,manager):
        self.manager=manager;self.pages={};self.sessions=OrderedDict();self.lock=asyncio.Lock()
    def list_pages(self):
        old={id(v[1]):key for key,v in self.pages.items()};new={};rows=[]
        for eid,context in list(self.manager.contexts.items()):
            for index,page in enumerate(list(context.pages)[-12:]):
                if page.is_closed() or not allowed(page):continue
                key=old.get(id(page),uuid.uuid4().hex);new[key]=(eid,page,context)
                rows.append({'key':key,'label':'环境 '+eid[:8]+' · 页面 '+str(index+1),'route':'conversation' if urlparse(page.url).path.rstrip('/')!='/agent' else 'home'})
                if len(new)>=64:break
            if len(new)>=64:break
        self.pages=new
        return rows
    def page(self,key):
        value=self.pages.get(key)
        if not value:raise HTTPException(404,'请选择仍然打开的任务页')
        eid,page,context=value
        if self.manager.contexts.get(eid) is not context or page.is_closed() or not allowed(page):
            raise HTTPException(409,'页面已关闭、换环境或离开 Agent；不读取该页面')
        return page
    async def sample(self,key,mark='unmarked'):
        if mark not in ('unmarked','visible-thinking','thinking-ended','reply-completed','uncertain'):
            raise HTTPException(422,'无效人工标记')
        async with self.lock:
            page=self.page(key)
            route_before=urlparse(page.url).path
            try:result=await asyncio.wait_for(page.evaluate(DISCOVER),timeout=4)
            except Exception:raise HTTPException(409,'页面正在切换或无法读取，请稍后重新采样') from None
            self.page(key)  # Do not retain results from a page that left the allowed origin.
            if urlparse(page.url).path!=route_before:raise HTTPException(409,'页面刚刚导航，请稍后重新采样')
            now=time.monotonic()
            if key not in self.sessions:
                while len(self.sessions)>=3:self.sessions.popitem(last=False)
                self.sessions[key]={'started':now,'samples':[],'dropped':0,'route':route_before,'epoch':1}
            session=self.sessions[key];self.sessions.move_to_end(key)
            if session['route']!=route_before:
                session['route']=route_before;session['epoch']+=1
            row={'page_epoch':session['epoch'],'elapsed_ms':round((now-session['started'])*1000),'human_mark':mark,**result}
            session['samples'].append(row)
            if len(session['samples'])>120:session['samples'].pop(0);session['dropped']+=1
            return {'sample':row,'count':len(session['samples']),'dropped':session['dropped']}
    def report(self,key):
        session=self.sessions.get(key)
        if not session:raise HTTPException(404,'尚无采样数据')
        samples=session['samples'];marked=[s for s in samples if s['human_mark']!='unmarked']
        return {'format':'harbor-thinking-diagnostic-v1','read_only':True,'prompt_or_reasoning_body_included':False,
                'urls_or_cookies_included':False,'dropped_samples':session['dropped'],
                'comparison':{'human_marked_samples':len(marked),
                 'existing_rule_missed_human_thinking':sum(s['human_mark']=='visible-thinking' and not s['existing']['thinking'] for s in marked),
                 'existing_rule_positive_after_human_end':sum(s['human_mark'] in ('thinking-ended','reply-completed') and s['existing']['thinking'] for s in marked)},
                'limits':'Human labels describe visible UI only. Discovered labels do not establish active thinking or model identity.',
                'samples':samples}


PROBE_UI = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Thinking 只读检测</title><style>
body{font:16px system-ui;background:#f3f6f8;color:#18323e;max-width:1100px;margin:32px auto;padding:0 20px}section{padding:22px;margin:18px 0;border:1px solid #dce4e8;border-radius:12px;background:white}button,select{font:inherit;padding:10px 14px;margin:5px;border-radius:7px;border:1px solid #a6b9c2;background:white}button{cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:540px;overflow:auto;font-size:13px}.muted{color:#617582}strong{color:#176a59}#error{color:#b33}a{color:#176a59}</style>
<h1>Thinking 只读检测</h1><p><a href="/">返回管理器</a></p><section><b>用途：找到真实界面状态与现有规则之间的差异，不自动作出停止决定。</b><p>不发题、不停止、不归档，不收集提示词、思考正文、Cookie 或完整地址。只读选定的 Agent 页面；人工标记代表你看到的界面，不证明模型内部状态。</p><p>请先关闭任务设置里的自动 Thinking 停止与自动归档，再手动在目标页开始测试。检测工具不会代你更改这些开关。</p></section>
<section><button id="refresh">刷新页面列表</button><select id="pages"></select><button id="once">采样一次</button><button id="watch">连续采样（最多2分钟）</button><button id="stop">停止采样</button><a id="export" hidden>下载诊断 JSON</a><p id="error"></p><p id="status" class="muted">请选择目标页。页面列表不包含对话内容。</p></section>
<section><h2>人工对照标记</h2><button data-mark="visible-thinking">我看到正在 Thinking</button><button data-mark="thinking-ended">Thinking 已结束</button><button data-mark="reply-completed">回复已完成</button><button data-mark="uncertain">不确定</button><p>看到状态变化时点击对应按钮，会立即采样，便于核对漏报与误报。</p></section>
<section><h2>最新检测</h2><p id="verdict">尚未采样</p><pre id="result"></pre></section><script>
const $=id=>document.getElementById(id);let timer=null,busy=false,until=0;
async function api(path,method='GET',body){const r=await fetch('/api/thinking-probe/'+path,{method,headers:{'Content-Type':'application/json','X-Manager-Request':'1'},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok){const e=Error(d.detail||'读取失败');e.status=r.status;throw e}return d}
function halt(){clearTimeout(timer);timer=null;$('watch').disabled=false}
async function refresh(){halt();try{const d=await api('pages');$('pages').replaceChildren();for(const p of d.pages){const o=document.createElement('option');o.value=p.key;o.textContent=p.label+' · '+(p.route==='home'?'Agent 首页':'对话页');$('pages').append(o)}$('status').textContent='找到 '+d.pages.length+' 个可读取页面';$('error').textContent=''}catch(e){$('error').textContent=e.message}}
async function sample(mark='unmarked'){if(busy)return;const key=$('pages').value;if(!key){$('error').textContent='请先打开一个 Agent 页面并刷新列表';return}busy=true;try{const d=await api(key+'/sample','POST',{mark});if(key!==$('pages').value)return;$('error').textContent='';const s=d.sample;$('verdict').textContent='现有规则：'+(s.existing.thinking?'命中 Thinking':'未命中/未知')+'；可见候选标签 '+s.discovered_labels.length+'；停止控件 '+s.discovered_stop_controls.length+'（仅线索，不自动判定）';$('status').textContent='已保留 '+d.count+' 个样本，丢弃旧样本 '+d.dropped+' 个';$('result').textContent=JSON.stringify(s,null,2);$('export').hidden=false;$('export').href='/api/thinking-probe/'+key+'/report';$('export').textContent='下载诊断 JSON'}catch(e){$('error').textContent=e.message;if(e.status!==409)halt()}finally{busy=false}}
async function tick(){if(Date.now()>=until){halt();return}await sample();if($('watch').disabled)timer=setTimeout(tick,1000)}
$('refresh').onclick=refresh;$('once').onclick=()=>sample();$('stop').onclick=halt;$('pages').onchange=()=>{halt();$('export').hidden=true;$('result').textContent='';$('verdict').textContent='已切换目标，请重新采样'};$('watch').onclick=()=>{halt();until=Date.now()+120000;$('watch').disabled=true;tick()};document.querySelectorAll('[data-mark]').forEach(b=>b.onclick=()=>sample(b.dataset.mark));window.addEventListener('pagehide',halt);refresh();
</script></html>'''

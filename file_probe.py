"""Explicit 90-second file observation on one existing Arena page.
No cookies, request headers, query strings, reasoning text, or API JSON bodies.
No navigation, sending, stopping, tab closing or history pruning.
"""
import asyncio
import hashlib
import re
import time
import uuid
from urllib.parse import urlsplit
from fastapi import HTTPException
from html_results import complete_html, MAX_BYTES, collect_html


def public_url(url):
    p=urlsplit(url)
    if p.scheme not in ('http','https'):return p.scheme+':'
    origin=f'{p.scheme}://{p.hostname or ""}'
    if (p.hostname or '').endswith('.arena.site'):
        filename=p.path.rsplit('/',1)[-1]
        safe_name=filename if re.fullmatch(r'[\w .-]{1,120}\.html?',filename,re.I) else 'resource'
        return origin+'/[protected-path]/'+safe_name
    return origin+p.path


class FileProbe:
    def __init__(self,manager):self.manager=manager;self.sessions={};self.pages={}
    def page_list(self,eid):
        context=self.manager.require_context(eid)
        self.pages={k:v for k,v in self.pages.items() if not v[1].is_closed() and self.manager.contexts.get(v[0]) is v[2]}
        rows=[]
        for page in context.pages:
            if urlsplit(page.url).hostname!='arena.ai':continue
            key=next((k for k,v in self.pages.items() if v[1] is page),None)
            if key is None:key=uuid.uuid4().hex;self.pages[key]=(eid,page,context)
            rows.append({'key':key,'url':public_url(page.url)})
        return rows
    def get_page(self,key):
        value=self.pages.get(key)
        if not value or value[1].is_closed() or self.manager.contexts.get(value[0]) is not value[2]:
            raise HTTPException(409,'页面已关闭或环境已变化，请重新选择')
        if urlsplit(value[1].url).hostname!='arena.ai':raise HTTPException(409,'只检查选定的 Arena 对话页')
        return value[1]
    def finish(self,key):
        state=self.sessions.get(key)
        if state and not state['closed']:
            state['closed']=True
            state['page'].remove_listener('response',state['response_listener'])
            state['page'].remove_listener('download',state['download_listener'])
            if state.get('timer'):state['timer'].cancel()
            for task in list(state['pending']):task.cancel()
    def start(self,key):
        page=self.get_page(key)
        self.finish(key)
        # Keep at most two captures in memory; this tool is not a new result database.
        for old in list(self.sessions):
            if old!=key:self.finish(old);self.sessions.pop(old,None)
        s={'page':page,'url':page.url,'events':[],'files':[],'pending':set(),'closed':False,'started':time.monotonic()}
        self.sessions[key]=s
        def launch(coro):
            if s['closed'] or len(s['pending'])>=4:coro.close();return
            task=asyncio.create_task(coro);s['pending'].add(task)
            def done(t):
                s['pending'].discard(t)
                if not t.cancelled():t.exception()
            task.add_done_callback(done)
        s['response_listener']=lambda response:launch(self.response(s,response))
        s['download_listener']=lambda download:launch(self.download(s,download))
        page.on('response',s['response_listener']);page.on('download',s['download_listener'])
        s['timer']=asyncio.get_running_loop().call_later(90,self.finish,key)
        return self.status(key)
    def event(self,s,data):
        s['events'].append(data);s['events']=s['events'][-40:]
    def keep(self,s,text,source,name):
        if s['closed'] or s['page'].is_closed() or s['page'].url!=s['url'] or not complete_html(text):return
        digest=hashlib.sha256(text.encode()).hexdigest()
        if any(f['sha256']==digest for f in s['files']):return
        s['files'].append({'html':text,'source':source,'filename':name[:100],'bytes':len(text.encode()),'sha256':digest})
        s['files']=s['files'][-2:]
    async def response(self,s,response):
        if s['page'].url!=s['url']:return
        headers=response.headers
        kind=headers.get('content-type','').split(';')[0]
        disposition=headers.get('content-disposition','')
        path=urlsplit(response.url).path
        html_file=bool(re.search(r'\.html?$',path,re.I) or re.search(r'filename[^;]*\.html?',disposition,re.I))
        relevant=html_file or ('html' in kind and response.request.resource_type=='document') or bool(re.search(r'/(?:api/)?(?:files|artifacts|downloads)/',path))
        if not relevant:return
        self.event(s,{'channel':'response','url':public_url(response.url),'status':response.status,'type':kind,'html_filename':html_file})
        # Main application HTML and generic JSON endpoints are never collected.
        length=headers.get('content-length','')
        if not html_file or response.status!=200 or not length.isdigit() or int(length)>MAX_BYTES:return
        try:
            raw=await response.body()
            if len(raw)<=MAX_BYTES:self.keep(s,raw.decode('utf-8-sig'),'observed-html-response',path.rsplit('/',1)[-1] or 'result.html')
        except Exception:self.event(s,{'channel':'response','result':'body_unavailable'})
    async def download(self,s,download):
        name=download.suggested_filename
        if not re.search(r'\.html?$',name,re.I):return
        self.event(s,{'channel':'download','filename':name[:100],'url':public_url(download.url)})
        try:
            path=await asyncio.wait_for(download.path(),timeout=15)
            from pathlib import Path
            p=Path(path)
            if p.stat().st_size<=MAX_BYTES:self.keep(s,p.read_text(encoding='utf-8-sig'),'browser-html-download',name)
        except Exception:self.event(s,{'channel':'download','result':'download_unavailable'})
    async def inspect(self,key):
        page=self.get_page(key)
        if key not in self.sessions or self.sessions[key]['closed'] or self.sessions[key]['url']!=page.url:self.start(key)
        s=self.sessions[key]
        text,source=await asyncio.wait_for(collect_html(page,{}),timeout=12)
        if text:self.keep(s,text,source,'result.html')
        else:self.event(s,{'channel':'visible-content','result':'no_complete_html'})
        return self.status(key)
    def status(self,key):
        s=self.sessions.get(key)
        if not s:raise HTTPException(404,'请先开启探测')
        return {'active':not s['closed'],'events':s['events'],'files':[{k:v for k,v in f.items() if k!='html'} for f in s['files']]}
    def content(self,key,index):
        s=self.sessions.get(key)
        if not s or not 0<=index<len(s['files']):raise HTTPException(404,'未捕获到 HTML')
        return s['files'][index]['html']


PROBE_PAGE='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Harbor 文件探测</title><style>body{font:16px/1.8 system-ui;max-width:1050px;margin:40px auto;padding:0 20px;color:#234448}button,select{font:inherit;padding:8px;margin:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f5f5;padding:16px}textarea{width:100%;height:280px}a{color:#23776b}</style><h1>工作空间 HTML 文件探测</h1><p>只检查你选定的已有对话，不发题、不停止任务、不关闭页面。先在对应账号中打开原对话。</p><p>开启探测后，请切回 Arena，手动点击已有 HTML 文件的“查看”或“下载”。监听 90 秒，只记录文件请求元信息，不记录 Cookie、认证头、查询参数或思考正文。</p><select id="env"></select><button id="pages">列出对话页</button><br><select id="page"></select><button id="watch">开启文件探测</button><button id="read">尝试读取已显示的 HTML</button><button id="stop">结束探测</button><pre id="status">等待选择环境</pre><div id="files"></div><textarea id="source" readonly placeholder="捕获到的 HTML 原文仅作为文本显示，不执行"></textarea><script>
const $=id=>document.getElementById(id);let activeKey=null,shown='';
async function api(path,method='GET'){const r=await fetch('/api/'+path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Manager-Request':'1'},body:method==='GET'?undefined:'{}'});const d=await r.json();if(!r.ok)throw Error(d.detail||'请求失败');return d}
function fail(e){$('status').textContent=e.message}
async function show(s){$('status').textContent=JSON.stringify(s,null,2);const sig=JSON.stringify(s.files);if(sig===shown)return;shown=sig;$('files').replaceChildren();for(const [i,f] of s.files.entries()){const b=document.createElement('button');b.textContent='查看原文 · '+f.filename+' · '+f.bytes+' 字节';b.onclick=async()=>{try{const d=await api('file-probe/'+activeKey+'/content?index='+i);$('source').value=d.html}catch(e){fail(e)}};$('files').append(b)}}
$('pages').onclick=async()=>{try{const d=await api('file-probe/pages?eid='+encodeURIComponent($('env').value));$('page').replaceChildren();for(const p of d.pages){const o=document.createElement('option');o.value=p.key;o.textContent=p.url;$('page').append(o)}$('status').textContent=d.pages.length?'请选择对话页':'没有 Arena 页；请先在该环境打开原对话'}catch(e){fail(e)}};
$('watch').onclick=async()=>{try{const key=$('page').value;if(!key)throw Error('请先选择对话页');activeKey=key;shown='';await show(await api('file-probe/'+key+'/watch','POST'))}catch(e){fail(e)}};
$('read').onclick=async()=>{try{const key=$('page').value;if(!key)throw Error('请先选择对话页');activeKey=key;await show(await api('file-probe/'+key+'/inspect','POST'))}catch(e){fail(e)}};
$('stop').onclick=async()=>{try{if(activeKey)await show(await api('file-probe/'+activeKey+'/stop','POST'))}catch(e){fail(e)}};
setInterval(async()=>{if(activeKey)try{await show(await api('file-probe/'+activeKey))}catch(e){fail(e)}},1500);
api('environments').then(d=>{for(const e of d.environments.filter(e=>e.status==='running')){const o=document.createElement('option');o.value=e.id;o.textContent=e.name;$('env').append(o)}if(!$('env').options.length)$('status').textContent='没有已打开环境。请先在管理器启动对应账号的环境，并打开已有 HTML 的对话。'}).catch(fail);
</script></html>'''

"""Local HTML artifacts; bounded retention, no credentials in snapshots."""
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlparse
from fastapi import HTTPException

LIMIT=100
MAX_BYTES=2_000_000
READ_CANDIDATES=r'''() => {
 const selector='[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"],[data-testid="assistant-turn"]';
 let roots=[...document.querySelectorAll(selector)];roots=roots.filter(e=>!roots.some(p=>p!==e&&p.contains(e)));
 const root=roots.at(-1);if(!root)return {code:[],links:[],srcdoc:[]};
 const code=[...root.querySelectorAll('pre')].map(e=>e.textContent||'').filter(t=>t.length<=2000000);
 const links=[...root.querySelectorAll('a[href]')].map(a=>({url:a.href,name:a.getAttribute('download')||a.textContent||''})).filter(x=>/\.html?(?:$|[?#\s])/i.test(x.url+' '+x.name)).slice(-8);
 // Only an explicit inline preview belonging to this assistant turn; never page.content().
 const srcdoc=[...root.querySelectorAll('iframe[srcdoc]')].map(f=>f.getAttribute('srcdoc')).filter(t=>t&&t.length<=2000000);
 return {code:code.slice(-8),links,srcdoc:srcdoc.slice(-2)};
}'''


def now():return datetime.now(timezone.utc).isoformat()


def complete_html(text):
    if not isinstance(text,str) or len(text.encode('utf-8'))>MAX_BYTES:return False
    s=text.lstrip('\ufeff \t\r\n')
    return bool(re.match(r'(?:<!doctype\s+html[^>]*>\s*)?<html\b',s,re.I) and re.search(r'</html>\s*$',s,re.I))


def from_answer(text):
    # No concatenation, no invented wrapper around partial fragments.
    if complete_html(text):return text
    blocks=re.findall(r'```(?:html|htm)?\s*\n(.*?)\n```',text or '',re.S|re.I)
    return next((b for b in reversed(blocks) if complete_html(b)),None)


async def collect_html(page,job):
    try:data=await page.evaluate(READ_CANDIDATES)
    except Exception:data={}
    for source,items in [('assistant-code-block',data.get('code',[])),('assistant-srcdoc',data.get('srcdoc',[]))]:
        for text in reversed(items):
            candidate=from_answer(text)
            if candidate:return candidate,source
    # Strictly bounded same-origin downloads, without redirects; never send cookies to another host.
    origin=urlparse(page.url)
    for link in reversed(data.get('links',[])):
        u=urlparse(link['url'])
        if u.scheme!='https' or (u.scheme,u.netloc)!=(origin.scheme,origin.netloc):continue
        if not re.match(r'^/(?:api/)?(?:files|artifacts|downloads)/',u.path):continue
        response=None
        try:
            response=await page.request.get(link['url'],timeout=3000,max_redirects=0)
            if response.status!=200:continue
            length=response.headers.get('content-length')
            if length and int(length)>MAX_BYTES:continue
            raw=await response.body()
            if len(raw)>MAX_BYTES:continue
            text=raw.decode('utf-8-sig')
            if complete_html(text):return text,'same-origin-html-download'
        except Exception:pass
        finally:
            if response is not None:await response.dispose()
    for turn in reversed(job.get('turns',[])):
        text=from_answer(turn.get('raw_text',''))
        if text:return text,'captured-answer-code'
    return None,'not_found'


class PreviewSanitizer(HTMLParser):
    """Presentation only; original bytes remain available as an attachment.
    CSP and iframe sandbox are mandatory even after this small sanitizer.
    """
    def __init__(self):super().__init__(convert_charrefs=False);self.parts=[];self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag=='script':self.skip+=1;return
        if self.skip or tag in ('meta','base','iframe','object','embed'):return
        from html import escape
        attrs=[(k,v) for k,v in attrs if not k.startswith('on') and not (tag in ('a','form') and k in ('href','action','target'))]
        self.parts.append('<'+tag+''.join(' '+k+('="'+escape(v,quote=True)+'"' if v is not None else '') for k,v in attrs)+'>')
    def handle_startendtag(self,tag,attrs):
        if tag=='script':return
        self.handle_starttag(tag,attrs)
        if self.parts and not self.skip and tag not in ('meta','base','iframe','object','embed'):self.parts[-1]=self.parts[-1][:-1]+'/>'
    def handle_endtag(self,tag):
        if tag=='script':self.skip=max(0,self.skip-1);return
        if not self.skip and tag not in ('meta','base','iframe','object','embed'):self.parts.append('</'+tag+'>')
    def handle_data(self,data):
        if not self.skip:self.parts.append(data)
    def handle_entityref(self,name):
        if not self.skip:self.parts.append('&'+name+';')
    def handle_charref(self,name):
        if not self.skip:self.parts.append('&#'+name+';')


def preview_html(source):
    parser=PreviewSanitizer();parser.feed(source)
    policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'"
    return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+''.join(parser.parts)


class HtmlResults:
    def __init__(self,history):self.history=history
    @property
    def db(self):return self.history.manager.db
    def initialize(self):
        if not self.db.execute("SELECT 1 FROM sqlite_master WHERE name='html_results'").fetchone():
            path=Path(self.db.execute('PRAGMA database_list').fetchone()[2])
            if path.is_file() and not self.db.in_transaction:
                folder=path.parent/'migration-backups';folder.mkdir(exist_ok=True)
                dest=folder/('before-html-gallery-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')+'.sqlite3')
                backup=sqlite3.connect(dest)
                try:self.db.backup(backup)
                finally:backup.close()
        with self.db:
            self.db.execute('''CREATE TABLE IF NOT EXISTS html_results (
             record_id TEXT PRIMARY KEY,saved_at TEXT NOT NULL,source TEXT NOT NULL,
             content TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,
             account_id TEXT NOT NULL,account_name TEXT NOT NULL,account_email TEXT NOT NULL)''')
            self.db.execute('CREATE TABLE IF NOT EXISTS html_pruned (record_id TEXT PRIMARY KEY)')
            self.db.execute('CREATE TABLE IF NOT EXISTS html_file_cleanup (filename TEXT PRIMARY KEY)')
        self.clean_files()
    def pruned(self,rid):return bool(self.db.execute('SELECT 1 FROM html_pruned WHERE record_id=?',(rid,)).fetchone())
    def clean_files(self):
        for row in self.db.execute('SELECT filename FROM html_file_cleanup').fetchall():
            name=row[0]
            if not re.fullmatch(r'[0-9a-f]{32}\.(?:png|html)',name):continue
            try:(self.history.artifacts/name).unlink(missing_ok=True)
            except OSError:continue
            with self.db:self.db.execute('DELETE FROM html_file_cleanup WHERE filename=?',(name,))
    def save(self,run,job,content,source):
        rid=job['record_id']
        if job['status']!='success' or not complete_html(content) or self.pruned(rid):return False
        account=run.get('account_snapshot') or {}
        raw=content.encode('utf-8')
        with self.db:
            if not self.db.execute('SELECT 1 FROM task_records WHERE id=?',(rid,)).fetchone():return False
            self.db.execute('''INSERT OR IGNORE INTO html_results VALUES (?,?,?,?,?,?,?,?,?)''',
                (rid,now(),source,content,hashlib.sha256(raw).hexdigest(),len(raw),account.get('id',''),account.get('name',''),account.get('email','')))
            old=self.db.execute('SELECT record_id FROM html_results ORDER BY saved_at DESC,rowid DESC LIMIT -1 OFFSET ?',(LIMIT,)).fetchall()
            for row in old:
                dead=row[0]
                self.db.execute('INSERT OR IGNORE INTO html_pruned VALUES (?)',(dead,))
                self.db.execute('DELETE FROM html_results WHERE record_id=?',(dead,))
                self.db.execute('DELETE FROM task_records WHERE id=?',(dead,))
                for extension in ('png','html'):
                    self.db.execute('INSERT OR IGNORE INTO html_file_cleanup VALUES (?)',(dead+'.'+extension,))
                self.history.cache.pop(dead,None)
        self.clean_files()
        return not self.pruned(rid)
    def metadata(self,rid):
        row=self.db.execute('SELECT record_id,saved_at,source,sha256,bytes,account_id,account_name,account_email FROM html_results WHERE record_id=?',(rid,)).fetchone()
        return dict(row) if row else None
    def list(self,q='',kind='',rating='',starred=False):
        self.clean_files()
        where=[];args=[]
        if q:
            where.append('(h.account_name LIKE ? OR h.account_email LIKE ? OR r.environment_name LIKE ? OR r.tags LIKE ? OR r.note LIKE ?)');args+=['%'+q+'%']*5
        if kind:where.append('r.kind=?');args.append(kind)
        if rating:where.append('r.rating=?');args.append(rating)
        if starred:where.append('r.starred=1')
        sql='''SELECT h.record_id AS id,h.saved_at,h.source,h.bytes,h.account_name,h.account_email,
          r.environment_name,r.kind,r.number,r.rating,r.starred,r.note,r.tags,
          CASE WHEN json_valid(r.payload) THEN json_extract(r.payload,'$.html_candidate') END AS _candidate_json
          FROM html_results h JOIN task_records r ON r.id=h.record_id'''
        if where:sql+=' WHERE '+' AND '.join(where)
        rows=self.db.execute(sql+' ORDER BY h.saved_at DESC,h.rowid DESC',args).fetchall()
        results=[]
        for row in rows:
            item=dict(row)
            raw=item.pop('_candidate_json',None)
            try:metrics=json.loads(raw) if raw else None
            except (TypeError,ValueError):metrics=None
            item['html_candidate']=metrics if isinstance(metrics,dict) else None
            results.append(item)
        return {'results':results,'total':self.db.execute('SELECT count(*) FROM html_results').fetchone()[0],'limit':LIMIT}
    def source(self,rid):
        row=self.db.execute('SELECT content FROM html_results WHERE record_id=?',(rid,)).fetchone()
        if not row:raise HTTPException(404,'HTML 结果不存在或已超过保留上限被删除')
        return row[0]

# Only URLs actually observed on this task's page are eligible. Signed paths
# stay in memory and must never be serialized into records or error messages.
def workspace_html_url(url):
    try:
        p=urlparse(url)
        return (p.scheme=='https' and not p.username and not p.password
                and p.port in (None,443)
                and bool(re.fullmatch(r'ws-[0-9a-f-]{36}\.arena\.site',p.hostname or ''))
                and bool(re.search(r'/[^/]+\.html?$',p.path,re.I)))
    except ValueError:return False


def read_workspace_file(url):
    import urllib.request
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    if not workspace_html_url(url):return None
    # Do not forward the browser's Cookie or Authorization headers.
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with opener.open(urllib.request.Request(url,headers={'Accept':'text/html'}),timeout=3) as response:
            if response.status!=200:return None
            raw=response.read(MAX_BYTES+1)
            if len(raw)>MAX_BYTES:return None
            text=raw.decode('utf-8-sig')
            return text if complete_html(text) else None
    except Exception:return None


class TaskHtmlCapture:
    def __init__(self,page):
        import asyncio
        self.page=page;self.armed=False;self.closed=False
        self.pending=set();self.urls=[];self.latest=None;self.sequence=0;self.accepted=-1
        self.response_listener=lambda response:self.launch(self.response(response))
        self.download_listener=lambda download:self.launch(self.download(download))
        page.on('response',self.response_listener);page.on('download',self.download_listener)
    def arm(self):self.armed=True
    def launch(self,coro):
        import asyncio
        if not self.armed or self.closed or len(self.pending)>=2:
            coro.close();return
        task=asyncio.create_task(coro);self.pending.add(task)
        def done(t):
            self.pending.discard(t)
            if not t.cancelled():t.exception()
        task.add_done_callback(done)
    def accept(self,text,source,sequence):
        if not self.closed and self.armed and sequence>=self.accepted and complete_html(text):
            self.latest=(text,source);self.accepted=sequence
    async def response(self,response):
        import asyncio
        if not workspace_html_url(response.url) or response.status!=200:return
        self.urls=[u for u in self.urls if u!=response.url]+[response.url];self.urls=self.urls[-3:]
        self.sequence+=1;sequence=self.sequence
        try:
            length=response.headers.get('content-length','')
            if length.isdigit() and int(length)>MAX_BYTES:return
            raw=await asyncio.wait_for(response.body(),timeout=4)
            if len(raw)<=MAX_BYTES:self.accept(raw.decode('utf-8-sig'),'workspace-html-response',sequence)
        except Exception:pass
    async def download(self,download):
        import asyncio
        if not re.search(r'\.html?$',download.suggested_filename,re.I):return
        self.sequence+=1;sequence=self.sequence
        try:
            path=await asyncio.wait_for(download.path(),timeout=4)
            if path and Path(path).stat().st_size<=MAX_BYTES:
                self.accept(Path(path).read_text(encoding='utf-8-sig'),'browser-html-download',sequence)
        except Exception:pass
    async def result(self):
        import asyncio
        if self.closed or not self.armed:return None
        if self.pending:await asyncio.wait(tuple(self.pending),timeout=4)
        if self.latest:return self.latest
        # File viewer URLs may be present even when the response was cached.
        # No clicks, guessed filenames, tokens reconstructed from IDs, or page DOM snapshots.
        try:
            links=await self.page.evaluate('''() => [...document.querySelectorAll('iframe[src],a[href]')].map(e=>e.src||e.href).slice(-150)''')
        except Exception:links=[]
        candidates=list(self.urls)
        for frame in getattr(self.page,'frames',[]):
            if frame is not self.page.main_frame:candidates.append(frame.url)
        candidates.extend(u for u in links if isinstance(u,str))
        candidates=list(dict.fromkeys(u for u in candidates if workspace_html_url(u)))[-3:]
        for url in reversed(candidates):
            text=await asyncio.to_thread(read_workspace_file,url)
            if text:return text,'workspace-visible-file'
        return self.latest
    def close(self):
        if self.closed:return
        self.closed=True
        self.page.remove_listener('response',self.response_listener)
        self.page.remove_listener('download',self.download_listener)
        for task in tuple(self.pending):task.cancel()
        self.urls.clear();self.latest=None

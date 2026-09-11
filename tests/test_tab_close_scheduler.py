"""Synthetic scheduler tests: no browser, network, credentials or real database."""
import ast, asyncio, time, unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from pathlib import Path
source=ast.parse((Path(__file__).resolve().parents[1] / 'pelican_tasks.py').read_text(encoding='utf-8-sig'))
cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='PelicanTasks')
ns=dict(asyncio=asyncio,time=time,datetime=datetime,timezone=timezone,URL='test',USER='user',READ_REPLY='reply',CHECK_SUBMITTED='check')
exec(compile(ast.Module(body=[cls],type_ignores=[]),'<actual PelicanTasks>','exec'),ns)
Tasks=ns['PelicanTasks']

class Page:
    def __init__(self,ctx,index):
        self.ctx,self.index=ctx,index; self.closed=False;self.listeners=[];self.url='test';self.clicks=0
    def on(self,event,fn): self.listeners.append(fn)
    def remove_listener(self,event,fn): self.listeners.remove(fn)
    def is_closed(self): return self.closed
    def close(self):
        self.closed=True;self.ctx.closed_at=time.monotonic()
        for fn in self.listeners[:]:fn(self)
    async def stage(self,name):
        if self.index==1 and name==self.ctx.stage:
            if self.ctx.action=='error':raise RuntimeError('synthetic failure')
            if self.ctx.action=='stop':
                self.ctx.run['stop'].set()
                for w in self.ctx.run['workers']:w.cancel()
            if self.ctx.action=='whole':
                for p in self.ctx.pages[:]:p.close()
            elif self.ctx.action=='error_before_event':
                self.closed=True;self.ctx.closed_at=time.monotonic()
                raise RuntimeError('Target page closed')
            else:self.close()
            await asyncio.sleep(10)
        await asyncio.sleep(0)
    async def goto(self,*a,**k):await self.stage('goto')
    async def fill(self,*a,**k):await self.stage('typing')
    async def click(self,*a,**k):self.clicks+=1;await self.stage('click')
    def locator(self,*a):return self
    async def count(self):return 0
    async def evaluate(self,*a):return {'count':0,'key':''}
    async def wait_for_function(self,*a,**k):await self.stage('confirming');return self
    async def json_value(self):return 'generating'
    async def dispose(self):pass
class Context:
    def __init__(self,stage,action):
        self.stage,self.action=stage,action;self.pages=[Page(self,0)];self.opened=[];self.closed_at=0
    async def new_page(self):
        p=Page(self,len(self.opened)+1);self.pages.append(p);self.opened.append((time.monotonic(),p));return p
class History:
    def __init__(self):self.cache={};self.saves=0
    def save_run(self,run):self.saves+=1
    async def screenshot(self,run,job,page):await page.stage('screenshot')

async def simulate(stage,action='close',concurrency=1,total=3,locked=False):
    ctx=Context(stage,action)
    manager=SimpleNamespace(contexts={'e':ctx},log=lambda *a:None)
    t=Tasks.__new__(Tasks);t.manager=manager;t.history=History();t.interaction=asyncio.Lock();t.last_send={}
    async def editor(page,run):await page.stage('editor');return page
    async def verify(page,ed,prompt,run,job):
        if stage=='send_wait' and page.index==1:
            asyncio.get_running_loop().call_later(.002,page.close)
        return ed
    async def button(page,ed,run):return page
    async def reply(page,run,job,*a):
        job['turns'][0]['raw_text']='captured partial output'
        if stage=='parallel_reply':
            await asyncio.sleep(.06 if page.index==1 else .09)
            await page.stage('parallel_reply')
        else:
            await page.stage('reply')
    t.wait_editor=editor;t.verify_composer=verify;t.wait_button=button;t.wait_reply=reply
    run=dict(id='r',environment_id='e',status='running',settings=dict(interval=.03,concurrency=concurrency,capture_screenshot=True),stop=asyncio.Event(),context=ctx,workers=[],next=0,opening_gate=asyncio.Lock(),last_open=0.,open_not_before=0.,jobs=[dict(number=i+1,record_id=str(i),status='pending',turns=[dict(prompt='test',status='pending')]) for i in range(total)])
    ctx.run=run
    if stage=='send_wait':t.last_send['e']=time.monotonic()+.04
    if locked:
        await t.interaction.acquire()
        async def closer():
            while not ctx.opened:await asyncio.sleep(.001)
            ctx.opened[0][1].close()
            await asyncio.sleep(.05)
            t.interaction.release()
        asyncio.create_task(closer())
    await asyncio.wait_for(t.execute('e',run),2)
    return t,run,ctx

class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_each_close_stage(self):
        for stage,status in [('goto','cancelled'),('editor','cancelled'),('typing','cancelled'),('send_wait','cancelled'),('click','unknown'),('confirming','unknown'),('reply','untracked'),('screenshot','success')]:
            with self.subTest(stage=stage):
                t,r,c=await simulate(stage)
                self.assertEqual(r['status'],'completed');self.assertEqual(len(c.opened),3)
                self.assertEqual([j['status'] for j in r['jobs']],[status,'success','success'])
                self.assertTrue(all(p.clicks<=1 for _,p in c.opened))
                self.assertTrue(all(not p.listeners for p in c.pages))
                if stage!='screenshot':self.assertGreaterEqual(c.opened[1][0]-c.closed_at,.029)
                if stage in ('reply','screenshot'):self.assertEqual(r['jobs'][0]['turns'][0]['raw_text'],'captured partial output')
    async def test_parallel_continues(self):
        t,r,c=await simulate('parallel_reply',concurrency=2,total=6)
        self.assertEqual(len(c.opened),6);self.assertEqual(sum(j['status']=='success' for j in r['jobs']),5)
        self.assertTrue(all(b[0]-a[0]>=.029 for a,b in zip(c.opened,c.opened[1:])))
    async def test_close_while_waiting_interaction(self):
        t,r,c=await simulate('none',locked=True)
        self.assertEqual(r['jobs'][0]['status'],'cancelled');self.assertEqual(len(c.opened),3)
    async def test_closed_error_before_event(self):
        t,r,c=await simulate('reply','error_before_event')
        self.assertEqual(r['status'],'completed');self.assertEqual(len(c.opened),3)
        self.assertEqual(r['jobs'][0]['status'],'untracked')
    async def test_stop_whole_browser_and_real_error(self):
        for action in ('stop','whole','error'):
            with self.subTest(action=action):
                t,r,c=await simulate('reply',action,concurrency=2,total=6)
                self.assertEqual(r['status'],'stopped');self.assertLess(len(c.opened),6)
    async def test_old_completed_page_listener_detached(self):
        t,r,c=await simulate('none')
        c.opened[0][1].close()
        self.assertFalse(r['stop'].is_set());self.assertTrue(all(j['status']=='success' for j in r['jobs']))
    async def test_extended_deadline_recomputed(self):
        t=Tasks.__new__(Tasks)
        r=dict(stop=asyncio.Event(),last_open=time.monotonic(),settings=dict(interval=.04),open_not_before=0.)
        async def extend():
            await asyncio.sleep(.02);r['open_not_before']=time.monotonic()+.05
        x=asyncio.create_task(extend());await t.wait_open_slot(r);await x
        self.assertGreaterEqual(time.monotonic(),r['open_not_before'])

if __name__=='__main__':unittest.main(verbosity=2)

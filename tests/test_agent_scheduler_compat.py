"""Offline current-Agent DOM and real scheduler regressions; no account/network."""
import asyncio,sys,time,unittest
from datetime import datetime,timezone
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from playwright.async_api import async_playwright
from arena_task_dom import READ_REPLY,send_surface
from reply_capture import READ_OUTPUT
from pelican_tasks import PelicanTasks,TaskSettings,FIND_INPUT

URL='https://arena.ai/agent'
REVIEW='<section id="review"><button aria-label="Close review panel">x</button><div><button>是</button><button>否</button><button>继续工作</button></div></section>'
USER='<div data-agent-transcript-message="true" data-chat-message-id="u1" class="scroll-mt-[72px] md:scroll-mt-16">own prompt</div>'
ANSWER='<div data-agent-transcript-message="true" data-chat-message-id="a1"><div class="prose"><p>OK</p></div><time>1 second ago</time></div>'
PAGE='''<main><div role="log"></div><form><textarea style="width:400px;height:60px"></textarea><button type="submit" aria-label="Send">Send</button></form></main><div id="arena-trace-inspector-hud" style="position:fixed;inset:0;z-index:9999;background:white"><textarea>HUD only</textarea><button>Stop</button></div><script>
window.sendCount=0;window.voteCount=0;
document.querySelector('form').onsubmit=e=>{e.preventDefault();window.sendCount++;
 const log=document.querySelector('[role=log]'),u=document.createElement('div');u.setAttribute('data-agent-transcript-message','true');u.setAttribute('data-chat-message-id','u1');u.className='scroll-mt-[72px] md:scroll-mt-16';u.textContent=document.querySelector('form textarea').value;log.append(u);document.querySelector('form').remove();
 setTimeout(()=>{log.insertAdjacentHTML('beforeend',ANSWER);document.querySelector('main').insertAdjacentHTML('beforeend',REVIEW);document.querySelectorAll('#review button').forEach(b=>b.onclick=()=>window.voteCount++);setInterval(()=>document.querySelector('time').textContent=String(Date.now()),100)},20);
};</script>'''.replace('ANSWER;',repr(ANSWER)+';') # Script values inserted below.
# JSON literals are safe JS strings for this entirely local fixture.
import json
PAGE=PAGE.replace("'beforeend',ANSWER", "'beforeend',"+json.dumps(ANSWER)).replace("'beforeend',REVIEW", "'beforeend',"+json.dumps(REVIEW))

class Capture:
 def arm(self):pass
 def close(self):pass
class History:
 def __init__(self):self.cache={}
 def save_run(self,*a):pass
 def save_job(self,*a):pass
 def begin_html_capture(self,*a):return Capture()
 async def capture_html(self,*a):pass
 async def screenshot(self,*a):pass

class Browser(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.pw=await async_playwright().start();self.browser=await self.pw.chromium.launch(channel='chromium',headless=True)
  self.ctx=await self.browser.new_context();await self.ctx.route('**/*',lambda r:r.fulfill(content_type='text/html',body=PAGE))
  self.page=await self.ctx.new_page();await self.page.goto(URL)
 async def asyncTearDown(self):
  await self.ctx.close();await self.browser.close();await self.pw.stop()
 async def dom(self,answer=ANSWER,review=REVIEW,extra=''):
  await self.page.set_content('<main><div role="log">'+USER+answer+'</div>'+review+extra+'</main>')
 async def test_current_review_without_composer_and_timestamp_stability(self):
  await self.dom();s=await self.page.evaluate(READ_REPLY)
  self.assertEqual(s['count'],1);self.assertEqual(s['text'],'OK');self.assertEqual(s['key'],'a1')
  self.assertTrue(s['explicitDone']);self.assertTrue(s['reviewReady']);self.assertFalse(s['editorReady']);self.assertFalse(s['generating'])
  await self.page.locator('time').evaluate("e=>e.textContent='different timestamp'")
  self.assertEqual((await self.page.evaluate(READ_REPLY))['text'],s['text'])
  output=await self.page.evaluate(READ_OUTPUT);self.assertIn('OK',output['text']);self.assertNotIn('own prompt',output['text'])
 async def test_fail_closed_and_stream_overrides_review(self):
  for answer,review,extra in [('',REVIEW,''),(ANSWER,'','<textarea></textarea>'),(ANSWER,REVIEW,'<button aria-label="Stop generating">Stop</button>'),(ANSWER.replace('<div class="prose">','<div aria-busy="true" class="prose">'),REVIEW,'')]:
   await self.dom(answer,review,extra);s=await self.page.evaluate(READ_REPLY)
   candidate=bool(s['count'] and s['text'] and s['explicitDone'] and not s['generating'])
   self.assertFalse(candidate)
  # Model text/HUD may contain review-looking controls; neither is a site signal.
  await self.dom(ANSWER.replace('</p>','</p>'+REVIEW),'')
  self.assertFalse((await self.page.evaluate(READ_REPLY))['explicitDone'])
  await self.dom(ANSWER,'','<div id="arena-trace-inspector-hud">'+REVIEW+'<textarea></textarea></div>')
  s=await self.page.evaluate(READ_REPLY);self.assertFalse(s['explicitDone']);self.assertFalse(s['editorReady'])
 async def test_legacy_and_tool_only_turn(self):
  await self.dom('<div data-message-role="assistant" data-message-id="old" data-state="completed">Legacy answer</div>','')
  s=await self.page.evaluate(READ_REPLY);self.assertEqual(s['key'],'old');self.assertTrue(s['explicitDone'])
  await self.dom('<div data-agent-transcript-message="true" data-chat-message-id="tool"><button>functions.present_file</button><span>index.html</span></div>')
  s=await self.page.evaluate(READ_REPLY);self.assertTrue(s['explicitDone']);self.assertIn('index.html',s['text'])
 async def test_hud_guard_restores_error_and_late_injection(self):
  hud=self.page.locator('#arena-trace-inspector-hud')
  with self.assertRaisesRegex(RuntimeError,'test'):
   async with send_surface(self.page):
    self.assertEqual(await hud.evaluate('e=>getComputedStyle(e).visibility'),'hidden')
    raise RuntimeError('test')
  self.assertEqual(await hud.evaluate('e=>getComputedStyle(e).visibility'),'visible')
  await hud.evaluate('e=>e.remove()')
  async with send_surface(self.page):
   await self.page.evaluate("()=>{const e=document.createElement('div');e.id='arena-trace-inspector-hud';e.textContent='late';document.body.append(e)}")
   self.assertEqual(await hud.evaluate('e=>getComputedStyle(e).visibility'),'hidden')
  self.assertEqual(await hud.evaluate('e=>getComputedStyle(e).visibility'),'visible')
 async def test_input_ignores_hud_and_unknown_completion_keeps_slot(self):
  handle=await self.page.evaluate_handle(FIND_INPUT)
  self.assertEqual(await handle.evaluate('e=>e.parentElement.tagName'),'FORM');await handle.dispose()
  await self.dom(ANSWER,'','<textarea></textarea>')
  t=PelicanTasks.__new__(PelicanTasks);t.history=History()
  run={'stop':asyncio.Event(),'settings':TaskSettings().model_dump()};job={'url':URL,'current_turn':1,'turns':[{}]}
  task=asyncio.create_task(t.wait_reply(self.page,run,job,{'count':0,'key':'','text':''},False))
  await asyncio.sleep(.2);self.assertFalse(task.done());run['stop'].set()
  with self.assertRaises(asyncio.CancelledError):await task
 async def test_three_serial_submissions_without_retry_or_votes(self):
  pages=[];opened=[]
  self.ctx.on('page',lambda p:(pages.append(p),opened.append(time.monotonic())))
  t=PelicanTasks.__new__(PelicanTasks);t.history=History();t.last_send={};t.interaction=asyncio.Lock()
  t.manager=SimpleNamespace(contexts={'e':self.ctx},log=lambda *a:None)
  settings=TaskSettings(total=3,interval=3,concurrency=1,capture_screenshot=False).model_dump()
  run=dict(id='r',environment_id='e',settings=settings,status='running',stop=asyncio.Event(),context=self.ctx,workers=[],next=0,opening_gate=asyncio.Lock(),last_open=0.,open_not_before=0.,jobs=[dict(number=i+1,record_id=str(i),status='pending',turns=[dict(prompt='own prompt',status='pending')]) for i in range(3)])
  await asyncio.wait_for(t.execute('e',run),40)
  self.assertEqual(run['status'],'completed');self.assertEqual([j['status'] for j in run['jobs']],['success']*3)
  self.assertEqual(len(pages),3);self.assertTrue(all(b-a>=2.99 for a,b in zip(opened,opened[1:])))
  for page in pages:
   self.assertEqual(await page.evaluate('window.sendCount'),1);self.assertEqual(await page.evaluate('window.voteCount'),0)
   self.assertEqual(await page.locator('#arena-trace-inspector-hud').evaluate('e=>getComputedStyle(e).visibility'),'visible')
  self.assertTrue(all(j['turns'][0]['completion_evidence']['source']=='review-panel' for j in run['jobs']))

class Workers(unittest.IsolatedAsyncioTestCase):
 async def test_unexpected_worker_error_stops_waiting_peer(self):
  t=PelicanTasks.__new__(PelicanTasks);t.history=History();t.manager=SimpleNamespace(log=lambda *a:None)
  calls=0
  async def worker(eid,run):
   nonlocal calls
   calls+=1
   if calls==1:
    await asyncio.sleep(.01);raise RuntimeError('unexpected fixture failure')
   await asyncio.Event().wait()
  t.worker=worker
  r={'environment_id':'e','stop':asyncio.Event(),'settings':{'concurrency':2},'jobs':[{'status':'generating','record_id':'1','submitted':True},{'status':'pending','record_id':'2'}]}
  await asyncio.wait_for(t.execute('e',r),1)
  self.assertEqual(r['status'],'stopped');self.assertIn('unexpected',r['worker_error']);self.assertEqual(r['jobs'][0]['status'],'untracked');self.assertEqual(r['jobs'][1]['status'],'cancelled')

if __name__=='__main__':unittest.main(verbosity=2)

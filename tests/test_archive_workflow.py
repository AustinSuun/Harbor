import asyncio,json,os,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
bundled_test_browser=ROOT/'release/Harbor-Windows-x64-20260912-105108/Harbor/_internal/bundled-browsers'
if bundled_test_browser.is_dir() and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):
    os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundled_test_browser)
from archive_actions import archive_reason,archive_conversation
from test_tab_close_scheduler import simulate,Tasks
URL='https://arena.ai/agent/12345678-1234-1234-1234-123456789abc'
HTML='''<main><header><button aria-label="Conversation options" aria-controls="menu" onclick="document.querySelector('#menu').hidden=false">Options</button></header><div role="menu" id="menu" hidden><button role="menuitem" onclick="window.archived++;history.pushState({},'', '/agent');document.querySelector('#notice').textContent='Conversation archived'">Archive conversation</button></div><form><textarea></textarea></form><div role="status" id="notice"></div></main><script>window.archived=0</script>'''
class Navigation(unittest.IsolatedAsyncioTestCase):
 async def test_navigation_does_not_stop_parallel_run(self):
  t,r,c=await simulate('reply','navigate',concurrency=2,total=6)
  self.assertEqual(r['status'],'completed');self.assertEqual(len(c.opened),6)
  self.assertEqual(r['jobs'][0]['status'],'untracked');self.assertTrue(r['jobs'][0]['page_departed'])
  self.assertEqual(sum(j['status']=='success' for j in r['jobs']),5)
 async def test_navigation_during_confirmation_is_local(self):
  t,r,c=await simulate('confirming','navigate',total=3)
  self.assertFalse(r['stop'].is_set());self.assertEqual(r['jobs'][0]['status'],'unknown')
  self.assertEqual(len(c.opened),3)
 async def test_archive_navigation_detected(self):
  from types import SimpleNamespace
  t=Tasks.__new__(Tasks);p=SimpleNamespace(url=URL);run={'stop':asyncio.Event()};job={'url':URL}
  await t.check_conversation(p,run,job);p.url='https://arena.ai/agent'
  with self.assertRaisesRegex(RuntimeError,'HARBOR_TASK_PAGE_LEFT'):await t.check_conversation(p,run,job)
 def test_rule_boundaries(self):
  for lines in (149,150,151):
   j={'status':'success','html_capture':'saved','html_candidate':{'raw_lines':lines}}
   self.assertEqual(archive_reason(j,'pelican'), 'html_over_150' if lines>150 else None)
  self.assertIsNone(archive_reason({'thinking_observed':True},'pelican'))
  self.assertEqual(archive_reason({'thinking_stopped':True},'pelican'),'thinking_stopped')
  self.assertIsNone(archive_reason({'status':'failed','html_candidate':{'raw_lines':200}},'pelican'))

class Browser(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  from playwright.async_api import async_playwright
  self.pw=await async_playwright().start();self.browser=await self.pw.chromium.launch(channel='chromium',headless=True)
  self.ctx=await self.browser.new_context();await self.ctx.route('**/*',lambda r:r.fulfill(content_type='text/html',body=HTML))
  self.page=await self.ctx.new_page();await self.page.goto(URL)
 async def asyncTearDown(self):await self.ctx.close();await self.browser.close();await self.pw.stop()
 async def test_integrated_thinking_then_archive(self):
  from types import SimpleNamespace
  from pelican_tasks import PelicanTasks
  await self.page.evaluate("() => {const form=document.querySelector('form');const reply=document.createElement('div');reply.setAttribute('data-message-role','assistant');reply.setAttribute('data-message-id','new-turn');reply.setAttribute('data-state','streaming');reply.innerHTML='<div data-part-type=\"reasoning\" data-state=\"streaming\">Thinking</div>';form.before(reply);const stop=document.createElement('button');stop.type='button';stop.setAttribute('aria-label','Stop generating');stop.textContent='Stop';stop.onclick=()=>{reply.setAttribute('data-state','completed');reply.firstElementChild.setAttribute('data-state','completed');stop.remove()};form.append(stop)}")
  t=PelicanTasks.__new__(PelicanTasks);t.history=SimpleNamespace(save_job=lambda *a:None,save_run=lambda *a:None)
  run={'stop':asyncio.Event(),'settings':{'kind':'pelican','experimental_stop_thinking':True,'experimental_auto_archive':True}}
  job={'url':URL,'current_turn':1,'turns':[{}]}
  await asyncio.wait_for(t.wait_reply(self.page,run,job,{'count':0,'key':'','text':''},True),5)
  self.assertTrue(job['thinking_stopped'])
  # Stale child streaming must not be mistaken for idle by the archive adapter.
  await self.page.locator('[data-part-type=reasoning]').evaluate("e=>e.removeAttribute('data-state')")
  job['status']='interrupted';await t.maybe_archive(self.page,run,job)
  self.assertEqual(job['archive_result']['status'],'archive_ui_confirmed')
 async def test_dry_run_does_not_click(self):
  r=await archive_conversation(self.page,URL,reason='html_over_150')
  self.assertEqual(r['status'],'would_open_menu');self.assertEqual(await self.page.evaluate('window.archived'),0)
 async def test_archive_requires_toast_and_navigation(self):
  r=await archive_conversation(self.page,URL,reason='html_over_150',dry_run=False)
  self.assertEqual(r['status'],'archive_ui_confirmed');self.assertFalse(r['local_results_deleted'])
  self.assertEqual(await self.page.evaluate('window.archived'),1)
 async def test_ineffective_archive_not_retried(self):
  await self.page.locator('[role=menuitem]').evaluate("e=>e.onclick=()=>{window.archived++}")
  r=await archive_conversation(self.page,URL,reason='html_over_150',dry_run=False,timeout=.3)
  self.assertEqual(r['status'],'archive_not_verified');self.assertEqual(await self.page.evaluate('window.archived'),1)
 async def test_generating_refuses_archive(self):
  await self.page.locator('main').evaluate("e=>e.setAttribute('data-state','streaming')")
  r=await archive_conversation(self.page,URL,reason='thinking_stopped',dry_run=False)
  self.assertEqual(r['status'],'unsafe_or_generating');self.assertEqual(await self.page.evaluate('window.archived'),0)
 async def test_wrong_conversation_refuses(self):
  r=await archive_conversation(self.page,URL.replace('12345678','87654321'),reason='html_over_150',dry_run=False)
  self.assertFalse(r['archive_click_attempted'])
 async def test_ambiguous_menu_item_refuses(self):
  await self.page.locator('#menu').evaluate('e=>e.append(e.firstElementChild.cloneNode(true))')
  r=await archive_conversation(self.page,URL,reason='html_over_150',dry_run=False)
  self.assertEqual(r['status'],'ambiguous_archive');self.assertFalse(r['archive_click_attempted'])
if __name__=='__main__':unittest.main(verbosity=2)

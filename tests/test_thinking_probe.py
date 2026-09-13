"""Synthetic diagnostics only; no live Arena or account database."""
import asyncio,json,os,sys,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
bundle=ROOT/'release/Harbor-Windows-x64-20260912-225940/Harbor/_internal/bundled-browsers'
if bundle.is_dir() and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundle)
from thinking_probe import ThinkingProbe,PROBE_UI
from fastapi import HTTPException
URL='https://arena.ai/agent/12345678-1234-1234-1234-123456789abc?token=PRIVATE_URL_TOKEN'
HTML='''<style>textarea{width:200px;height:50px}.animate-pulse{animation:pulse 2s infinite}@keyframes pulse{to{opacity:.8}}</style><main><div data-message-role="assistant" data-message-id="PRIVATE_TURN_ID" id="answer"><div role="status" class="animate-pulse" id="thinking"><span>Thinking...</span></div><p>PRIVATE_REASONING_BODY</p><pre><span>Thinking</span></pre></div><form><textarea>PRIVATE_PROMPT</textarea><input type="password" value="PRIVATE_PASSWORD"><button type="button" aria-label="Stop generating">Stop</button></form></main>'''

class Browser(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  from playwright.async_api import async_playwright
  self.pw=await async_playwright().start();self.browser=await self.pw.chromium.launch(channel='chromium',headless=True)
  self.context=await self.browser.new_context();await self.context.route('**/*',lambda r:r.fulfill(content_type='text/html',body=HTML))
  self.page=await self.context.new_page();await self.page.goto(URL)
  self.manager=SimpleNamespace(contexts={'fixture-environment':self.context})
  self.probe=ThinkingProbe(self.manager);self.key=self.probe.list_pages()[0]['key']
 async def asyncTearDown(self):await self.context.close();await self.browser.close();await self.pw.stop()
 async def test_discovers_label_missed_by_old_rule(self):
  r=(await self.probe.sample(self.key,'visible-thinking'))['sample']
  self.assertFalse(r['existing']['thinking'])
  self.assertEqual([l['kind'] for l in r['discovered_labels']],['thinking'])
  self.assertEqual(len(r['discovered_stop_controls']),1)
  self.assertTrue(r['discovered_labels'][0]['in_last_assistant'])
  self.assertTrue(any('animate-pulse' in a['signal_classes'] for a in r['discovered_labels'][0]['ancestors']))
 async def test_existing_rule_and_human_transition(self):
  await self.probe.sample(self.key,'visible-thinking')
  await self.page.locator('#thinking').evaluate("e=>{e.setAttribute('data-part-type','reasoning');e.setAttribute('data-state','streaming')}")
  self.assertTrue((await self.probe.sample(self.key,'visible-thinking'))['sample']['existing']['thinking'])
  await self.page.locator('#thinking').evaluate("e=>{e.setAttribute('data-state','completed');e.firstElementChild.textContent='Thought for 12 seconds'}")
  await self.page.locator('button').evaluate('e=>e.remove()')
  r=(await self.probe.sample(self.key,'thinking-ended'))['sample']
  self.assertFalse(r['existing']['thinking']);self.assertEqual(r['discovered_labels'][0]['kind'],'thought-duration')
  report=self.probe.report(self.key);self.assertEqual(report['comparison']['existing_rule_missed_human_thinking'],1)
  self.assertEqual(report['comparison']['existing_rule_positive_after_human_end'],0)
 async def test_report_contains_no_private_payload(self):
  await self.probe.sample(self.key);text=json.dumps(self.probe.report(self.key))
  for secret in ('PRIVATE_URL_TOKEN','PRIVATE_TURN_ID','PRIVATE_REASONING_BODY','PRIVATE_PROMPT','PRIVATE_PASSWORD','https://arena.ai'):
   self.assertNotIn(secret,text)
 async def test_no_site_click_or_storage_change(self):
  await self.page.evaluate("() => {window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;localStorage.setItem('unchanged','yes')}")
  await self.probe.sample(self.key)
  self.assertEqual(await self.page.evaluate('window.clicks'),0)
  self.assertEqual(await self.page.locator('textarea').input_value(),'PRIVATE_PROMPT')
  self.assertEqual(await self.page.evaluate("localStorage.getItem('unchanged')"),'yes')
 async def test_navigation_epoch_without_urls(self):
  await self.probe.sample(self.key)
  await self.page.evaluate("history.pushState({},'', '/agent')")
  r=(await self.probe.sample(self.key))['sample'];self.assertEqual(r['page_epoch'],2)
 async def test_closed_or_changed_context_refused(self):
  self.manager.contexts['fixture-environment']=object()
  with self.assertRaises(HTTPException):await self.probe.sample(self.key)
 async def test_api_csrf_validation_and_export(self):
  import httpx,browser_manager as bm
  from unittest.mock import patch
  with patch.object(bm,'thinking_probe',self.probe):
   async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bm.app),base_url='http://127.0.0.1:8766') as client:
    path='/api/thinking-probe/'+self.key
    self.assertEqual((await client.post(path+'/sample',json={'mark':'visible-thinking'})).status_code,403)
    r=await client.post(path+'/sample',headers={'X-Manager-Request':'1'},json={'mark':'visible-thinking'});self.assertEqual(r.status_code,200)
    r=await client.get(path+'/report');self.assertEqual(r.status_code,200);self.assertIn('attachment',r.headers['content-disposition'])
    r=await client.post(path+'/sample',headers={'X-Manager-Request':'1'},json={'mark':'PRIVATE_BAD_INPUT'});self.assertEqual(r.status_code,422);self.assertNotIn('PRIVATE_BAD_INPUT',r.text)
 async def test_diagnostic_ui(self):
  ui=await self.browser.new_context();errors=[]
  async def route(r):
   if '/api/thinking-probe/pages' in r.request.url:data={'pages':self.probe.list_pages()}
   elif r.request.url.endswith('/sample'):
    self.assertEqual(r.request.headers.get('x-manager-request'),'1')
    data=await self.probe.sample(self.key,json.loads(r.request.post_data)['mark'])
   else:await r.fulfill(content_type='text/html',body=PROBE_UI);return
   await r.fulfill(content_type='application/json',body=json.dumps(data))
  await ui.route('**/*',route)
  try:
   page=await ui.new_page();page.on('pageerror',lambda e:errors.append(str(e)));await page.goto('http://127.0.0.1:8766/thinking-probe')
   await page.locator('#pages option').wait_for(state='attached')
   await page.locator('[data-mark="visible-thinking"]').click()
   await page.wait_for_function("document.querySelector('#result').textContent.includes('visible-thinking')")
   self.assertIn('未命中',await page.locator('#verdict').text_content())
   self.assertFalse(await page.locator('#export').is_hidden());self.assertFalse(errors)
  finally:await ui.close()

class Memory(unittest.IsolatedAsyncioTestCase):
 async def test_sample_and_session_bounds(self):
  class Page:
   url='https://arena.ai/agent'
   def is_closed(self):return False
   async def evaluate(self,script):return {'existing':{'thinking':False},'discovered_labels':[],'discovered_stop_controls':[]}
  pages=[Page() for _ in range(4)];context=SimpleNamespace(pages=pages);probe=ThinkingProbe(SimpleNamespace(contexts={'e':context}))
  keys=[p['key'] for p in probe.list_pages()]
  for _ in range(125):await probe.sample(keys[0])
  self.assertEqual(len(probe.report(keys[0])['samples']),120);self.assertEqual(probe.report(keys[0])['dropped_samples'],5)
  for key in keys[1:]:await probe.sample(key)
  self.assertEqual(len(probe.sessions),3);self.assertNotIn(keys[0],probe.sessions)

if __name__=='__main__':unittest.main(verbosity=2)

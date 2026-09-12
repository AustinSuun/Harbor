import asyncio,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import html_results as module
from html_results import TaskHtmlCapture,workspace_html_url,read_workspace_file
import test_html_gallery as base
HTML=base.HTML
URL='https://ws-12345678-1234-1234-1234-123456789abc.arena.site/PRIVATE_CAPABILITY/index.html'
class Page:
 def __init__(self):self.listeners={};self.frames=[];self.main_frame=None;self.links=[]
 def on(self,event,fn):self.listeners[event]=fn
 def remove_listener(self,event,fn):self.listeners.pop(event,None)
 async def evaluate(self,code):return self.links
 def emit(self,event,arg):self.listeners[event](arg)
class Response:
 def __init__(self,url=URL,text=HTML,delay=0):self.url=url;self.status=200;self.headers={};self.text=text;self.delay=delay
 async def body(self):await asyncio.sleep(self.delay);return self.text.encode()
class AutoTests(unittest.IsolatedAsyncioTestCase):
 setUp=base.Tests.setUp
 tearDown=base.Tests.tearDown
 new=base.Tests.new
 def test_host_and_credentials_boundaries(self):
  self.assertTrue(workspace_html_url(URL))
  for bad in ['http:'+URL[6:],URL.replace('.arena.site','.arena.site.evil.invalid'),URL.replace('/index.html','/'),URL.replace('https://','https://user:pass@'),URL.replace('.arena.site/','.arena.site:8766/')]:self.assertFalse(workspace_html_url(bad),bad)
 async def test_unarmed_then_auto_capture_and_gallery(self):
  p=Page();o=TaskHtmlCapture(p)
  p.emit('response',Response());await asyncio.sleep(0);self.assertFalse(o.pending);self.assertIsNone(o.latest)
  o.arm();p.emit('response',Response());r,j=self.new();j['_html_capture']=o
  await self.h.capture_html(r,j,p)
  self.assertEqual(self.h.html.list()['total'],1);self.assertEqual(j['html_capture'],'saved')
  self.assertEqual(self.h.html.metadata(j['record_id'])['source'],'workspace-html-response')
  metrics=self.h.html.list()['results'][0]['html_candidate']
  self.assertTrue(metrics['candidate']);self.assertEqual(metrics['line_limit'],150)
  payload=self.h.get(j['record_id'])['payload'];self.assertNotIn('_html_capture',payload);self.assertNotIn('PRIVATE_CAPABILITY',json.dumps(payload))
  o.close();self.assertFalse(p.listeners);self.assertFalse(o.urls)
 async def test_latest_response_wins(self):
  p=Page();o=TaskHtmlCapture(p);o.arm()
  p.emit('response',Response(text=HTML.replace('Test','older'),delay=.03));p.emit('response',Response(text=HTML.replace('Test','newer')))
  content,_=await o.result();self.assertIn('newer',content);o.close()
 async def test_application_html_ignored(self):
  p=Page();o=TaskHtmlCapture(p);o.arm();p.emit('response',Response(url='https://arena.ai/agent/test'))
  self.assertIsNone(await o.result());o.close()
 async def test_visible_file_fallback_no_guessing(self):
  p=Page();p.links=[URL,'https://evil.invalid/index.html'];o=TaskHtmlCapture(p);o.arm()
  with patch.object(module,'read_workspace_file',return_value=HTML) as fetch:
   found=await o.result();self.assertEqual(found[1],'workspace-visible-file');fetch.assert_called_once_with(URL)
  o.close()
 async def test_failed_file_keeps_record_no_gallery(self):
  p=Page();p.links=[URL];o=TaskHtmlCapture(p);o.arm()
  with patch.object(module,'read_workspace_file',return_value=None):self.assertIsNone(await o.result())
  o.close();self.assertFalse(p.listeners)
 async def test_browser_download(self):
  p=Page();o=TaskHtmlCapture(p);o.arm()
  with tempfile.TemporaryDirectory() as d:
   target=Path(d)/'test.html';target.write_text(HTML,encoding='utf-8')
   class Download:
    suggested_filename='index.html'
    async def path(self):return str(target)
   p.emit('download',Download());self.assertEqual((await o.result())[1],'browser-html-download')
  o.close()
 async def test_close_cancels_pending(self):
  p=Page();o=TaskHtmlCapture(p);o.arm();p.emit('response',Response(delay=1));tasks=list(o.pending);o.close();await asyncio.gather(*tasks,return_exceptions=True)
  self.assertFalse(o.latest);self.assertFalse(o.pending);self.assertFalse(p.listeners)
if __name__=='__main__':unittest.main(verbosity=2)

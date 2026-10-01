"""Windowless startup and idle-only web exit; isolated data, no real manager."""
import asyncio,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
DATA=tempfile.TemporaryDirectory(prefix='harbor-windowless-tests-')
os.environ['HARBOR_DATA_DIR']=DATA.name
import desktop_runtime as desktop
import harbor_launcher as launcher
import browser_manager as backend

class Streams(unittest.TestCase):
 def test_missing_streams_accept_print_traceback_and_formatter(self):
  from uvicorn.logging import DefaultFormatter
  with tempfile.TemporaryDirectory() as folder:
   stream=None
   try:
    with patch.object(sys,'stdout',None),patch.object(sys,'stderr',None):
     path=desktop.prepare_output(folder,'server');stream=sys.stdout
     self.assertIsNotNone(sys.stderr);self.assertFalse(sys.stderr.isatty())
     print('windowless print');sys.stderr.write('windowless error\n');sys.stderr.flush()
     formatter=DefaultFormatter();self.assertFalse(formatter.use_colors)
    text=path.read_text(encoding='utf-8');self.assertIn('windowless print',text);self.assertIn('windowless error',text)
   finally:
    if stream:stream.handler.close()
 def test_frozen_logs_even_when_parent_redirects_standard_streams(self):
  import io
  with tempfile.TemporaryDirectory() as folder:
   with patch.object(sys,'stdout',io.StringIO()),patch.object(sys,'stderr',io.StringIO()):
    path=desktop.prepare_output(folder,force=True);stream=sys.stdout
    print('redirected-parent');stream.flush()
   self.assertIn('redirected-parent',path.read_text(encoding='utf-8'));stream.handler.close()
 def test_normal_streams_unchanged(self):
  original=sys.stdout;self.assertIsNone(desktop.prepare_output(DATA.name));self.assertIs(sys.stdout,original)
 def test_hidden_child_flags(self):
  if sys.platform!='win32':self.skipTest('Windows flags')
  options=desktop.hidden_process_options();self.assertEqual(options['creationflags'],__import__('subprocess').CREATE_NO_WINDOW)
  self.assertTrue(options['startupinfo'].dwFlags & __import__('subprocess').STARTF_USESHOWWINDOW)
  self.assertEqual(options['startupinfo'].wShowWindow,0)
 def test_build_is_windowed(self):
  s=(ROOT/'build_windows.py').read_text(encoding='utf-8-sig');self.assertIn("'--windowed'",s);self.assertNotIn("'--console'",s)
  self.assertNotIn("input(", (ROOT/'harbor_launcher.py').read_text(encoding='utf-8-sig'))
 def test_existing_manager_only_opens_web(self):
  with patch.object(launcher,'FROZEN',True),patch('update_service.installed_update',return_value=None),patch.object(launcher,'is_harbor_running',return_value=True),patch.object(launcher,'open_manager') as opened,patch.object(launcher.subprocess,'Popen') as spawn:
   self.assertEqual(launcher.launch(),0);opened.assert_called_once();spawn.assert_not_called()
 def test_server_child_hidden_and_web_opens_after_ready(self):
  child=Mock();child.wait.return_value=0
  with patch.object(launcher,'FROZEN',True),patch('update_service.installed_update',return_value=None),patch.object(launcher,'is_harbor_running',side_effect=[False,True]),patch.object(launcher.socket,'create_connection',side_effect=OSError),patch.object(launcher,'ensure_browser_resources'),patch.object(launcher,'open_manager') as opened,patch.object(launcher.subprocess,'Popen',return_value=child) as spawn:
   self.assertEqual(launcher.launch(),0);opened.assert_called_once();self.assertIn('--serve',spawn.call_args.args[0])
   if sys.platform=='win32':self.assertTrue(spawn.call_args.kwargs['creationflags'])
   child.terminate.assert_not_called();child.kill.assert_not_called()
 def test_error_page_escapes_and_does_not_prompt(self):
  with tempfile.TemporaryDirectory() as folder,patch.object(launcher,'DATA_DIR',Path(folder)),patch.object(launcher,'FROZEN',True),patch.object(launcher.webbrowser,'open') as opened:
   launcher.show_startup_error('<script>bad()</script>')
   page=next((Path(folder)/'logs').glob('startup-error-*.html')).read_text(encoding='utf-8')
   self.assertNotIn('<script>',page);self.assertIn('&lt;script&gt;',page);opened.assert_called_once()

class ExitAPI(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  import httpx
  self.old_manager=backend.manager;self.old_runs=backend.pelican.runs
  backend.manager=backend.Manager();backend.pelican.runs={};self.calls=[]
  backend.app.state.request_exit=lambda:self.calls.append('exit')
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=backend.app),base_url='http://127.0.0.1:8766')
 async def asyncTearDown(self):
  await self.client.aclose();backend.manager=self.old_manager;backend.pelican.runs=self.old_runs
  del backend.app.state.request_exit
 async def post(self,headers=None):return await self.client.post('/api/shutdown',headers=headers or {'X-Manager-Request':'1'})
 async def test_csrf_and_foreign_origin_refused(self):
  self.assertEqual((await self.client.post('/api/shutdown')).status_code,403)
  self.assertEqual((await self.post({'X-Manager-Request':'1','Origin':'https://evil.invalid'})).status_code,403);self.assertFalse(self.calls)
 async def test_busy_environment_task_cleanup_and_update_refused(self):
  for field,value in [('contexts',{'e':object()}),('login_jobs',{'e':object()}),('cleanup_tasks',{'e':object()}),('updating',True)]:
   old=getattr(backend.manager,field);setattr(backend.manager,field,value)
   self.assertEqual((await self.post()).status_code,409);self.assertFalse(backend.manager.shutting_down);setattr(backend.manager,field,old)
  backend.pelican.runs={'r':{'status':'running'}};self.assertEqual((await self.post()).status_code,409);self.assertFalse(self.calls)
 async def test_idle_exit_is_graceful_and_repeat_safe(self):
  self.assertEqual((await self.post()).status_code,202);self.assertTrue(backend.manager.shutting_down)
  self.assertEqual((await self.post()).status_code,202)
  await asyncio.sleep(.35);self.assertEqual(self.calls,['exit'])
  with patch.object(backend.manager,'get',return_value={}):
   with self.assertRaises(backend.HTTPException) as e:await backend.manager.launch('fixture')
   self.assertEqual(e.exception.status_code,409)
 async def test_missing_launcher_refuses(self):
  backend.app.state.request_exit=None;self.assertEqual((await self.post()).status_code,409)

class ExitBrowser(unittest.IsolatedAsyncioTestCase):
 async def test_exit_control_reports_busy_then_stopping_without_dialog(self):
  from playwright.async_api import async_playwright
  state={'busy':True,'calls':0};errors=[]
  async with async_playwright() as pw:
   browser=await pw.chromium.launch(channel='chromium',headless=True)
   try:
    context=await browser.new_context();await context.add_init_script("localStorage.setItem('harbor-update-reminders','off')")
    async def route(r):
     path=__import__('urllib.parse',fromlist=['urlparse']).urlparse(r.request.url).path
     if path=='/':return await r.fulfill(content_type='text/html',body=(ROOT/'browser_manager.html').read_text(encoding='utf-8-sig'))
     if path=='/api/shutdown':
      state['calls']+=1
      return await r.fulfill(status=409 if state['busy'] else 202,content_type='application/json',body=json.dumps({'detail':'请先关闭运行环境'} if state['busy'] else {'stopping':True}))
     data={'environments':[],'accounts':[],'logs':[],'max_running':5,'browser_mode':'fixture','current_version':'0.3.14','status':{}}
     await r.fulfill(content_type='application/json',body=json.dumps(data))
    await context.route('**/*',route);page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto('http://127.0.0.1:8766');button=page.get_by_role('button',name='退出管理器',exact=True)
    await button.click();await page.wait_for_function("document.getElementById('notice').textContent.includes('运行环境')")
    self.assertTrue(await button.is_enabled());state['busy']=False;await button.click()
    await page.wait_for_function("document.getElementById('connection').textContent.includes('退出请求')")
    self.assertTrue(await button.is_disabled());self.assertEqual(state['calls'],2);self.assertFalse(errors)
   finally:await browser.close()

if __name__=='__main__':
 try:unittest.main(verbosity=2)
 finally:DATA.cleanup()

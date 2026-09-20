"""Mocked manager launch/close lifecycle, disposable state only."""
import asyncio,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import browser_manager as bm

class Page:
    def on(self,*args):pass
    def is_closed(self):return False
class Context:
    def __init__(self):self.pages=[Page()];self.handlers={};self.close=AsyncMock();self.set_offline=AsyncMock()
    def on(self,event,callback):self.handlers[event]=callback

class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.m=bm.Manager()
        self.patches=[patch.object(bm,'DATA',self.root),patch.object(bm,'manager',self.m),patch.object(bm,'decrypt_password',return_value='fake-password')]
        for p in self.patches:p.start()
        self.m.acquire()
        self.m.db.execute('CREATE TABLE IF NOT EXISTS pelican_settings (environment_id TEXT PRIMARY KEY)')
        with self.m.db:self.m.db.execute("INSERT INTO accounts VALUES ('a','fixture','','fixture@example.invalid','fake-cipher','2026-09-19')")
        self.context=Context();self.launch=AsyncMock(return_value=self.context)
        self.m.pw=type('PW',(),{'chromium':type('Chromium',(),{'launch_persistent_context':self.launch})()})()
        self.m.auto_login=AsyncMock()
    async def asyncTearDown(self):
        for task in self.m.login_jobs.values():task.cancel()
        if self.m.login_jobs:await asyncio.gather(*self.m.login_jobs.values(),return_exceptions=True)
        if self.m.cleanup_tasks:await asyncio.gather(*self.m.cleanup_tasks.values(),return_exceptions=True)
        self.m.db.close();self.m.guard.close()
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    async def test_both_modes_load_then_configure_before_navigation(self):
        for mode in ['persistent','incognito']:
            eid=self.m.create_environment(bm.EnvironmentInput(name=mode,account_id='a',mode=mode))
            async def configure(context,key):
                self.assertNotIn(eid,self.m.login_jobs)
                self.assertEqual(key,'')
            with patch.object(bm.default_plugins,'launch_resources',AsyncMock(return_value=['--load-extension=fixture'])),patch.object(bm.default_plugins,'configure_context',side_effect=configure):
                await self.m.launch(eid)
            self.assertTrue(self.launch.call_args.kwargs['offline'])
            self.assertEqual(self.launch.call_args.kwargs['args'],['--load-extension=fixture'])
            self.assertTrue(self.m.yescaptcha_started[eid]);self.assertTrue(self.m.trace_inspector_started[eid])
            self.context.set_offline.assert_awaited_with(False)
            profile=Path(self.launch.call_args.kwargs['user_data_dir']);self.assertTrue(profile.is_dir())
            self.m.closed(eid,self.context)
            if mode=='incognito':
                await self.m.cleanup_tasks[eid]
                self.assertFalse(profile.exists())
                self.assertIsNone(self.m.db.execute('SELECT id FROM environments WHERE id=?',(eid,)).fetchone())
            else:self.assertTrue(profile.exists())
    async def test_configuration_failure_never_logs_in_and_removes_temp(self):
        eid=self.m.create_environment(bm.EnvironmentInput(name='failure',account_id='a',mode='incognito'))
        with patch.object(bm.default_plugins,'launch_resources',AsyncMock(return_value=[])),patch.object(bm.default_plugins,'configure_context',AsyncMock(side_effect=ValueError('safe configuration failure'))):
            with self.assertRaises(bm.HTTPException):await self.m.launch(eid)
        self.m.auto_login.assert_not_called();self.context.close.assert_awaited()
        self.assertNotIn(eid,self.m.temporary_profiles);self.assertNotIn(eid,self.m.contexts)
        self.assertEqual(list((self.root/'temporary-plugin-profiles').iterdir()),[])

if __name__=='__main__':unittest.main(verbosity=2)

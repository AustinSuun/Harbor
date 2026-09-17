from contextlib import closing
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import trace_inspector_support as ext
import browser_manager as bm
import httpx

class Support(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.folder=self.root/'plugin';self.folder.mkdir()
        self.manifest={'name':'Arena Trace Inspector','manifest_version':3,'background':{'service_worker':'worker.js'}}
        self.write();(self.folder/'worker.js').write_text('// fixture, no API',encoding='utf-8')
        self.db=sqlite3.connect(self.root/'fixture.sqlite3')
        self.db.execute('CREATE TABLE accounts(id TEXT, note TEXT)');self.db.execute("INSERT INTO accounts VALUES ('a','keep')");self.db.commit()
        ext.initialize(self.db,self.root/'backups')
    def write(self):
        (self.folder/'manifest.json').write_text(json.dumps(self.manifest),encoding='utf-8')
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def test_default_off_and_legacy_unrelated(self):
        self.assertEqual(ext.read_settings(self.db,'new'),dict(enabled=False,folder=''))
        self.assertEqual(ext.launch_args('persistent',{'enabled':False,'folder':''},['--disable-extensions']),['--disable-extensions'])
        self.assertEqual(ext.launch_args('incognito',{'enabled':False,'folder':''},['--disable-extensions']),['--disable-extensions'])
    def test_enabled_args_and_persistence(self):
        with self.db:ext.write_settings(self.db,'a','persistent',True,str(self.folder))
        self.assertTrue(ext.read_settings(self.db,'a')['enabled'])
        self.assertEqual(len(ext.launch_args('persistent',{'enabled':True,'folder':str(self.folder)},['--disable-extensions'])),2)
        self.assertFalse(ext.read_settings(self.db,'b')['enabled'])
    def test_disable_with_missing_directory(self):
        with self.db:ext.write_settings(self.db,'a','persistent',False,str(self.root/'absent'))
        self.assertFalse(ext.read_settings(self.db,'a')['enabled'])
    def test_incognito_rejected(self):
        with self.assertRaises(ValueError):ext.launch_args('incognito',{'enabled':True,'folder':str(self.folder)},['--disable-extensions'])
        with self.assertRaises(ValueError):ext.write_settings(self.db,'a','incognito',True,str(self.folder))
    def test_bad_paths(self):
        for value in ('','relative','\\\\server\\share','//server/share',str(self.folder)+',other',str(self.folder)+'\nother'):
            with self.assertRaises(ValueError):ext.validate_folder(value)
    def test_missing_wrong_manifest(self):
        for manifest in ({'name':'Other','manifest_version':3},{'name':'YesCaptcha','manifest_version':2},[],None):
            self.manifest=manifest;self.write()
            with self.assertRaises(ValueError):ext.validate_folder(str(self.folder))
    def test_missing_worker_and_escape(self):
        for worker in ('missing.js','../outside.js'):
            (self.root/'outside.js').write_text('fixture')
            self.manifest['background']['service_worker']=worker;self.write()
            with self.assertRaises(ValueError):ext.validate_folder(str(self.folder))
    def test_reject_expanded_permissions(self):
        self.manifest['permissions']=['debugger','cookies'];self.write()
        with self.assertRaises(ValueError):ext.validate_folder(str(self.folder))
    def test_reject_expanded_hosts(self):
        self.manifest['host_permissions']=['<all_urls>'];self.write()
        with self.assertRaises(ValueError):ext.validate_folder(str(self.folder))
    def test_missing_content_script(self):
        self.manifest['content_scripts']=[{'matches':['https://arena.ai/*'],'js':['absent.js']}];self.write()
        with self.assertRaises(ValueError):ext.validate_folder(str(self.folder))
    def test_merge_preserves_yescaptcha(self):
        args=ext.launch_args('persistent',{'enabled':True,'folder':str(self.folder)},['--disable-extensions-except=C:/fixture/yescaptcha','--load-extension=C:/fixture/yescaptcha'])
        self.assertEqual(len(args),2)
        self.assertIn('C:/fixture/yescaptcha,',args[1]);self.assertIn(str(self.folder.resolve()),args[1])
        self.assertNotIn('--disable-extensions',args)
    def test_backup_and_idempotence(self):
        files=list((self.root/'backups').glob('*.sqlite3'));self.assertEqual(len(files),1)
        with closing(sqlite3.connect(files[0])) as old:
            self.assertEqual(old.execute('SELECT note FROM accounts').fetchone()[0],'keep')
            self.assertIsNone(old.execute("SELECT name FROM sqlite_master WHERE name='trace_inspector_settings'").fetchone())
        ext.initialize(self.db,self.root/'backups');self.assertEqual(len(list((self.root/'backups').glob('*.sqlite3'))),1)
    def test_transaction_rollback(self):
        try:
            with self.db:
                ext.write_settings(self.db,'a','persistent',True,str(self.folder))
                raise RuntimeError()
        except RuntimeError:pass
        self.assertFalse(ext.read_settings(self.db,'a')['enabled'])

class API(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.m=bm.Manager();self.patches=[patch.object(bm,'DATA',self.root),patch.object(bm,'manager',self.m)]
        for p in self.patches:p.start()
        self.m.acquire()
        with self.m.db:
            self.m.db.execute("INSERT INTO accounts VALUES ('a','fixture','','fixture@example.invalid','unused','2026-09-12')")
        self.eid=self.m.create_environment(bm.EnvironmentInput(name='fixture',account_id='a'))
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=bm.app),base_url='http://127.0.0.1:8766')
    async def asyncTearDown(self):
        await self.client.aclose();self.m.db.close();self.m.guard.close()
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    async def test_running_context_not_restarted(self):
        sentinel=object();self.m.contexts[self.eid]=sentinel
        r=await self.client.put(f'/api/environments/{self.eid}/trace-inspector',headers={'X-Manager-Request':'1'},json={'enabled':False,'folder':''})
        self.assertEqual(r.status_code,200);self.assertTrue(r.json()['running_unchanged'])
        self.assertIs(self.m.contexts[self.eid],sentinel)
    async def test_csrf_and_unknown_environment(self):
        r=await self.client.put(f'/api/environments/{self.eid}/trace-inspector',json={'enabled':False})
        self.assertEqual(r.status_code,403)
        r=await self.client.put('/api/environments/unknown/trace-inspector',headers={'X-Manager-Request':'1'},json={'enabled':False})
        self.assertEqual(r.status_code,404)
    async def test_invalid_folder_rollback(self):
        r=await self.client.put(f'/api/environments/{self.eid}/trace-inspector',headers={'X-Manager-Request':'1'},json={'enabled':True,'folder':'missing'})
        self.assertEqual(r.status_code,422);self.assertFalse(ext.read_settings(self.m.db,self.eid)['enabled'])
    async def test_api_rejects_incognito(self):
        eid=self.m.create_environment(bm.EnvironmentInput(name='temp',account_id='a',mode='incognito'))
        r=await self.client.put(f'/api/environments/{eid}/trace-inspector',headers={'X-Manager-Request':'1'},json={'enabled':False})
        self.assertEqual(r.status_code,422)

if __name__=='__main__':unittest.main(verbosity=2)

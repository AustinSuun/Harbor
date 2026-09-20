"""Disposable settings, local crypto and profile tests. No paid requests."""
import asyncio,json,sqlite3,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import default_plugins as plugins
import browser_manager as bm
import httpx

class Settings(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.db=sqlite3.connect(':memory:');plugins.initialize(self.db,self.root)
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def test_crypto_roundtrip_and_clear(self):
        key='fixture-not-a-real-service-key'
        plugins.save_key(self.db,key)
        self.assertNotIn(key,self.db.execute('SELECT key_cipher FROM global_plugin_settings').fetchone()[0])
        self.assertEqual(plugins.key_value(self.db),key)
        self.assertNotIn(key,json.dumps(plugins.settings(self.db)))
        plugins.save_key(self.db,None);self.assertEqual(plugins.key_value(self.db),key)
        plugins.save_key(self.db,clear=True);self.assertEqual(plugins.key_value(self.db),'')
    def test_bad_keys_do_not_replace(self):
        for key in ['', 'x'*4097, 'bad key', 'key\nkey']:
            with self.assertRaises(ValueError):plugins.save_key(self.db,key)
        self.assertFalse(plugins.settings(self.db)['configured'])
    def test_backup_idempotent(self):
        plugins.initialize(self.db,self.root)
        self.assertEqual(len(list((self.root/'migration-backups').glob('*.sqlite3'))),1)
    def test_checksum_rejects_untrusted_archive(self):
        with self.assertRaises(ValueError):plugins._runtime_files(b'not-official')
    def test_temporary_unique_and_removed(self):
        one=plugins.make_temporary_profile(self.root);two=plugins.make_temporary_profile(self.root)
        self.assertNotEqual(one,two)
        (one/'fixture.txt').write_text('disposable')
        asyncio.run(plugins.remove_temporary_profile(one));self.assertFalse(one.exists());self.assertTrue(two.exists())

class API(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.m=bm.Manager()
        self.patches=[patch.object(bm,'DATA',Path(self.tmp.name)),patch.object(bm,'manager',self.m)]
        for p in self.patches:p.start()
        self.m.acquire()
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=bm.app),base_url='http://127.0.0.1:8766')
    async def asyncTearDown(self):
        await self.client.aclose();self.m.db.close();self.m.guard.close()
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    async def test_one_key_all_environments_next_start(self):
        marker=object();self.m.contexts['running']=marker
        r=await self.client.put('/api/plugins',headers={'X-Manager-Request':'1'},json={'client_key':'fixture-only-key'})
        self.assertEqual(r.status_code,200,r.text);self.assertTrue(r.json()['running_unchanged'])
        self.assertIs(self.m.contexts['running'],marker)
        r=await self.client.get('/api/plugins');self.assertTrue(r.json()['configured'])
        self.assertNotIn('fixture-only-key',r.text);self.assertEqual(r.json()['apply_on'],'next_launch')
    async def test_csrf_and_invalid_key(self):
        self.assertEqual((await self.client.put('/api/plugins',json={'clear':True})).status_code,403)
        r=await self.client.put('/api/plugins',headers={'X-Manager-Request':'1'},json={'client_key':'bad private key'})
        self.assertEqual(r.status_code,422);self.assertNotIn('bad private key',r.text)
    async def test_configuration_error_redacts_exception(self):
        context=type('Context',(),{'service_workers':[type('Worker',(),{'url':'chrome-extension://fixture/background.js','evaluate':AsyncMock(side_effect=RuntimeError('sensitive fake value'))})()]})()
        with self.assertRaisesRegex(ValueError,'密钥配置失败') as caught:await plugins.configure_context(context,'fixture-key')
        self.assertNotIn('sensitive fake value',str(caught.exception))

if __name__=='__main__':unittest.main(verbosity=2)

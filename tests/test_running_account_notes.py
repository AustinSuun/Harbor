"""Metadata-only edits against disposable SQLite; never use live accounts or browsers."""
import sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import browser_manager as bm
import httpx

class RunningNotes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.m=bm.Manager()
        self.patches=[patch.object(bm,'DATA',Path(self.tmp.name)),patch.object(bm,'manager',self.m)]
        for p in self.patches:p.start()
        self.m.acquire()
        with self.m.db:
            self.m.db.execute("INSERT INTO accounts VALUES ('a','fixture','old','fixture@example.invalid','unchanged-cipher','2026-09-19')")
        self.eid=self.m.create_environment(bm.EnvironmentInput(name='fixture',account_id='a'))
        self.sentinel=object();self.m.contexts[self.eid]=self.sentinel
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=bm.app),base_url='http://127.0.0.1:8766')
        self.body=dict(name='renamed',note='运行中备注\n第二行',login_email='fixture@example.invalid',login_password=None)

    async def asyncTearDown(self):
        await self.client.aclose();self.m.db.close();self.m.guard.close()
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()

    async def save(self,body=None,aid='a',headers=True):
        return await self.client.put('/api/accounts/'+aid,json=body or self.body,headers={'X-Manager-Request':'1'} if headers else {})

    async def test_running_metadata_only_preserves_context_and_cipher(self):
        with patch.object(self.m,'credentials',side_effect=AssertionError('must not touch credentials')):
            r=await self.save()
        self.assertEqual(r.status_code,200,r.text)
        row=self.m.account('a')
        self.assertEqual(row['note'],self.body['note']);self.assertEqual(row['name'],'renamed')
        self.assertEqual(row['password_cipher'],'unchanged-cipher')
        self.assertIs(self.m.contexts[self.eid],self.sentinel)

    async def test_starting_environment_also_allows_notes(self):
        self.m.contexts.clear();self.m.states[self.eid]='starting'
        self.assertEqual((await self.save()).status_code,200)
        self.assertEqual(self.m.states[self.eid],'starting')

    async def test_live_credentials_changes_rejected(self):
        for changes in [dict(login_password='new-secret'),dict(login_email='other@example.invalid'),dict(clear_credentials=True)]:
            r=await self.save(dict(self.body,**changes));self.assertEqual(r.status_code,409,r.text)
            self.assertEqual(self.m.account('a')['note'],'old')
            self.assertEqual(self.m.account('a')['password_cipher'],'unchanged-cipher')

    async def test_note_length_checked(self):
        self.assertEqual((await self.save(dict(self.body,note='x'*501))).status_code,422)
        self.assertEqual(self.m.account('a')['note'],'old')

    async def test_csrf_and_unknown_account(self):
        self.assertEqual((await self.save(headers=False)).status_code,403)
        self.assertEqual((await self.save(aid='missing')).status_code,404)

if __name__=='__main__':unittest.main(verbosity=2)

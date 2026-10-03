"""Disposable API and browser lifecycle tests; no live login or user data."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import browser_manager as bm
import account_platforms as platforms


class Page:
    def __init__(self):
        self.url = 'about:blank'
        self.goto = AsyncMock(side_effect=self.navigate)
        self.bring_to_front = AsyncMock()

    async def navigate(self, url, **kwargs):
        self.url = url

    def on(self, *args):
        pass


class Context:
    def __init__(self):
        self.pages = [Page()]
        self.handlers = {}
        self.close = AsyncMock(side_effect=self.closed)
        self.set_offline = AsyncMock()
        self.new_page = AsyncMock(side_effect=self.new)

    async def new(self):
        page = Page()
        self.pages.append(page)
        return page

    async def closed(self):
        if 'close' in self.handlers:
            self.handlers['close']()

    def on(self, event, callback):
        self.handlers[event] = callback


class ChatGPTAccounts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.m = bm.Manager()
        self.patches = [patch.object(bm, 'DATA', self.root), patch.object(bm, 'manager', self.m), patch.object(bm, 'pelican', bm.PelicanTasks(self.m))]
        for p in self.patches:
            p.start()
        self.m.acquire()
        bm.pelican.initialize()
        self.launch = AsyncMock(side_effect=lambda **kwargs: Context())
        self.m.pw = type('PW', (), {'chromium': type('Chromium', (), {'launch_persistent_context': self.launch})()})()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=bm.app), base_url='http://127.0.0.1:8766', headers={'X-Manager-Request': '1'})

    async def asyncTearDown(self):
        self.m.db.close()
        self.m.guard.close()
        await self.client.aclose()
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    async def account(self, name='ChatGPT fixture'):
        r = await self.client.post('/api/accounts', json={'platform': 'chatgpt', 'name': name, 'note': 'manual fixture'})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()['id']

    async def environment(self, aid=None):
        aid = aid or await self.account()
        return self.m.create_environment(bm.EnvironmentInput(account_id=aid, name='GPT environment'))

    async def test_create_without_credentials_and_legacy_defaults(self):
        aid = await self.account()
        row = self.m.account(aid)
        self.assertEqual((row['platform'], row['login_email'], row['password_cipher']), ('chatgpt', '', ''))
        with self.m.db:
            self.m.db.execute("INSERT INTO accounts VALUES ('legacy','Arena','','fixture@example.invalid','cipher','2026-01-01')")
        self.assertEqual(self.m.account('legacy')['platform'], 'arena')
        self.assertNotIn('password_cipher', self.m.account_snapshot()[0])
        r = await self.client.post('/api/accounts', json={'name': 'Arena without credentials'})
        self.assertEqual(r.status_code, 400)
        r = await self.client.post('/api/accounts', json={'platform': 'chatgpt', 'name': 'bad', 'login_email': 'fixture@example.invalid', 'login_password': 'not-stored'})
        self.assertEqual(r.status_code, 400)

    async def test_metadata_updates_while_running_and_platform_is_immutable(self):
        aid = await self.account()
        eid = await self.environment(aid)
        sentinel = object()
        self.m.contexts[eid] = sentinel
        r = await self.client.put('/api/accounts/'+aid, json={'name': 'Renamed', 'note': 'updated'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.m.account(aid)['platform'], 'chatgpt')
        self.assertIs(self.m.contexts[eid], sentinel)
        r = await self.client.put('/api/accounts/'+aid, json={'platform': 'arena', 'name': 'wrong'})
        self.assertEqual(r.status_code, 409)

    async def test_only_persistent_mode_and_canonical_start_url(self):
        aid = await self.account()
        r = await self.client.post('/api/environments', json={'name': 'bad', 'account_id': aid, 'mode': 'incognito'})
        self.assertEqual(r.status_code, 400)
        eid = await self.environment(aid)
        self.assertEqual(self.m.get(eid)['start_url'], platforms.CHATGPT_HOME)
        r = await self.client.put('/api/environments/'+eid, json={'name': 'renamed', 'account_id': aid, 'start_url': 'https://arena.ai/agent'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.m.get(eid)['start_url'], platforms.CHATGPT_HOME)

    async def test_persistent_reopen_bypasses_all_arena_login_and_plugins(self):
        eid = await self.environment()
        with patch.object(bm.default_plugins, 'key_value', side_effect=AssertionError('Arena key accessed')), patch.object(bm.default_plugins, 'launch_resources', side_effect=AssertionError('Arena plugin download')), patch.object(bm.default_plugins, 'configure_context', side_effect=AssertionError('Arena plugin configured')), patch.object(self.m, 'auto_login', side_effect=AssertionError('Arena login started')), patch.object(bm.pelican, 'stop', side_effect=AssertionError('Arena task stop')), patch.object(bm.pelican, 'browser_closed', side_effect=AssertionError('Arena task close')):
            await self.m.launch(eid)
            first = self.m.contexts[eid]
            first.pages[0].goto.assert_awaited_with(platforms.CHATGPT_LOGIN, wait_until='domcontentloaded', timeout=20000)
            self.assertFalse(self.launch.call_args.kwargs['offline'])
            self.assertEqual(self.launch.call_args.kwargs['args'], ['--disable-extensions'])
            profile = Path(self.launch.call_args.kwargs['user_data_dir'])
            (profile/'fixture-storage').write_text('retained')
            await self.m.launch(eid)
            self.assertEqual(self.launch.await_count, 1)
            await self.m.stop(eid)
            self.assertTrue(profile.exists())
            await self.m.launch(eid)
            self.assertEqual(Path(self.launch.call_args.kwargs['user_data_dir']), profile)
            self.assertEqual((profile/'fixture-storage').read_text(), 'retained')
            self.m.contexts[eid].pages[0].goto.assert_awaited_with(platforms.CHATGPT_HOME, wait_until='domcontentloaded', timeout=20000)
            await self.m.stop(eid)
        self.assertFalse(self.m.login_jobs)
        self.assertFalse(self.m.auth_watch_jobs)
        item = next(e for e in self.m.snapshot() if e['id']==eid)
        self.assertIsNone(item['task'])
        self.assertFalse(item['yescaptcha']['enabled'])
        self.assertFalse(item['trace_inspector']['enabled'])
        self.assertNotEqual(item['auth_status'], 'authenticated')

    async def test_delete_does_not_start_arena_task_cleanup(self):
        aid = await self.account()
        eid = await self.environment(aid)
        profile = self.root/'session-profiles'/eid
        profile.mkdir(parents=True)
        (profile/'fixture-storage').write_text('deleted only on explicit deletion')
        with patch.object(bm.pelican, 'stop', side_effect=AssertionError('Arena task stop')):
            response = await self.client.delete('/api/environments/'+eid)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(profile.exists())
        response = await self.client.delete('/api/accounts/'+aid)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.m.db.execute('SELECT 1 FROM account_platforms WHERE account_id=?', (aid,)).fetchone())

    async def test_arena_endpoints_rejected_and_chat_tab_reused(self):
        eid = await self.environment()
        for method, suffix, body in [
            ('GET', 'pelican', None), ('POST', 'pelican/start', {'kind':'pelican','total':1,'interval':3,'concurrency':1}),
            ('POST', 'pelican/stop', None), ('POST', 'check-login', None), ('POST', 'manual-confirm-login', {'confirmed':True,'email':'fixture@example.invalid'}),
            ('POST', 'open-arena', None), ('PUT', 'trace-inspector', {}), ('PUT', 'yescaptcha', {})]:
            r = await self.client.request(method, '/api/environments/'+eid+'/'+suffix, json=body)
            self.assertEqual(r.status_code, 400, (suffix, r.text))
        r = await self.client.get('/api/file-probe/pages', params={'eid':eid})
        self.assertEqual(r.status_code, 400)
        await self.m.launch(eid)
        context = self.m.contexts[eid]
        r = await self.client.post('/api/environments/'+eid+'/open-chatgpt')
        self.assertEqual(r.status_code, 200, r.text)
        context.new_page.assert_not_awaited()
        await self.m.stop(eid)

    async def test_two_accounts_have_different_profiles_and_survive_restart(self):
        e1, e2 = await self.environment(), await self.environment()
        await self.m.launch(e1)
        p1 = self.launch.call_args.kwargs['user_data_dir']
        await self.m.launch(e2)
        p2 = self.launch.call_args.kwargs['user_data_dir']
        self.assertNotEqual(p1, p2)
        await self.m.stop(e1)
        await self.m.stop(e2)
        aid = self.m.get(e1)['account_id']
        self.m.db.close()
        self.m.guard.close()
        self.m.acquire()
        self.assertEqual(self.m.account(aid)['platform'], 'chatgpt')
        self.assertEqual(self.m.get(e1)['mode'], 'persistent')


if __name__ == '__main__':
    unittest.main(verbosity=2)

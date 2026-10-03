"""Real Chromium profile isolation and retention, with all HTTP requests mocked."""
import asyncio
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import browser_manager as bm
import account_platforms as platforms
from playwright.async_api import async_playwright


async def main():
    with tempfile.TemporaryDirectory() as folder, patch.object(bm,'DATA',Path(folder)):
        m=bm.Manager();m.acquire()
        try:
            with m.db:
                for aid in ['a','b']:
                    m.db.execute('INSERT INTO accounts VALUES (?,?,?,?,?,?)',(aid,aid,'','','','fixture'))
                    platforms.assign(m.db,aid,'chatgpt')
            e1=m.create_environment(bm.EnvironmentInput(name='A',account_id='a'))
            e2=m.create_environment(bm.EnvironmentInput(name='B',account_id='b'))
            async with async_playwright() as pw:
                launch=pw.chromium.launch_persistent_context
                async def isolated(**kwargs):
                    kwargs.update(headless=True,offline=True)
                    context=await launch(**kwargs)
                    await context.route('**/*',lambda route:route.fulfill(content_type='text/html',body='<html><body>Offline manual login fixture</body></html>'))
                    return context
                m.pw=type('PW',(),{'chromium':type('Chromium',(),{'launch_persistent_context':staticmethod(isolated)})()})()
                await m.launch(e1);first=m.contexts[e1]
                assert first.pages[0].url==platforms.CHATGPT_LOGIN
                await first.add_cookies([{'name':'fixture-session','value':'kept','url':platforms.CHATGPT_HOME,'expires':time.time()+86400,'secure':True,'httpOnly':True}])
                await first.pages[0].evaluate("localStorage.setItem('fixture-setting','retained')")
                await m.stop(e1)
                await m.launch(e1);reopened=m.contexts[e1]
                assert reopened.pages[0].url==platforms.CHATGPT_HOME
                assert any(c['name']=='fixture-session' and c['value']=='kept' for c in await reopened.cookies())
                assert await reopened.pages[0].evaluate("localStorage.getItem('fixture-setting')")=='retained'
                await m.launch(e2);other=m.contexts[e2]
                assert not any(c['name']=='fixture-session' for c in await other.cookies())
                assert await other.pages[0].evaluate("localStorage.getItem('fixture-setting')") is None
                assert not m.login_jobs and not m.auth_watch_jobs
                await m.stop(e1);await m.stop(e2)
                print('{"chatgpt_browser":"passed","persistent_cookie_and_local_storage":true,"account_isolation":true,"all_http_mocked":true}')
        finally:
            for context in list(m.contexts.values()):await context.close()
            m.db.close();m.guard.close()


if __name__=='__main__':asyncio.run(main())

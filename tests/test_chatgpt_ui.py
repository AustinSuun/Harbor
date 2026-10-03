"""Rendered platform isolation and ChatGPT workflows; intercepted requests only."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[1]


async def main():
    accounts = [dict(id='arena',platform='arena',name='Arena fixture',note='',login_email='fixture@example.invalid',has_password=True,environment_count=0,running_count=0),
                dict(id='gpt',platform='chatgpt',name='日常 ChatGPT',note='保留环境，用于日常聊天',login_email='',has_password=False,environment_count=0,running_count=0)]
    envs, writes, errors = [], [], []
    def environment(aid):
        return dict(id='env-'+aid,platform='chatgpt',account_id=aid,account_name=next(a['name'] for a in accounts if a['id']==aid),login_email='',name='ChatGPT 保留环境',note='',mode='persistent',status='running',auth_status='manual_login',profile_path='fixture-only',start_url='https://chatgpt.com/',task=None,error='',auth_detail={},yescaptcha={'enabled':False},trace_inspector={'enabled':False})
    async def route(r):
        p = urlparse(r.request.url).path
        if p=='/':
            await r.fulfill(content_type='text/html',body=(ROOT/'browser_manager.html').read_text(encoding='utf-8'));return
        body=json.loads(r.request.post_data or '{}')
        if r.request.method!='GET':writes.append({'path':p,'body':body})
        if p=='/api/environments':data={'environments':envs,'max_running':6,'browser_mode':'fixture'}
        elif p=='/api/accounts' and r.request.method=='GET':data={'accounts':accounts}
        elif p=='/api/accounts' and r.request.method=='POST':
            accounts.append(dict(id='new-gpt',**body,has_password=False,environment_count=0,running_count=0));data={'id':'new-gpt'}
        elif p.startswith('/api/accounts/') and p.endswith('/launch'):
            aid=p.split('/')[3];envs.append(environment(aid));data={'id':'env-'+aid}
        elif p.startswith('/api/environments/') and p.endswith('/stop'):
            next(e for e in envs if e['id']==p.split('/')[3])['status']='stopped';data={'ok':True}
        elif p.startswith('/api/environments/') and p.endswith('/start'):
            next(e for e in envs if e['id']==p.split('/')[3])['status']='running';data={'ok':True}
        elif p.startswith('/api/environments/') and p.endswith('/open-chatgpt'):data={'ok':True}
        elif p=='/api/logs':data={'logs':[]}
        elif p=='/api/updates':data={'available':False,'current_version':'0.3.16'}
        else:
            await r.fulfill(status=404,content_type='application/json',body='{"detail":"unmocked route"}');return
        await r.fulfill(content_type='application/json',body=json.dumps(data))
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chromium',headless=True)
        context=await browser.new_context(viewport={'width':1440,'height':1000})
        await context.route('**/*',route)
        page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            await page.goto('http://127.0.0.1:8766/')
            await page.wait_for_function("document.querySelector('#ui-account-total')?.textContent==='1'")
            assert await page.locator('#account-rows tr').count()==1
            assert 'Arena fixture' in await page.locator('#account-rows').inner_text()
            assert '日常 ChatGPT' not in await page.locator('#account-rows').inner_text()
            await page.locator('#platform-chatgpt').click()
            assert await page.locator('#account-rows tr').count()==1
            assert '日常 ChatGPT' in await page.locator('#account-rows').inner_text()
            assert '密码' not in await page.locator('#account-rows').inner_text()
            assert not await page.locator('#nav-history').is_visible()
            assert not await page.locator('a[href="/thinking-probe"]').is_visible()
            await page.locator('#add-account').click()
            assert not await page.locator('#account-email').is_visible()
            assert not await page.locator('#account-password').is_visible()
            await page.locator('#account-name').fill('工作 ChatGPT')
            await page.locator('#account-note').fill('仅保存环境与备注')
            await page.locator('#account-save').click()
            await page.wait_for_function("document.querySelector('#rows tr')?.textContent.includes('工作 ChatGPT')")
            assert len(envs)==1
            assert writes[0]['body']['platform']=='chatgpt'
            assert writes[0]['body']['login_email']=='' and writes[0]['body']['login_password'] is None
            launches=[w for w in writes if w['path'].endswith('/launch')]
            assert len(launches)==1 and launches[0]['body']['mode']=='persistent'
            assert not await page.locator('#plugins-settings').is_visible()
            assert await page.get_by_role('button',name='自动任务',exact=True).count()==0
            assert await page.get_by_role('button',name='检查登录',exact=True).is_visible()==False
            assert 'Trace Inspector' not in await page.locator('#rows').inner_text()
            await page.get_by_role('button',name='进入聊天',exact=True).click()
            await page.get_by_role('button',name='关闭',exact=True).click()
            await page.wait_for_function("document.querySelector('#rows')?.textContent.includes('未启动')")
            await page.get_by_role('button',name='打开 ChatGPT',exact=True).click()
            await page.wait_for_function("document.querySelector('#rows')?.textContent.includes('运行中')")
            assert len([w for w in writes if w['path'].endswith('/launch')])==1
            assert len(envs)==1
            await page.evaluate('showTask(environments[0])')
            assert not await page.locator('#task-editor').is_visible()
            for width in [1440,390]:
                await page.set_viewport_size({'width':width,'height':1000})
                assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
                screenshot_dir=os.environ.get('HARBOR_CHATGPT_SCREENSHOTS')
                if screenshot_dir:
                    folder=Path(screenshot_dir);folder.mkdir(parents=True,exist_ok=True)
                    await page.screenshot(path=str(folder/f'chatgpt-{width}.png'),full_page=True)
            await page.locator('#platform-arena').click()
            assert 'Arena fixture' in await page.locator('#account-rows').inner_text()
            assert '工作 ChatGPT' not in await page.locator('#account-rows').inner_text()
            assert await page.locator('#nav-history').is_visible()
            assert not any('/pelican' in w['path'] or '/check-login' in w['path'] or '/plugins' in w['path'] for w in writes),writes
            assert not errors,errors
            ids=await page.locator('[id]').evaluate_all('els=>els.map(e=>e.id)');assert len(ids)==len(set(ids))
            print(json.dumps({'chatgpt_ui':'passed','platform_isolation':True,'manual_login_creation':True,'environment_reused':True,'desktop_and_mobile':True,'live_accounts_touched':False}))
        finally:
            if errors:print('UI_ERRORS',json.dumps(errors))
            await context.close();await browser.close()


if __name__=='__main__':asyncio.run(main())

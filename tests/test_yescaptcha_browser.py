"""Mocked UI only. No live manager, accounts, extension, or website calls."""
import asyncio,json,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
bundled_test_browser=ROOT/'release/Harbor-Windows-x64-20260912-105108/Harbor/_internal/bundled-browsers'
if bundled_test_browser.is_dir() and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):
    os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundled_test_browser)
from playwright.async_api import async_playwright

async def main():
    saved=[];errors=[]
    account=dict(id='account',name='fixture',login_email='fixture@example.invalid',note='',environment_count=2,running_count=1,has_password=True)
    base=dict(account_name='fixture',account_id='account',login_email='fixture@example.invalid',note='',profile_path='',auth_status='not_logged_in',task={'status':'idle'},yescaptcha={'enabled':False,'folder':'','runtime':'disabled_on_launch'})
    envs=[dict(base,id='kept',name='kept fixture',mode='persistent',status='running'),dict(base,id='temp',name='temporary fixture',mode='incognito',status='stopped')]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chromium',headless=True)
        context=await browser.new_context()
        async def route(r):
            path=r.request.url.split('8766',1)[-1]
            if path=='/':await r.fulfill(content_type='text/html',body=(ROOT/'browser_manager.html').read_text(encoding='utf-8'));return
            if path=='/api/environments':data={'environments':envs,'max_running':6,'browser_mode':'fixture'}
            elif path=='/api/accounts':data={'accounts':[account]}
            elif path=='/api/logs':data={'logs':[]}
            elif path=='/api/environments/kept/yescaptcha' and r.request.method=='PUT':
                assert r.request.headers.get('x-manager-request')=='1'
                data=json.loads(r.request.post_data);saved.append(data);envs[0]['yescaptcha'].update(data);data={'ok':True}
            else:await r.fulfill(status=404,body='mock route not supplied');return
            await r.fulfill(content_type='application/json',body=json.dumps(data))
        await context.route('**/*',route)
        try:
            page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto('http://127.0.0.1:8766/')
            await page.locator('#nav-environments').click()
            button=page.get_by_role('button',name='YesCaptcha · 关闭',exact=True)
            await button.wait_for();assert await button.count()==1
            await button.click();assert not await page.locator('#yescaptcha-enabled').is_checked()
            assert await page.locator('#yescaptcha-folder').input_value()==''
            await page.locator('#yescaptcha-enabled').check()
            await page.locator('#yescaptcha-folder').fill('C:\\fixture\\YesCaptcha')
            await page.locator('#yescaptcha-save').click()
            await page.locator('#yescaptcha-editor').wait_for(state='hidden')
            assert saved==[{'enabled':True,'folder':'C:\\fixture\\YesCaptcha'}]
            await page.get_by_role('button',name='YesCaptcha · 已配置开启',exact=True).click()
            assert await page.locator('#yescaptcha-enabled').is_checked()
            await page.locator('#yescaptcha-enabled').uncheck();await page.locator('#yescaptcha-save').click()
            await page.locator('#yescaptcha-editor').wait_for(state='hidden')
            assert saved[-1]['enabled'] is False
            assert not errors,errors
            print(json.dumps({'mock_browser_ui':'passed','checks':['persistent_only','default_off','save_enabled','reopen_config','save_disabled','no_js_errors'],'live_manager_touched':False}))
        finally:
            await context.close();await browser.close()
if __name__=='__main__':asyncio.run(main())

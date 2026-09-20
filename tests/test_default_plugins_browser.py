"""Mock UI: global keys and running-account metadata, no live manager/network."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
async def main():
    account=dict(id='a',name='fixture',login_email='fixture@example.invalid',note='old',environment_count=2,running_count=1,has_password=True)
    envs=[dict(id=n,name=n,mode=m,status='running',account_id='a',account_name='fixture',note='',task={'status':'idle'},trace_inspector={'enabled':True},yescaptcha={'enabled':True}) for n,m in [('kept','persistent'),('temp','incognito')]]
    saves=[];notes=[];errors=[];state={'configured':False}
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chromium',headless=True)
        context=await browser.new_context()
        async def route(r):
            path=r.request.url.split('8766',1)[-1]
            if path=='/':await r.fulfill(content_type='text/html',body=(ROOT/'browser_manager.html').read_text(encoding='utf-8'));return
            if path=='/api/accounts':data={'accounts':[account]}
            elif path=='/api/environments':data={'environments':envs,'max_running':6,'browser_mode':'fixture'}
            elif path=='/api/logs':data={'logs':[]}
            elif path=='/api/plugins':
                if r.request.method=='PUT':
                    assert r.request.headers.get('x-manager-request')=='1'
                    body=json.loads(r.request.post_data);saves.append(body)
                    if body.get('clear'):state['configured']=False
                    elif body.get('client_key'):state['configured']=True
                data=dict(state,default_loaded=True,apply_on='next_launch')
            elif path=='/api/accounts/a' and r.request.method=='PUT':
                body=json.loads(r.request.post_data);notes.append(body);account.update(name=body['name'],note=body['note']);data={'ok':True}
            else:await r.fulfill(status=404,body='mock route missing');return
            await r.fulfill(content_type='application/json',body=json.dumps(data))
        await context.route('**/*',route)
        try:
            page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto('http://127.0.0.1:8766/')
            assert not errors,errors
            await page.locator('#account-rows summary').click()
            await page.get_by_role('button',name='编辑账号',exact=True).click()
            assert await page.locator('#account-password').is_disabled()
            await page.locator('#account-note').fill('运行中修改备注')
            await page.locator('#account-save').click();await page.locator('#account-editor').wait_for(state='hidden')
            assert notes[-1]['note']=='运行中修改备注' and notes[-1]['login_password'] is None
            await page.locator('#nav-environments').click()
            assert await page.locator('#rows').get_by_role('button',name='YesCaptcha').count()==0
            assert await page.locator('#rows').get_by_role('button',name='Trace Inspector').count()==0
            await page.locator('#plugins-settings').click()
            assert await page.locator('#plugins-key').input_value()==''
            await page.locator('#plugins-key').fill('fixture-only-key')
            await page.locator('#plugins-save').click()
            await page.wait_for_function("document.querySelector('#plugins-state').textContent.includes('已加密保存')")
            assert saves[-1]=={'client_key':'fixture-only-key'}
            assert await page.locator('#plugins-key').input_value()==''
            await page.locator('#plugins-cancel').click();await page.locator('#plugins-settings').click()
            assert await page.locator('#plugins-key').input_value()==''
            await page.locator('#plugins-clear').click()
            await page.wait_for_function("document.querySelector('#plugins-state').textContent.includes('尚未配置')")
            assert saves[-1]=={'clear':True}
            assert not errors,errors
            print(json.dumps({'ui':'passed','checks':['running_notes','credentials_disabled','no_per_environment_switches','global_save','no_key_readback','clear_next_launch','no_script_errors'],'live_manager_touched':False}))
        finally:await context.close();await browser.close()
if __name__=='__main__':asyncio.run(main())

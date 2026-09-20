"""Official extensions in disposable offline profiles; invalid proxy blocks real traffic."""
import asyncio,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from playwright.async_api import async_playwright
import default_plugins as plugins

async def main():
    with tempfile.TemporaryDirectory(prefix='harbor-default-plugins-') as tmp:
        root=Path(tmp)
        # Only this official ZIP download uses the network; no solver API calls.
        args=await plugins.launch_resources(root)
        args+=['--proxy-server=http://127.0.0.1:9']
        profile=plugins.make_temporary_profile(root)
        async with async_playwright() as pw:
            context=await pw.chromium.launch_persistent_context(str(profile),channel='chromium',headless=True,offline=True,args=args)
            try:
                await plugins.configure_context(context,'')
                workers=[]
                for sw in context.service_workers:
                    if sw.url.startswith('chrome-extension://'):
                        manifest=await sw.evaluate('chrome.runtime.getManifest()');workers.append((sw,manifest))
                assert {m['version'] for _,m in workers}>={'1.4.7','2.0.0'}
                yes=next(sw for sw,m in workers if m['version']=='1.4.7')
                trace=next(sw for sw,m in workers if m['version']=='2.0.0')
                read="async()=>{const {config}=await chrome.storage.local.get('config');return {key:config.clientKey,autorun:config.autorun,hidden:config.isHideKey,inject:config.allowJsInject}}"
                first=await yes.evaluate(read);assert first=={'key':'','autorun':False,'hidden':True,'inject':False}
                await plugins.configure_context(context,'offline-fixture-key')
                configured=await yes.evaluate(read);assert configured['key']=='offline-fixture-key' and configured['autorun'] is True
                await plugins.configure_context(context,'')
                assert (await yes.evaluate(read))['autorun'] is False
                page=await context.new_page()
                await context.route('**/*',lambda r:r.fulfill(content_type='text/html',body='<title>Offline fixture</title><p>Harbor offline fixture</p>'))
                await page.goto('https://arena.ai/agent',wait_until='domcontentloaded')
                await page.wait_for_selector('#arena-trace-inspector-hud')
                assert await page.title()=='Offline fixture'
                (profile/'cleanup-fixture.txt').write_text('must disappear')
            finally:await context.close()
        await plugins.remove_temporary_profile(profile);assert not profile.exists()
        # Cached official bytes also pass after Chromium loaded the plugin.
        plugins.ensure_yescaptcha(root)
        print(json.dumps({'both_extensions_loaded':True,'empty_key_disables_autorun':True,'key_sync_and_clear':True,'trace_hud_present':True,'temporary_profile_deleted':True,'offline':True,'paid_requests':False,'real_accounts_used':False}))
if __name__=='__main__':asyncio.run(main())

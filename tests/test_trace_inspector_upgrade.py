"""Optional offline extension upgrade with a disposable profile, never user data."""
import asyncio,os,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from playwright.async_api import async_playwright
from trace_inspector_bundle import verified_bundle,BUNDLE_VERSION

async def main():
    previous=os.environ.get('HARBOR_PREVIOUS_TRACE_BUNDLE')
    if not previous:
        print('SKIP: HARBOR_PREVIOUS_TRACE_BUNDLE required');return
    old=Path(previous).resolve();new=Path(verified_bundle())
    assert json.loads((old/'manifest.json').read_text(encoding='utf-8'))['version']=='2.0.0'
    with tempfile.TemporaryDirectory(prefix='harbor-trace-upgrade-') as profile:
        identities=[]
        async with async_playwright() as pw:
            for number,folder in enumerate([old,new]):
                context=await pw.chromium.launch_persistent_context(profile,channel='chromium',headless=True,offline=True,args=[f'--load-extension={folder}',f'--disable-extensions-except={folder}','--proxy-server=http://127.0.0.1:9'])
                try:
                    sw=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker',timeout=15000)
                    identities.append(await sw.evaluate('chrome.runtime.id'))
                    version=await sw.evaluate('chrome.runtime.getManifest().version')
                    assert version==('2.0.0' if number==0 else BUNDLE_VERSION),version
                    if number==0:await sw.evaluate("chrome.storage.local.set({'ati.harbor.upgrade.fixture':'synthetic-preference'})")
                    else:assert (await sw.evaluate("chrome.storage.local.get('ati.harbor.upgrade.fixture')"))['ati.harbor.upgrade.fixture']=='synthetic-preference'
                finally:await context.close()
        assert identities[0]==identities[1]
        print(json.dumps({'old_version':'2.0.0','new_version':BUNDLE_VERSION,'same_extension_id':identities[0],'synthetic_storage_retained':True,'real_records_used':False,'offline':True}))
if __name__=='__main__':asyncio.run(main())

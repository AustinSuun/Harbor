"""Opt-in smoke check of a local extension in a disposable offline profile.
Never attaches to user browsers, sends a prompt, or reads real Arena data.
"""
import asyncio,json,os,sys,tempfile,base64,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import trace_inspector_support as ext
from playwright.async_api import async_playwright

async def main():
 folder=os.environ.get('HARBOR_TEST_TRACE_FOLDER')
 if not folder:
  print('SKIP: set HARBOR_TEST_TRACE_FOLDER for isolated offline extension smoke test');return
 bundles=sorted((ROOT/'release').glob('Harbor-Windows-x64-*/Harbor/_internal/bundled-browsers'))
 if bundles and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundles[-1])
 args=ext.launch_args('persistent',{'enabled':True,'folder':folder},['--disable-extensions'])
 with tempfile.TemporaryDirectory(prefix='harbor-trace-offline-') as profile:
  async with async_playwright() as pw:
   context=await pw.chromium.launch_persistent_context(profile,channel='chromium',headless=True,args=args,offline=True)
   try:
    await context.route('**/*',lambda r:r.fulfill(content_type='text/html',body='<title>Offline fixture</title><p>Harbor isolated fixture</p>'))
    sw=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker',timeout=15000)
    assert (await sw.evaluate('chrome.runtime.getManifest().name'))=='Arena Trace Inspector'
    manifest=await sw.evaluate('chrome.runtime.getManifest()')
    extension_id=await sw.evaluate('chrome.runtime.id')
    expected_key=json.loads((Path(folder)/'manifest.json').read_text(encoding='utf-8')).get('key')
    if expected_key:
     expected_id=''.join(chr(97+int(c,16)) for c in hashlib.sha256(base64.b64decode(expected_key)).hexdigest()[:32])
     assert extension_id==expected_id and manifest['version']=='2.3.0'
    page=await context.new_page()
    cdp=await context.new_cdp_session(page);worlds=[]
    cdp.on('Runtime.executionContextCreated',lambda event:worlds.append(event['context']))
    cdp.on('Runtime.executionContextsCleared',lambda event:worlds.clear())
    cdp.on('Runtime.executionContextDestroyed',lambda event:worlds.__setitem__(slice(None),[w for w in worlds if w['id']!=event['executionContextId']]))
    await cdp.send('Runtime.enable')
    await page.goto('https://arena.ai/agent',wait_until='domcontentloaded')
    await page.wait_for_selector('#arena-trace-inspector-hud')
    startup=None
    for world in worlds:
     if world.get('auxData',{}).get('isDefault'):continue
     check=await cdp.send('Runtime.evaluate',{'contextId':world['id'],'expression':'Boolean(globalThis.ArenaAutoDraw)','returnByValue':True})
     if check.get('result',{}).get('value'):
      response=await cdp.send('Runtime.evaluate',{'contextId':world['id'],'expression':"(async()=>({draw:globalThis.ArenaAutoDraw.status(),state:await chrome.runtime.sendMessage({type:'ATI_STATUS',pageUrl:location.href})}))()",'awaitPromise':True,'returnByValue':True})
      startup=response['result']['value'];break
    assert startup is not None,'Extension content scripts did not initialize'
    assert startup['draw']['running'] is False and startup['draw']['sent'] is False
    assert startup['state']['enabled'] is False
    await cdp.detach()
    result=await sw.evaluate('''async()=>{const tabs=await chrome.tabs.query({url:'https://arena.ai/*'});if(tabs.length!==1)throw Error('ambiguous fixture target');const target={tabId:tabs[0].id};try{await chrome.debugger.attach(target,'1.3');await chrome.debugger.sendCommand(target,'Network.enable');return {attached:true}}catch(e){return {attached:false,error:String(e.message).slice(0,200)}}finally{await chrome.debugger.detach(target).catch(()=>{})}}''')
    assert await page.evaluate('document.title')=='Offline fixture'
    print(json.dumps({'extension_service_worker_loaded':True,'stable_bundle_id':extension_id if expected_key else None,'manual_listening_default':True,'automatic_drawing_started':False,'content_scripts_initialized':True,'isolated_debugger':result,'playwright_still_usable':True,'offline':True,'real_accounts_used':False,'real_trace_verified':False}))
    assert result['attached'], 'Extension debugger could not coexist with Playwright in isolated fixture'
   finally:await context.close()
if __name__=='__main__':asyncio.run(main())

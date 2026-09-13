
import asyncio,re,json
from pathlib import Path
import os
ROOT=Path(__file__).resolve().parents[1]
bundles=sorted((ROOT/'release').glob('Harbor-Windows-x64-*/Harbor/_internal/bundled-browsers'))
if bundles and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundles[-1])
from playwright.async_api import async_playwright
async def run():
 html=(ROOT/'browser_manager.html').read_text(encoding='utf-8')
 script=html.split('// Move existing nodes:',1)[1].split('if(localStorage.getItem',1)[0]
 script='// Move existing nodes:'+script
 async with async_playwright() as pw:
  browser=await pw.chromium.launch(channel='chromium',headless=True)
  page=await browser.new_page()
  await page.set_content(re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S))
  await page.evaluate("const $=id=>document.getElementById(id);window.testCalls=[];async function api(p,m){testCalls.push([p,m]);return {available:true,install_supported:true,current_version:'0.3.8',latest_version:'0.3.9'}}function notify(){}\n"+script+'\nvoid 0;')
  assert await page.locator('aside #github-link').count()==0
  assert await page.locator('.project-header #github-link svg').count()==1
  assert await page.locator('#check-update').count()==1
  assert await page.locator('#install-update').is_hidden()
  for width in (1440,900,390):
   await page.set_viewport_size({'width':width,'height':950})
   box=await page.locator('.project-header').bounding_box();link=await page.locator('#github-link').bounding_box();btn=await page.locator('#check-update').bounding_box()
   assert link['x']>=box['x'] and btn['x']+btn['width']<=width, (width,box,link,btn)
   assert btn['y']<box['y']+100 and link['y']<box['y']+100
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  await page.locator('#check-update').click()
  assert '0.3.8' in await page.locator('#update-state').inner_text()
  assert await page.locator('#install-update').is_visible()
  await page.locator('#install-update').click()
  assert await page.evaluate("testCalls.some(x=>x[0]==='updates/install'&&x[1]==='POST')")
  assert await page.locator('#github-link').get_attribute('href')=='https://github.com/AustinSuun/Harbor'
  await browser.close()
 print(json.dumps({'passed':True,'widths':[1440,900,390],'checks':['sidebar removed','one SVG GitHub link','unique original controls','responsive bounds/no horizontal overflow','check update binding','install binding'],'live_manager_restarted':False}))
asyncio.run(run())

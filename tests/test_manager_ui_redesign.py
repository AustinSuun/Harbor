"""Harbor UI regression using synthetic data and intercepted requests only."""
import asyncio,json,os
from pathlib import Path
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[1]
bundles=sorted((ROOT/'release').glob('Harbor-Windows-x64-*/Harbor/_internal/bundled-browsers'))
if bundles and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundles[-1])
from playwright.async_api import async_playwright

async def main():
 accounts=[dict(id='a'+str(i),name=name,login_email=f'fixture{i}@example.invalid',note=note,environment_count=count,running_count=int(i==0),has_password=True) for i,(name,note,count) in enumerate([('设计工作账号','日常动画测试，优先保留优质作品。',2),('备用测试账号','仅用于合成页面测试。长备注应完整换行，不会被省略或隐藏。',1),('新建账号','',0)])]
 jobs=[dict(number=i+1,status=s,message=m) for i,(s,m) in enumerate([('success','回复完成，已保存结果'),('generating','等待回复完成；仍占用调度名额'),('attention','尚未确认网页是否完成，请检查原对话'),('pending','等待执行')])]
 task=dict(status='running',settings={'kind':'pelican','total':8,'concurrency':5,'interval':15,'capture_screenshot':True},jobs=jobs,active=2,submitted=3,success=1,finished=1,failed=0,unknown=0,untracked=0)
 def env(eid,aid,name,mode,state):return dict(id=eid,account_id=aid,account_name=accounts[int(aid[1:])]['name'],login_email='fixture@example.invalid',name=name,note='独立浏览器资料',mode=mode,status=state,profile_path='',auth_status='authenticated' if state=='running' else 'not_logged_in',task=task if state=='running' else {'status':'idle'},yescaptcha={'enabled':False,'folder':'','runtime':'disabled_on_launch'},trace_inspector={'enabled':False,'folder':'','runtime':'disabled_on_launch'})
 envs=[env('e0','a0','动画设计 · 保留环境','persistent','running'),env('e1','a0','临时预览','incognito','stopped'),env('e2','a1','备用工作区','persistent','stopped')]
 sample_html='<html><body style="margin:0;background:#eaf3e4;display:grid;place-items:center;height:100vh;color:#326b4c;font-family:system-ui"><svg width="180" height="150" viewBox="0 0 180 150"><circle cx="45" cy="105" r="25" fill="none" stroke="#507859" stroke-width="3"/><circle cx="130" cy="105" r="25" fill="none" stroke="#507859" stroke-width="3"/><path d="M45 105L82 70l48 35H45l24-48h25" fill="none" stroke="#b48b45" stroke-width="4"/><path d="M84 71c-20-8-25-28-10-38 19-9 38 2 40 12l37 3-32 9-15 20" fill="#fff" stroke="#648766" stroke-width="2"/></svg></body></html>'
 results=[dict(id='r'+str(i),kind=k,account_name=accounts[i%2]['name'],account_email=f'fixture{i}@example.invalid',environment_name=envs[i]['name'],saved_at='2026-09-17T04:30:00Z',rating='good' if i==0 else 'pending',starred=i==0,html_candidate={'raw_lines':112+i*30,'nonempty_lines':98,'candidate':i<2,'status':'over_threshold_keep' if i==2 else 'candidate'}) for i,k in enumerate(['pelican','stickman','recreate'])]
 writes=[];errors=[];checks=[];offline_error=False
 screenshot_dir=os.environ.get('HARBOR_UI_SCREENSHOTS')
 if screenshot_dir:Path(screenshot_dir).mkdir(parents=True,exist_ok=True)
 async with async_playwright() as pw:
  browser=await pw.chromium.launch(channel='chromium',headless=True)
  context=await browser.new_context(viewport={'width':1440,'height':1080},device_scale_factor=1)
  async def route(r):
   nonlocal offline_error
   p=urlparse(r.request.url).path
   if p=='/':await r.fulfill(content_type='text/html',body=(ROOT/'browser_manager.html').read_text(encoding='utf-8'));return
   if r.request.method not in ('GET','HEAD'):writes.append({'path':p,'body':json.loads(r.request.post_data or '{}')})
   if p=='/api/environments':
    if offline_error:await r.fulfill(status=503,content_type='application/json',body='{"detail":"模拟连接中断"}');return
    data={'environments':envs,'max_running':6,'browser_mode':'fixture'}
   elif p=='/api/accounts':data={'accounts':accounts}
   elif p=='/api/logs':data={'logs':[]}
   elif p=='/api/updates':data={'available':False,'current_version':'0.3.9'}
   elif p=='/api/html-results':data={'total':3,'limit':100,'results':results}
   elif p.endswith('/preview'):data={'html':sample_html}
   elif p=='/api/records':data={'total':0,'records':[]}
   elif p.endswith('/trace-inspector') or p.endswith('/yescaptcha') or p.endswith('/stop'):data={'ok':True}
   else:await r.fulfill(status=404,content_type='application/json',body='{"detail":"not a fixture route"}');return
   await r.fulfill(content_type='application/json',body=json.dumps(data))
  await context.route('**/*',route)
  page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   await page.goto('http://127.0.0.1:8766/')
   await page.wait_for_function("document.querySelector('#ui-account-total')?.textContent==='3'")
   assert not errors,errors
   assert await page.locator('#nav-accounts').get_attribute('aria-current')=='page'
   assert await page.locator('#account-rows tr').count()==3;assert await page.locator('.project-header #github-link svg').count()==1
   assert not writes;checks.append('initial_accounts_and_header_no_mutations')
   if screenshot_dir:await page.screenshot(path=str(Path(screenshot_dir)/'accounts-desktop.jpg'),type='jpeg',quality=80)
   await page.locator('#account-search').fill('长备注');assert await page.locator('#account-rows tr').count()==1
   await page.locator('#account-search').fill('no-match');assert await page.locator('#account-empty').is_visible();await page.get_by_role('button',name='清空搜索',exact=True).click();assert await page.locator('#account-rows tr').count()==3;checks.append('account_search_notes_and_empty_recovery')
   await page.locator('#add-account').click();await page.locator('#account-password').fill('fixture-only');await page.get_by_role('button',name='显示密码',exact=True).click();assert await page.locator('#account-password').get_attribute('type')=='text';await page.locator('#account-cancel').click();await page.wait_for_function("document.querySelector('#account-password').value===''&&document.querySelector('#account-password').type==='password'");assert await page.locator('#account-password').input_value()=='';assert await page.locator('#account-password').get_attribute('type')=='password';checks.append('password_visibility_and_clear_on_close')
   await page.locator('#account-rows tr').first.get_by_role('button',name='查看环境',exact=True).click();assert await page.locator('#env-account-filter').input_value()=='a0';assert await page.locator('#rows tr').count()==2;checks.append('exact_account_environment_filter')
   await page.locator('#env-account-filter').select_option('');await page.locator('#env-mode-filter').select_option('persistent');assert await page.locator('#rows tr').count()==2
   await page.locator('#env-status-filter').select_option('running');assert await page.locator('#rows tr').count()==1
   assert await page.locator('#batch-start').is_disabled();await page.locator('#select-all').check();assert not await page.locator('#batch-stop').is_disabled();assert await page.locator('#batch-start').is_disabled();checks.append('combined_environment_filters_and_batch_eligibility')
   await page.locator('#env-mode-filter').select_option('');await page.locator('#env-status-filter').select_option('');
   more=page.locator('#rows tr').first.locator('.ui-row-more');await more.locator('summary').click();await page.evaluate('refresh()');assert await more.get_attribute('open') is not None;checks.append('more_actions_survive_poll')
   await more.locator('summary').click()
   if screenshot_dir:await page.screenshot(path=str(Path(screenshot_dir)/'environments-desktop.jpg'),type='jpeg',quality=80)
   await page.locator('#rows tr').first.get_by_role('button',name='自动任务',exact=True).click();assert await page.locator('#task-editor').is_visible()
   assert await page.locator('#ui-task-plan').inner_text()=='8';assert await page.locator('#ui-task-attention').inner_text()=='1';assert '调度占用' in await page.locator('#task-summary').inner_text();assert await page.locator('#task-start').is_disabled();assert not await page.locator('#task-stop').is_disabled();checks.append('task_progress_truthful_labels_and_running_lock')
   assert await page.locator('#ui-task-experiments').get_attribute('open') is None
   await page.locator('#ui-task-experiments summary').click();assert not await page.locator('#task-thinking').is_checked();assert not await page.locator('#task-auto-archive').is_checked();await page.locator('#ui-task-experiments summary').click()
   if screenshot_dir:await page.screenshot(path=str(Path(screenshot_dir)/'task-desktop.jpg'),type='jpeg',quality=80)
   await page.get_by_role('button',name='关闭自动任务面板',exact=True).click();assert not writes;checks.append('task_close_does_not_stop_or_send')
   await page.locator('#nav-history').click();await page.locator('.html-card').first.wait_for();assert await page.locator('.html-card').count()==3
   assert all(x=='' for x in await page.locator('.html-card iframe').evaluate_all("els=>els.map(e=>e.getAttribute('sandbox'))"));checks.append('gallery_sandbox_preserved')
   if screenshot_dir:await page.screenshot(path=str(Path(screenshot_dir)/'results-desktop.jpg'),type='jpeg',quality=80)
   await page.locator('#history-mode').select_option('records');assert await page.locator('#history-table-section').is_visible();assert not await page.locator('#html-gallery-section').is_visible();checks.append('history_mode_switch')
   offline_error=True;await page.locator('#nav-accounts').click();await page.evaluate('refresh()');assert await page.locator('#connection').is_visible();assert '连接中断' in await page.locator('#ui-connection-status').inner_text();offline_error=False;await page.evaluate('refresh()');assert await page.locator('#connection').is_hidden();checks.append('global_connection_error_and_recovery')
   for width in (1440,1024,768,390):
    await page.set_viewport_size({'width':width,'height':920})
    for nav in ('accounts','environments','history'):
     await page.locator('#nav-'+nav).click()
     assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,nav)
    await page.locator('#nav-environments').click();await page.locator('#rows tr').first.get_by_role('button',name='自动任务',exact=True).click()
    assert await page.locator('#task-editor').evaluate('e=>e.scrollWidth<=e.clientWidth+1'),('dialog overflow',width)
    await page.get_by_role('button',name='关闭自动任务面板',exact=True).click()
   checks.append('responsive_pages_and_task_dialog_1440_1024_768_390')
   await page.locator('#nav-accounts').click()
   if screenshot_dir:await page.screenshot(path=str(Path(screenshot_dir)/'accounts-mobile.jpg'),type='jpeg',quality=80,full_page=True)
   assert not errors,errors;assert not writes,writes
   # Only visible selected rows may be affected by a batch action (all APIs are mocked).
   await page.locator('#nav-environments').click()
   await page.evaluate("selected=new Set(['e0','e2']);environments.find(e=>e.id==='e2').status='running';$('env-account-filter').value='a0';render()")
   await page.evaluate("batch('stop')")
   assert [w['path'] for w in writes]==['/api/environments/e0/stop'],writes
   writes.clear();checks.append('batch_does_not_operate_hidden_selected_rows')
   # A specific-account shortcut resets stale status/mode filters.
   await page.locator('#env-status-filter').select_option('error')
   await page.locator('#env-mode-filter').select_option('incognito')
   await page.locator('#nav-accounts').click()
   await page.locator('#account-rows tr').nth(1).get_by_role('button',name='查看环境',exact=True).click()
   assert await page.locator('#env-status-filter').input_value()==''
   assert await page.locator('#env-mode-filter').input_value()==''
   assert await page.locator('#rows tr').count()==1
   checks.append('account_shortcut_clears_conflicting_filters')
   # Idle task settings remain editable, no new concurrency max and guide updates on selection.
   await page.locator('#rows tr').first.get_by_role('button',name='自动任务',exact=True).click()
   await page.locator('#task-concurrency').fill('20')
   assert await page.locator('#task-concurrency').evaluate('e=>e.checkValidity()')
   await page.locator('#task-kind').select_option('stickman')
   assert await page.locator('#ui-task-guide').get_attribute('open') is not None
   assert '火柴人大战' in await page.locator('#task-prompt-preview').inner_text()
   await page.get_by_role('button',name='关闭自动任务面板',exact=True).click()
   checks.append('idle_settings_no_concurrency_cap_and_dynamic_guide')
   assert not errors,errors;assert not writes,writes
   ids=await page.locator('[id]').evaluate_all('els=>els.map(e=>e.id)');assert len(ids)==len(set(ids));checks.append('unique_ids_no_script_errors_no_live_actions')
   print(json.dumps({'ui_redesign':'passed','checks':checks,'synthetic_only':True,'screenshots':bool(screenshot_dir),'real_manager_touched':False}))
  finally:
   if errors:print('UI_ERRORS',json.dumps(errors))
   await context.close();await browser.close()
if __name__=='__main__':asyncio.run(main())

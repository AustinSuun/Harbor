"""Synthetic DOM + immediate-stop checks. No live Arena or paid requests."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
import probe
from candidate_policy import ImmediateThinking
from validate import LIVE, STYLE, main as baseline

ROOT=Path(__file__).resolve().parents[2]
bundled_test_browser=ROOT/'release/Harbor-Windows-x64-20260912-105108/Harbor/_internal/bundled-browsers'
if bundled_test_browser.is_dir() and not os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):
    os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(bundled_test_browser)

async def main():
    from playwright.async_api import async_playwright
    output=Path(__file__).parent/'thinking-validation'
    await baseline(SimpleNamespace(references=None,output=str(output/'baseline')))
    checks=[]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chromium',headless=True)
        context=await browser.new_context()
        await context.route('**/*',lambda r:r.abort())
        try:
            page=await context.new_page()
            cases=[
                ('completed_parent_beats_stale_child',LIVE.replace('data-state="streaming" id="answer"','data-state="completed" id="answer"'),False),
                ('conflicting_completed_reasoning_beats_streaming',LIVE.replace('id="reason"','data-status="completed" id="reason"'),False),
                ('new_user_turn_invalidates_old_assistant',LIVE+'<div data-message-role="user">new request</div>',False),
                ('user_example_not_status',LIVE.replace('<div data-part-type','<div data-message-role="user"><div data-part-type').replace('Thinking</div>','Thinking</div></div>'),False),
                ('preview_example_not_status',LIVE.replace('<div data-part-type','<div class="preview"><div data-part-type').replace('Thinking</div>','Thinking</div></div>'),False),
                ('blockquote_example_not_status',LIVE.replace('<div data-part-type','<blockquote><div data-part-type').replace('Thinking</div>','Thinking</div></blockquote>'),False),
                ('aria_hidden_reasoning',LIVE.replace('id="reason"','aria-hidden="true" id="reason"'),False),
                ('active_testid_reasoning',LIVE.replace('data-part-type="reasoning"','data-testid="thinking-panel"'),True),
                ('spinner_or_status_word_alone_is_unknown',LIVE.replace('data-part-type="reasoning"','role="status"'),False),
            ]
            for name,html,expected in cases:
                await page.set_content(STYLE+html)
                s=await probe.inspect(page)
                assert s['thinking_explicit'] is expected,(name,s)
                checks.append(name)
            await page.set_content(STYLE+LIVE)
            s=await probe.inspect(page);policy=ImmediateThinking(s['url'],s['turn_id'])
            await page.evaluate("() => {window.clicks=0;document.querySelector('#stop').onclick=()=>window.clicks++;}")
            r=await probe.attempt_stop(page,policy)
            assert r['status']=='would_request_stop' and await page.evaluate('window.clicks')==0
            checks.append('immediate_policy_defaults_to_dry_run')
            for name,window in [('wrong_task_url',ImmediateThinking('https://arena.ai/agent/other',s['turn_id'])),('wrong_turn_id',ImmediateThinking(s['url'],'other-turn'))]:
                r=await probe.attempt_stop(page,window,dry_run=False)
                assert not r['click_attempted'];checks.append(name)
            original=probe.inspect;calls=0
            async def changed(p):
                nonlocal calls
                calls+=1;v=await original(p)
                if calls>=2:v['turn_id']='changed-turn'
                return v
            probe.inspect=changed
            try:
                r=await probe.attempt_stop(page,policy,dry_run=False)
                assert r['status']=='state_changed' and not r['click_attempted']
            finally:probe.inspect=original
            checks.append('turn_changes_during_recheck_no_click')
            await page.evaluate("() => {document.querySelector('#stop').onclick=()=>{window.clicks++;document.querySelector('#answer').setAttribute('data-state','completed');document.querySelector('#reason').setAttribute('data-state','completed');document.querySelector('#stop').remove()};}")
            r=await probe.attempt_stop(page,policy,dry_run=False)
            assert r['status']=='ui_idle_after_stop' and await page.evaluate('window.clicks')==1
            assert r['server_cancelled']=='unknown' and not r['slot_released']
            checks.append('immediate_single_click_and_verified_ui_idle')
            await page.set_content(STYLE+LIVE)
            await page.evaluate("() => {window.clicks=0;document.querySelector('#stop').onclick=()=>window.clicks++;}")
            s=await probe.inspect(page)
            r=await probe.attempt_stop(page,ImmediateThinking(s['url'],s['turn_id']),dry_run=False,verification_seconds=.4)
            assert r['status']=='stop_not_verified' and await page.evaluate('window.clicks')==1
            assert not r['slot_released'];checks.append('ineffective_immediate_stop_no_retry')
        finally:
            await context.close();await browser.close()
    report=dict(mode='synthetic_browser_only',baseline_checks=16,additional_checks=checks,
                total_checks=16+len(checks),live_arena_calibrated=False,existing_tabs_touched=False,
                production_stop_enabled=False,internal_reasoning_read=False)
    output.mkdir(parents=True,exist_ok=True)
    (output/'immediate-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':asyncio.run(main())

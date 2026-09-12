"""Synthetic browser tests only. No Arena request, saved profile or account DB.
Usage: python validate.py [--references PATH] [--output PATH]
Needs playwright + its Chromium, Pillow. Does not install them automatically.
"""
import argparse
import asyncio
import json
from pathlib import Path
import time
from playwright.async_api import async_playwright
from probe import ThinkingWindow, inspect, attempt_stop, inspect_artifact, render_offline, frame_measurements

LIVE='''<div data-message-role="assistant" data-message-id="turn-1" data-state="streaming" id="answer"><div data-part-type="reasoning" data-state="streaming" id="reason">Thinking</div></div>
<form><textarea></textarea><button type="button" id="stop" aria-label="Stop generating">Stop</button></form>'''
STYLE='<style>body{font:16px sans-serif}textarea{width:200px;height:40px}</style>'


def seed(snapshot):
    window=ThinkingWindow(required_seconds=3)
    now=time.monotonic()
    for offset in (3.1,2,1):window.observe(snapshot,now-offset)
    return window


async def main(args):
    results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(channel='chromium',headless=True)
        context=await browser.new_context()
        await context.route('**/*',lambda route:route.abort())
        page=await context.new_page()
        cases=[
          ('plain_word_is_not_thinking',LIVE.replace('data-part-type="reasoning" data-state="streaming"',''),False,1),
          ('historical_reasoning_is_not_live',LIVE.replace('id="reason"','data-status="completed" id="reason"').replace('data-part-type="reasoning" data-state="streaming"','data-part-type="reasoning" data-state="completed"'),False,1),
          ('explicit_live_marker',LIVE,True,1),
          ('hidden_marker',LIVE.replace('id="reason"','style="display:none" id="reason"'),False,1),
          ('transparent_marker',LIVE.replace('id="reason"','style="opacity:0" id="reason"'),False,1),
          ('code_example_not_status',LIVE.replace('<div data-part-type','<pre><div data-part-type').replace('Thinking</div>','Thinking</div></pre>'),False,1),
          ('old_turn_ignored',LIVE+'<div data-message-role="assistant" data-message-id="turn-2">done</div>',False,1),
          ('duplicate_stop_is_ambiguous',LIVE.replace('</form>','<button type="button">Stop</button></form>'),True,2),
          ('multiple_composers_refuse_stop',LIVE+'<form><textarea></textarea><button>Stop</button></form>',True,0),
          ('stop_outside_composer_ignored',LIVE.replace('<form>','<div>').replace('</form>','</div>'),True,0),
        ]
        for name,html,thinking,count in cases:
            await page.set_content(STYLE+html)
            s=await inspect(page)
            assert s['thinking_explicit']==thinking,(name,s)
            assert s['stop_count']==count,(name,s)
            results.append({'test':name,'passed':True})
        await page.set_content(STYLE+LIVE)
        initial=await inspect(page)
        window=ThinkingWindow(required_seconds=3)
        assert not window.observe(initial,10)
        assert not window.observe(initial,11)
        assert window.observe(initial,13)
        assert not window.observe(initial,20)  # observation gap resets
        other=dict(initial,turn_id='turn-other')
        assert not window.observe(other,21)
        unknown=dict(initial,thinking_explicit=False)
        assert not window.observe(unknown,22)
        results.append({'test':'continuity_gap_and_turn_change_reset','passed':True})
        await page.evaluate("() => {window.clicks=0;document.querySelector('#stop').onclick=()=>{window.clicks++};}")
        result=await attempt_stop(page,seed(initial))
        assert result['status']=='would_request_stop' and await page.evaluate('window.clicks')==0,result
        results.append({'test':'dry_run_does_not_click','passed':True})
        await page.evaluate("() => {document.querySelector('#stop').onclick=()=>{window.clicks++;document.querySelector('#answer').removeAttribute('data-state');document.querySelector('#reason').setAttribute('data-state','completed');document.querySelector('#stop').remove()};}")
        result=await attempt_stop(page,seed(initial),dry_run=False)
        assert result['status']=='ui_idle_after_stop' and await page.evaluate('window.clicks')==1,result
        assert result['server_cancelled']=='unknown' and not result['slot_released']
        results.append({'test':'one_click_then_stable_ui_idle_not_server_proof','passed':True})
        await page.set_content(STYLE+LIVE)
        await page.evaluate("() => {window.clicks=0;document.querySelector('#stop').onclick=()=>window.clicks++;}")
        result=await attempt_stop(page,seed(await inspect(page)),dry_run=False,verification_seconds=.6)
        assert result['status']=='stop_not_verified' and await page.evaluate('window.clicks')==1,result
        assert not result['slot_released']
        results.append({'test':'ineffective_stop_no_retry_no_release','passed':True})
        await page.set_content(STYLE+LIVE.replace('data-message-id="turn-1"','').replace('id="answer"',''))
        result=await attempt_stop(page,seed(await inspect(page)),dry_run=False)
        assert not result['click_attempted']
        results.append({'test':'missing_turn_identity_refuses_action','passed':True})
        await context.close()
        checks=[('recreate','<svg></svg>','forbidden_element:svg'),
                ('recreate','<img src="x">','forbidden_element:img'),
                ('recreate','<style>.x{background:u\\72l(x)}</style>','css_image_or_external_resource'),
                ('stickman','<svg onload="x()"></svg>','script_or_event_handler')]
        for kind,source,expected in checks:
            assert expected in inspect_artifact(source,kind)['findings']
        assert inspect_artifact('<style>@keyframes x{to{opacity:0}}</style><div></div>','recreate')['visual_quality']=='not_assessed'
        # Pelican's current actual prompt does not forbid JavaScript.
        assert 'script_or_event_handler' not in inspect_artifact('<svg/><script>x()</script>','pelican')['findings']
        results.append({'test':'artifact_constraints_and_task_specific_rules','passed':True})
        references=[]
        if args.references:
            for name in ('gacha-pelican-good.svg','gacha-pelican.svg','gacha-stick-duel.svg'):
                source=(Path(args.references)/name).read_text(encoding='utf-8')
                target=Path(args.output)/name.removesuffix('.svg')
                frames=await render_offline(browser,source,output_dir=target)
                references.append({'source':name,'frames':frames,**frame_measurements(frames)})
            # Moving does NOT imply good: retain measurements of both source examples.
        await browser.close()
    report={'mode':'isolated_synthetic_only','production_integrated':False,
            'account_accessed':False,'github_changed':False,'tests':results,'references':references}
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    (output/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--references');parser.add_argument('--output',default='experiment-results')
    asyncio.run(main(parser.parse_args()))

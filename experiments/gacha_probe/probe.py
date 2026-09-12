"""Experimental adapter, imported only when the task opt-in setting is enabled.
Never infers model identity; never closes a page or releases a worker slot.
"""
from dataclasses import dataclass, field
from html.parser import HTMLParser
import asyncio
import base64
import re
import time

DOM_HELPERS = r'''
const excluded = e => !!e.closest('pre,code,blockquote,[data-message-role="user"],[data-message-author-role="user"],[data-role="user"],[data-testid*="preview"],.preview,[role="dialog"]');
const visible = e => {
 if(!e || !e.isConnected || e.closest('[hidden],[aria-hidden="true"]'))return false;
 const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;
 for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}
 return true;
};
const assistant='[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"],[data-testid="assistant-turn"]';
let roots=[...document.querySelectorAll(assistant)].filter(e=>visible(e)&&!excluded(e));
roots=roots.filter(e=>!roots.some(p=>p!==e&&p.contains(e)));
let root=roots.at(-1);
const users=[...document.querySelectorAll('[data-message-role="user"],[data-message-author-role="user"],[data-role="user"]')].filter(e=>visible(e)&&!e.closest('pre,code,blockquote,[data-testid*="preview"],.preview'));
const latestUser=users.at(-1);
if(root&&latestUser&&!root.contains(latestUser)&&(root.compareDocumentPosition(latestUser)&Node.DOCUMENT_POSITION_FOLLOWING))root=null;
const completed=e=>e.matches('[data-state="completed"],[data-state="complete"],[data-state="done"],[data-status="completed"],[data-status="complete"],[data-status="done"]');
const active=e=>!completed(e)&&e.matches('[data-state="streaming"],[data-status="streaming"],[data-is-streaming="true"],[data-streaming="true"]');
const reasoning=root?[...root.querySelectorAll('[data-part-type="reasoning"],[data-type="reasoning"],[data-testid="reasoning-panel"],[data-testid="thinking-panel"],[data-testid="thinking-block"]')].filter(e=>visible(e)&&!excluded(e)):[];
const thinking=!!root&&!completed(root)&&reasoning.some(active);
const editors=[...document.querySelectorAll('textarea,[contenteditable="true"][data-lexical-editor],[role="textbox"][contenteditable="true"]')].filter(e=>visible(e)&&!excluded(e)&&!e.closest(assistant));
const editor=editors.length===1?editors[0]:null, form=editor?.closest('form');
const stops=form?[...form.querySelectorAll('button,[role="button"]')].filter(e=>visible(e)&&!excluded(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/^(stop|stop generating|stop generation|stop response|停止|停止生成|停止响应)$/i.test((e.getAttribute('aria-label')||e.title||e.textContent||'').trim())):[];
const turnId=root&&(root.getAttribute('data-message-id')||root.getAttribute('data-id'));
const generating=!!root&&!completed(root)&&(active(root)||thinking||[...root.querySelectorAll('[data-is-streaming="true"],[data-streaming="true"],[data-state="streaming"],[data-status="streaming"]')].some(e=>visible(e)&&!excluded(e)&&active(e)));
'''
READ_STATUS = '() => {' + DOM_HELPERS + r'''
return {url:location.href,turn_id:turnId||null,thinking_explicit:thinking,
 reasoning_panel_visible:reasoning.length>0,generating,stop_count:stops.length,
 composer_ready:!!editor&&!editor.disabled&&!editor.readOnly&&editor.getAttribute('aria-disabled')!=='true',
 state:thinking?'thinking_explicit':generating?'generating_unknown':reasoning.length?'reasoning_panel_present':'unknown'};
}'''
STOP_HANDLE = '() => {' + DOM_HELPERS + 'return stops.length===1?stops[0]:null;}'


@dataclass
class ThinkingWindow:
    required_seconds: float = 30.0
    min_samples: int = 3
    max_gap: float = 3.0
    evidence: list = field(default_factory=list)

    def observe(self, snapshot, now=None):
        now = time.monotonic() if now is None else now
        valid = (snapshot.get('turn_id') and snapshot.get('thinking_explicit')
                 and snapshot.get('stop_count') == 1)
        if not valid:
            self.evidence.clear()
            return False
        key = (snapshot['url'], snapshot['turn_id'])
        if self.evidence and (self.evidence[-1][1] != key or
                not 0 <= now-self.evidence[-1][0] <= self.max_gap):
            self.evidence.clear()
        self.evidence.append((now, key))
        # Keep one initial sample, plus recent samples; bounded memory.
        if len(self.evidence) > 200:
            self.evidence[1:-100] = []
        return (len(self.evidence) >= max(3, self.min_samples) and
                now-self.evidence[0][0] >= max(3.0, self.required_seconds))


async def inspect(page):
    try:
        return await page.evaluate(READ_STATUS)
    except Exception:
        return dict(state='unavailable', turn_id=None, thinking_explicit=False,
                    stop_count=0, generating=None, composer_ready=False)


async def attempt_stop(page, window, *, dry_run=True, verification_seconds=5):
    """Single irreversible click, only after repeated explicit UI evidence.

    UI idle is not proof of server cancellation. No tab closing or slot release.
    Caller must explicitly opt out of dry-run; the scheduler requires explicit opt-in.
    """
    before = await inspect(page)
    ready = window.observe(before)
    result = dict(status='observe_only', click_attempted=False, ui_idle=False,
                  server_cancelled='unknown', slot_released=False, evidence=before)
    if not ready:
        result['status'] = 'insufficient_evidence'
        return result
    if dry_run:
        result['status'] = 'would_request_stop'
        return result
    fresh = await inspect(page)
    if (fresh.get('url'), fresh.get('turn_id')) != (before['url'], before['turn_id']) or not window.observe(fresh):
        result['status'] = 'state_changed'
        return result
    try:
        handle = await page.evaluate_handle(STOP_HANDLE)
    except Exception:
        result['status'] = 'page_unavailable'
        return result
    try:
        button = handle.as_element()
        if button is None:
            result['status'] = 'ambiguous_stop'
            return result
        # Final semantic check on the same DOM snapshot as button selection.
        last = await inspect(page)
        if ((last.get('url'), last.get('turn_id')) != (before['url'], before['turn_id'])
                or not last.get('thinking_explicit') or last.get('stop_count') != 1):
            result['status'] = 'state_changed'
            return result
        result['click_attempted'] = True  # Even a timed-out click may have reached the page.
        try:
            await button.click(timeout=1500)  # Never force; never retry.
        except Exception:
            result['status'] = 'click_result_unknown'
            return result
    finally:
        await handle.dispose()
    deadline = time.monotonic()+verification_seconds
    idle_since = None
    while time.monotonic() < deadline:
        snap = await inspect(page)
        same = (snap.get('url'), snap.get('turn_id')) == (before['url'], before['turn_id'])
        idle = same and snap.get('generating') is False and snap.get('stop_count') == 0 and snap.get('composer_ready') is True
        if idle:
            if idle_since is None:
                idle_since = time.monotonic()
            elif time.monotonic()-idle_since >= 1:
                result.update(status='ui_idle_after_stop', ui_idle=True)
                return result
        else:
            idle_since = None
        await asyncio.sleep(.2)
    result['status'] = 'stop_not_verified'
    return result


class ArtifactParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags=[]; self.handlers=[]; self.css=[]; self.external=[]; self.in_style=False
    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        self.in_style = self.in_style or tag == 'style'
        for name,value in attrs:
            if name.startswith('on'): self.handlers.append(name)
            if name == 'style': self.css.append(value or '')
            if name in ('src','href','xlink:href') and value and not value.startswith('#'):
                self.external.append(value[:100])
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs); self.handle_endtag(tag)
    def handle_endtag(self, tag):
        if tag == 'style': self.in_style=False
    def handle_data(self, data):
        if self.in_style:self.css.append(data)


def inspect_artifact(source, kind):
    """Partial static scan of the actual artifact, NOT prose or a screenshot.
    Absence of findings is unknown, never a compliance certificate.
    """
    if kind not in ('pelican','stickman','recreate'): raise ValueError('unsupported task')
    p=ArtifactParser();p.feed(source)
    findings=[]
    css=re.sub(r'/\*.*?\*/','', '\n'.join(p.css), flags=re.S)
    css=re.sub(r'\\([0-9a-fA-F]{1,6})\s?',lambda m:chr(int(m[1],16)) if int(m[1],16)<=0x10ffff else '',css).lower()
    if kind=='recreate':
        for tag in ('svg','img','image','picture','canvas'):
            if tag in p.tags:findings.append('forbidden_element:'+tag)
        if re.search(r'url\s*\(|image-set\s*\(|@import',css):findings.append('css_image_or_external_resource')
    if kind in ('stickman','recreate') and ('script' in p.tags or p.handlers):
        findings.append('script_or_event_handler')
    animated=any(t in p.tags for t in ('animate','animatetransform','animatemotion')) or '@keyframes' in css
    if kind in ('pelican','stickman') and not animated:
        findings.append('no_declarative_animation_found')
    return dict(kind=kind, findings=findings, tags=len(p.tags), declarative_animation=animated,
                constraints='review_required' if findings else 'no_findings_not_verified',
                visual_quality='not_assessed', model_identity='unknown',
                automatic_discard=False, limitations='Partial static scan; does not prove visual correctness or full CSS compliance.')


async def render_offline(browser, source, *, svg=True, times=(0,1,2,4), output_dir):
    """Fresh isolated context; JavaScript off, no account profile, network denied.
    SVG is rendered as an image; HTML gets restrictive CSP. This is an offline
    renderer, not a claim that malicious input is safe on an unpatched browser.
    """
    from pathlib import Path
    output=Path(output_dir);output.mkdir(parents=True,exist_ok=True)
    context=await browser.new_context(viewport={'width':1000,'height':700},
        java_script_enabled=False, service_workers='block', accept_downloads=False)
    await context.route('**/*',lambda route:route.abort())
    page=await context.new_page()
    policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    prefix='<meta http-equiv="Content-Security-Policy" content="'+policy+'">'
    if svg:
        source='<style>body{margin:0;background:#fff}img{display:block;width:1000px;height:700px;object-fit:contain}</style><img src="data:image/svg+xml;base64,'+base64.b64encode(source.encode()).decode()+'">'
    paths=[]
    try:
        await page.set_content(prefix+source,wait_until='load',timeout=10000)
        started=time.monotonic()
        for i,stamp in enumerate(times):
            await asyncio.sleep(max(0,started+stamp-time.monotonic()))
            path=output/f'frame-{i}.png';await page.screenshot(path=str(path),timeout=10000)
            paths.append(str(path))
    finally:
        await context.close()
    return paths


def frame_measurements(paths):
    from PIL import Image, ImageChops, ImageStat
    frames=[Image.open(p).convert('RGB').resize((200,140)) for p in paths]
    deltas=[round(sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/(3*255),5)
            for a,b in zip(frames,frames[1:])]
    return dict(frame_differences=deltas, visible_change=any(d>.002 for d in deltas),
                quality='unknown',identity='unknown',note='Motion/colour differences do not establish anatomy, combat causality, or model identity.')

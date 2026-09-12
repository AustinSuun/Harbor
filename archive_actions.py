"""Conservative, opt-in UI archive adapter. Selectors still need real-site calibration.
No deletion of local artifacts; no retries of an uncertain archive click.
"""
import asyncio
import json
import re
from urllib.parse import urlparse


def archive_reason(job, kind):
    if job.get('thinking_stopped') is True:
        return 'thinking_stopped'
    metric=job.get('html_candidate') or {}
    if (kind in ('pelican','pelican_quick') and job.get('status')=='success'
            and job.get('html_capture')=='saved' and isinstance(metric.get('raw_lines'),int)
            and metric['raw_lines']>150):
        return 'html_over_150'
    return None


def conversation(url):
    p=urlparse(url)
    return (p.scheme=='https' and p.netloc=='arena.ai'
            and bool(re.fullmatch(r'/agent/[0-9a-f-]{36}/?',p.path)))


IDLE=r'''() => {
const visible=e=>!!e&&e.isConnected&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
const excluded=e=>!!e.closest('pre,code,blockquote,[data-message-role="user"],[data-message-role="assistant"],[data-message-author-role],[data-role="assistant"],[data-role="user"],[data-testid*="preview"],.preview');
const stops=[...document.querySelectorAll('form button,form [role="button"]')].filter(e=>visible(e)&&/^(stop|stop generating|stop generation|stop response|停止|停止生成|停止响应)$/i.test((e.getAttribute('aria-label')||e.title||e.textContent||'').trim()));
const stream=[...document.querySelectorAll('[data-state="streaming"],[data-is-streaming="true"],[data-streaming="true"]')].some(visible);
const editors=[...document.querySelectorAll('textarea,[contenteditable="true"][data-lexical-editor],[role="textbox"][contenteditable="true"]')].filter(e=>visible(e)&&!excluded(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.readOnly);
return !stream&&stops.length===0&&editors.length===1;
}'''


async def archive_conversation(page, expected_url, *, reason, dry_run=True, timeout=5):
    result=dict(status='not_attempted',reason=reason,archive_click_attempted=False,
                local_results_deleted=False,server_archived='unknown')
    async def bound_idle():
        return page.url==expected_url and await page.evaluate(IDLE)
    try:
        if not conversation(expected_url) or not await bound_idle():
            return dict(result,status='unsafe_or_generating')
        menu_button=page.locator('main header').get_by_role('button',name=re.compile(r'^(Conversation options|Chat options|对话选项|对话菜单)$',re.I))
        if await menu_button.count()!=1 or not await menu_button.is_visible():
            return dict(result,status='unsupported_menu')
        if await menu_button.evaluate("e=>!!e.closest('[data-message-role],[data-message-author-role],[data-role],pre,code,.preview')"):
            return dict(result,status='unsafe_menu')
        menu_id=await menu_button.get_attribute('aria-controls')
        if not menu_id:return dict(result,status='unbound_menu')
        if dry_run:return dict(result,status='would_open_menu')
        if not await bound_idle():return dict(result,status='state_changed')
        await menu_button.click(timeout=1500)
        menu=page.locator('[id='+json.dumps(menu_id)+']')
        await menu.wait_for(state='visible',timeout=1500)
        if await menu.count()!=1 or await menu.get_attribute('role')!='menu':return dict(result,status='unsupported_menu')
        item=menu.get_by_role('menuitem',name=re.compile(r'^(Archive|Archive chat|Archive conversation|归档|归档对话)$',re.I))
        if await item.count()!=1 or not await item.is_visible():return dict(result,status='ambiguous_archive')
        if not await bound_idle():return dict(result,status='state_changed')
        result['archive_click_attempted']=True
        await item.click(timeout=1500)
        # A click alone is never success. Require both a site toast and leaving this conversation.
        deadline=asyncio.get_running_loop().time()+timeout
        while asyncio.get_running_loop().time()<deadline:
            toast=await page.evaluate(r'''() => [...document.querySelectorAll('[role="status"],[role="alert"]')].some(e=>!e.closest('[data-message-role],[data-message-author-role],[data-role],pre,code,.preview')&&e.getBoundingClientRect().height>0&&/^(conversation archived|chat archived|对话已归档|已归档对话)[.!。]?$/i.test((e.textContent||'').trim()))''')
            p=urlparse(page.url)
            if toast and p.scheme=='https' and p.netloc=='arena.ai' and p.path.rstrip('/')=='/agent':
                return dict(result,status='archive_ui_confirmed')
            await asyncio.sleep(.2)
        return dict(result,status='archive_not_verified')
    except asyncio.CancelledError:
        raise
    except Exception:
        return dict(result,status='archive_not_verified' if result['archive_click_attempted'] else 'adapter_unavailable')

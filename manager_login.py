"""Conservative Arena password login, no snapshots, no credential-bearing errors."""
import asyncio
import re
from urllib.parse import urlparse

URL = 'https://arena.ai/agent'
DETECTOR_VERSION = 'avatar-email-casefold-v3'


def trusted(page):
    p = urlparse(page.url)
    return p.scheme == 'https' and p.netloc == 'arena.ai'


async def first_visible(page, selectors, timeout=12):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if not trusted(page):
            raise RuntimeError('登录页面不在受信任的 Arena 域名，已停止填写。')
        for selector in selectors:
            for locator in await page.locator(selector).all():
                if await locator.is_visible():
                    return locator
        await asyncio.sleep(.4)
    raise RuntimeError('未找到登录控件；请在浏览器中完成验证或登录。')


async def visible_now(page, selectors):
    if not trusted(page):
        raise RuntimeError('登录页面不在受信任的 Arena 域名，已停止操作。')
    for selector in selectors:
        for locator in await page.locator(selector).all():
            if await locator.is_visible():
                return locator
    return None


async def open_login_dialog(page, email_selectors):
    """Allow hydration, reveal a collapsed sidebar, then open the login form."""
    entries = ['button:has-text("Log In")', 'button:has-text("Sign in")',
               'button:has-text("登录")', 'a:has-text("Log In")',
               'a:has-text("Sign in")']
    expand = ['button[aria-label="Expand sidebar" i]',
              'button[aria-label="Open sidebar" i]',
              'button[aria-label="展开侧边栏"]',
              'button[aria-label="打开侧边栏"]',
              'button[data-sidebar="trigger"][aria-expanded="false"]']
    toggles = ['button[aria-label="Toggle Sidebar" i]',
               'button[aria-label="切换侧边栏"]',
               'button[data-sidebar="trigger"]',
               'button[data-slot="sidebar-trigger"]']
    began = asyncio.get_running_loop().time()
    expanded_once = False
    while asyncio.get_running_loop().time() - began < 25:
        if await visible_now(page, email_selectors) is not None:
            return
        entry = await visible_now(page, entries)
        if entry is not None:
            await entry.click(timeout=6000)
            await first_visible(page, email_selectors, timeout=12)
            return
        # Wait for hydration before touching layout; never repeatedly toggle it.
        if not expanded_once and asyncio.get_running_loop().time() - began >= 3:
            control = await visible_now(page, expand)
            if control is None:
                control = await visible_now(page, toggles)
                if control is not None:
                    state = await control.get_attribute('aria-expanded')
                    expanded = await visible_now(page, [
                        '[data-sidebar="sidebar"][data-state="expanded"]',
                        '[data-slot="sidebar"][data-state="expanded"]'])
                    if state == 'true' or expanded is not None:
                        control = None
            if control is not None:
                expanded_once = True
                await control.click(timeout=6000)
        await asyncio.sleep(.4)
    raise RuntimeError('展开侧边栏后仍未找到登录入口，请检查页面或验证码。')


# Only structural flags leave the browser; never return session tokens or page text.
DOM_AUTH = r'''email => {
 const normalizeEmailText=value=>String(value||'').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g,'').trim().toLowerCase();
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
 const excluded=e=>!!e.closest('pre,code,article,[data-role="assistant"],[data-role="user"],[data-message-author-role],textarea,[contenteditable="true"]');
 const controls=[...document.querySelectorAll('button,a,[role="menuitem"]')].filter(e=>visible(e)&&!excluded(e));
 const label=e=>(e.getAttribute('aria-label')||e.textContent||'').trim();
 const login=controls.some(e=>/^(log\s*in|sign\s*in|登录|登入)$/i.test(label(e)));
 const password=[...document.querySelectorAll('input[type="password"]')].some(visible);
 const emailForm=[...document.querySelectorAll('[role="dialog"] input[type="email"],form input[name="email"]')].some(visible);
 const code=[...document.querySelectorAll('input[autocomplete="one-time-code"],input[name="code"]')].some(visible);
 const challenge=[...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')].some(visible);
 const composer=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].some(e=>visible(e)&&!e.closest('[role="dialog"]')&&!e.disabled&&!e.readOnly);
 const logout=controls.some(e=>/^(log\s*out|sign\s*out|退出登录|登出)$/i.test(label(e)));
 const account=controls.some(e=>/^(account menu|user menu|open user menu|profile menu|my account|账户菜单|账号菜单|个人菜单)$/i.test(label(e)));
 const scopes=[...document.querySelectorAll('[data-sidebar="footer"],[data-slot="sidebar-footer"],[role="menu"],[data-testid="account-menu"],[data-testid="user-menu"]')].filter(visible);
 const addresses=new Set(scopes.flatMap(e=>normalizeEmailText(e.innerText).match(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(normalizeEmailText));
 const match=addresses.has(normalizeEmailText(email));
 // The screenshot uses an avatar + email account tile, not necessarily a labelled menu.
 // Prefer full DOM/tooltip text: CSS ellipsis often clips visually but keeps the full email.
 const expected=normalizeEmailText(email), local=expected.split('@')[0];
 let tileFull=false,tilePartial=false,tileMismatch=false;
 const texts=e=>[e.textContent,e.getAttribute('title'),e.getAttribute('aria-label'),e.getAttribute('data-email')].filter(Boolean).map(normalizeEmailText);
 const emailPattern=/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
 for(const e of document.querySelectorAll('button,a,[role="button"],span,p,div,[title],[aria-label]')){
   if(!visible(e)||excluded(e)||e.closest('[role="dialog"],main article'))continue;
   const values=texts(e).filter(x=>x.length<=254&&x.includes('@'));
   if(!values.length)continue;
   let tile=null;
   for(let p=e,level=0;p&&level<4;p=p.parentElement,level++){
     const r=p.getBoundingClientRect();
     const sidebar=p.closest('aside,nav,[role="complementary"],[data-sidebar],[data-slot="sidebar"],[class*="sidebar" i]');
     const footerLike=r.left<Math.min(400,innerWidth*.4)&&r.top>innerHeight*.35;
     if(r.width<70||r.width>480||r.height<24||r.height>150||(!sidebar&&!footerLike)||excluded(p))continue;
     const avatar=[...p.querySelectorAll('img,svg,[role="img"],[data-slot="avatar"],[class*="avatar" i]')].some(a=>{
       const ar=a.getBoundingClientRect();return visible(a)&&ar.width>=16&&ar.width<=80&&ar.height>=16&&ar.height<=80;
     });
     if(avatar){tile=p;break;}
   }
   if(!tile)continue;
   const all=[...values,...texts(tile).filter(x=>x.length<=254)];
   let full=false,partial=false,mismatch=false;
   for(const text of all){
     const addresses=(text.match(emailPattern)||[]).map(x=>x.replace(/[.]+$/,''));
     const clip=text.match(/([^\s<>]+@[^\s<>]*?)(?:\.{3}|…)/);
     if(!clip&&addresses.includes(expected))full=true;
     if(clip){
       const prefix=clip[1];
       if(prefix.startsWith(local+'@')&&prefix.length>=local.length+4&&local.length>=3&&expected.startsWith(prefix))partial=true;
     }else if(addresses.length&&!addresses.includes(expected))mismatch=true;
   }
   tileFull ||= full;
   tilePartial ||= partial;
   tileMismatch ||= mismatch&&!full&&!partial;
 }
 return {login,password,emailForm,code,challenge,composer,logout,account,emailMatch:match,emailMismatch:addresses.size>0&&!match,tileFull,tilePartial,tileMismatch:tileMismatch&&!tileFull&&!tilePartial};
}'''


async def probe(page, email, interact=False):
    result = {'status': 'unknown', 'reason': '页面尚未提供足够登录证据', 'ready': False, 'method': 'none', 'detector_version': DETECTOR_VERSION}
    if not trusted(page):
        return dict(result, reason='当前标签不是受信任的 Arena 页面')
    try:
        if interact:
            expand = await visible_now(page, ['button[aria-label="Expand sidebar" i]',
                'button[aria-label="Open sidebar" i]', 'button[aria-label="展开侧边栏"]',
                'button[data-sidebar="trigger"][aria-expanded="false"]',
                'button[aria-label="Toggle Sidebar" i][aria-expanded="false"]'])
            if expand is not None:
                await expand.click(timeout=3000)
                await asyncio.sleep(.5)
        dom = await page.evaluate(DOM_AUTH, email)
        result['signals'] = {key: bool(dom.get(key)) for key in ('tileFull','tilePartial','tileMismatch','emailMatch','emailMismatch','login','password','emailForm','code','challenge','composer')}
        result['ready'] = dom['composer'] and not (dom['password'] or dom['emailForm'] or dom['code'] or dom['challenge'])
        if dom['password'] or dom['emailForm'] or dom['code']:
            return dict(result, status='logged_out', reason='登录表单或验证码仍在显示', ready=False)
        if dom['challenge']:
            return dict(result, status='blocked', reason='页面仍在显示安全验证，请先在浏览器处理', ready=False)
        # This endpoint is optional evidence, not the sole gate. Never return its raw body.
        session = await page.evaluate(r'''async email => {
          const normalizeEmailText=value=>String(value||'').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g,'').trim().toLowerCase();
          const c=new AbortController(),t=setTimeout(()=>c.abort(),2500);
          try {
            const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:c.signal});
            if(!r.ok)return 'unavailable';
            const data=await r.json();
            if(typeof data?.user?.email!=='string')return 'unavailable';
            return normalizeEmailText(data.user.email)===normalizeEmailText(email)?'match':'mismatch';
          }catch{return 'unavailable';}finally{clearTimeout(t);}
        }''', email)
        result['session_evidence'] = session
        if session == 'mismatch':
            return dict(result, status='mismatch', reason='会话接口返回了不同账号；比较已忽略大小写 [case-v3/session]', method='session_mismatch', ready=False)
        if dom['tileMismatch']:
            return dict(result, status='mismatch', reason='头像账号区提取到不同邮箱；比较已忽略大小写 [case-v3/tile]', method='account_tile_mismatch', ready=False)
        if dom['emailMismatch'] and (dom['logout'] or dom['account']) and not (dom['tileFull'] or dom['tilePartial']):
            return dict(result, status='mismatch', reason='账号菜单提取到不同邮箱；比较已忽略大小写 [case-v3/menu]', method='account_menu_mismatch', ready=False)
        if session == 'match' and not dom['login']:
            return dict(result, status='authenticated', reason='会话接口已确认账号', method='session')
        if dom['login']:
            return dict(result, status='logged_out', reason='页面仍显示登录入口，请完成登录', ready=False)
        if dom['tileFull']:
            return dict(result, status='authenticated', reason='侧边栏头像与完整邮箱匹配', method='account_tile', identity_verified=True)
        if dom['tilePartial'] and dom['composer']:
            return dict(result, status='authenticated', reason='头像与截断邮箱前缀匹配，已识别登录态；完整邮箱未核验', method='account_tile_partial', identity_verified=False)
        # Inspect only a clearly labelled account menu, never generic avatar/icon guesses.
        if interact and not dom['emailMatch']:
            menu = await visible_now(page, ['button[aria-label="Account menu" i]',
                'button[aria-label="User menu" i]', 'button[aria-label="Open user menu" i]',
                'button[aria-label="Profile menu" i]', 'button[aria-label="账号菜单"]'])
            if menu is not None and await menu.get_attribute('aria-expanded') != 'true':
                await menu.click(timeout=3000)
                try:
                    await asyncio.sleep(.3)
                    dom = await page.evaluate(DOM_AUTH, email)
                finally:
                    # Only dismiss a menu opened here. Do not click any menu action.
                    await page.keyboard.press('Escape')
        if dom['emailMismatch'] and (dom['logout'] or dom['account']):
            return dict(result, status='mismatch', reason='账号菜单展开后提取到不同邮箱；比较已忽略大小写 [case-v3/menu-open]', method='account_menu_mismatch', ready=False)
        if dom['emailMatch'] and (dom['logout'] or dom['account']) and not dom['login']:
            return dict(result, status='authenticated', reason='账号菜单已确认邮箱及登录态', method='account_menu')
        return dict(result, reason='接口未提供身份信息，页面也未显示可核对的账号邮箱；这不等于未登录', method='inconclusive')
    except Exception:
        return dict(result, reason='页面正在跳转或读取失败，请稍候再检查', ready=False)


async def confirmed(page, email):
    return (await probe(page, email, interact=True))['status'] == 'authenticated'

async def login(page, email, password):
    await page.goto(URL, wait_until='domcontentloaded', timeout=45000)
    # Only match login controls; never auto-register, consent, or solve challenges.
    email_selectors = ['[role="dialog"] input[type="email"]', 'input[name="email"]']
    await open_login_dialog(page, email_selectors)
    field = await first_visible(page, email_selectors)
    if not trusted(page):
        raise RuntimeError('登录地址变化，已停止填写。')
    await field.fill(email, timeout=6000)
    button = await first_visible(page, ['button:has-text("Continue with email")',
        '[role="dialog"] button:has-text("继续")'])
    await button.click(timeout=6000)
    field = await first_visible(page, ['input[type="password"]'], timeout=15)
    if not trusted(page):
        raise RuntimeError('登录地址变化，已停止填写。')
    await field.fill(password, timeout=6000)
    # Scope to the password form/dialog to avoid clicking another login entry.
    scope = field.locator('xpath=ancestor::*[self::form or @role="dialog"][1]')
    submit = scope.locator('button[type="submit"]')
    if await submit.count() == 1 and await submit.is_visible():
        await submit.click(timeout=6000)
    else:
        button = scope.get_by_role('button', name=re.compile(r'^(Log In|Sign in|Continue|登录|继续)$', re.I))
        if await button.count() != 1:
            raise RuntimeError('无法唯一确定登录按钮，请手动完成登录。')
        await button.click(timeout=6000)
    for _ in range(10):
        if await confirmed(page, email):
            return True
        await asyncio.sleep(1)
    return False

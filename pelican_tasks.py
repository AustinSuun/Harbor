"""Per-environment, bounded Arena submission tasks; no extension dependency."""
from __future__ import annotations
import asyncio
import time
import uuid
from typing import Literal
from task_history import History
from reply_capture import READ_OUTPUT
from datetime import datetime, timezone
from pydantic import BaseModel, Field
from fastapi import HTTPException

PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'
REFERENCE_IMAGE_URL = 'https://cdn.jsdelivr.net/gh/AustinSuun/image/img/20260911135653908.png'
RECREATE_PROMPT = REFERENCE_IMAGE_URL + '\n\n用纯 HTML + CSS 复刻这张图，不许用图片，不许用 SVG。'
STICKMAN_PROMPT = '请使用纯 SVG 和原生 SMIL 动画（或纯 CSS），制作一个"火柴人大战"的完整 2D 动态页面。'
QUICK_PELICAN_PROMPT = '这是一个编码能力测试，不是分析或规划测试。本题不允许思考、分析、规划或讨论方案，请看到需求后立即开始创建文件、编写代码。\n\n任务：创建一个 HTML，内容是用 SVG 绘制“鹈鹕骑自行车”的 2D 动画。\n\n执行要求：\n\n1. 第一项操作立即调用 functions.write_file，在 /home/user/index.html 中直接写入完整 HTML 代码，不要先输出任何文字。\n2. 不要检查目录、读取文件、搜索、安装依赖、执行命令、测试、截图或验证。\n3. 不要询问问题，所有细节自行决定，直接编码。\n4. HTML、CSS、SVG 和 JavaScript 全部内联，不使用外部资源。鹈鹕须有明显的长嘴与喉囊，动画包含车轮旋转和双腿踩踏。\n5. 写入完成后立即调用 functions.present_file 打开 /home/user/index.html，然后结束，不追加解释。\n\n注意：这是编码能力测试，不允许先进入 Thinking 或输出思考过程。现在立即调用文件写入工具，开始编码。'
TASK_PROMPTS = {'pelican_quick': QUICK_PELICAN_PROMPT, 'pelican': PROMPT, 'recreate': RECREATE_PROMPT, 'stickman': STICKMAN_PROMPT}
URL = 'https://arena.ai/agent'
USER = '[data-message-role="user"], [data-message-author-role="user"], [data-role="user"]'
ACTIVE = {'running', 'stopping'}


class TaskSettings(BaseModel):
    kind: Literal["pelican","recreate","stickman","pelican_quick"] = "pelican"
    capture_screenshot: bool = True
    total: int = Field(default=5, ge=1, le=50)
    interval: float = Field(default=15, ge=3, le=3600, allow_inf_nan=False)
    concurrency: int = Field(default=1, ge=1, le=3)
    activate_fallback: bool = True
    confirmed: bool = False


# Do not use broad icon scoring: an uncertain send target must fail closed.
FIND_INPUT = r'''() => {
 const visible = e => {const r=e.getBoundingClientRect();return r.width>40&&r.height>10&&getComputedStyle(e).visibility!=='hidden';};
 const excluded = e => !!e.closest('[role="dialog"], #arena-runner-float, #arena-debug-panel, [id*="cookie"], [class*="cookie"], [class*="consent"]');
 const choices=[...document.querySelectorAll('textarea, [contenteditable="true"][data-lexical-editor], .ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]')]
 .filter(e=>visible(e)&&!excluded(e)&&!e.disabled&&!e.readOnly&&e.getAttribute('aria-disabled')!=='true');
 choices.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom);
 return choices[0]||null;
}'''
FIND_SEND = r'''input => {
 if(!input || !input.isConnected) return null;
 const ir=input.getBoundingClientRect(),form=input.closest('form');
 const candidates=[...document.querySelectorAll('button, [role="button"]')].filter(b=>{
  const r=b.getBoundingClientRect();
  if(r.width<10||r.height<10||b.disabled||b.getAttribute('aria-disabled')==='true'||getComputedStyle(b).visibility==='hidden')return false;
  if(b.closest('[role="dialog"],#arena-runner-float,[id*="cookie"],[class*="cookie"],[class*="consent"]'))return false;
  const label=[b.textContent,b.getAttribute('aria-label'),b.title,b.getAttribute('data-testid')].filter(Boolean).join(' ').toLowerCase();
  if(/attach|upload|file|stop|cancel|new.chat|regenerate|归档|上传|停止|取消|新对话/.test(label))return false;
  const sameForm=!!form&&b.closest('form')===form;
  const near=Math.abs(r.bottom-ir.bottom)<180&&r.right>=ir.left&&r.left<=ir.right+100;
  return (sameForm||near)&&(/\bsend\b|\bsubmit\b|发送|提交/.test(label)||(sameForm&&b.getAttribute('type')==='submit'));
 });
 return candidates.length===1?candidates[0]:null;
}'''
CHECK_SUBMITTED = r'''({prompt,selector,baseline}) => {
 const normalize=s=>(s||'').replace(/[\u200b\ufeff]/g,'').replace(/\s+/g,' ').trim();
 const expected=normalize(prompt);
 const messages=[...document.querySelectorAll(selector)];
 if(messages.length>baseline && messages.slice(baseline).some(e=>
   [e.innerText,e.textContent].some(text=>normalize(text).includes(expected)))) return 'user-message';
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
 const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
 const cleared=editors.length>0&&editors.every(e=>!(e.value||e.textContent||'').trim());
 const generating=[...document.querySelectorAll('button,[role="button"]')].some(b=>visible(b)&&/^(stop|stop generating|stop generation|停止|停止生成)$/i.test((b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()));
 return cleared&&generating?'generating':null;
}'''


# Completion must be scoped to assistant output, not the whole page/preview.
READ_REPLY = r'''() => {
 const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
 const user='[data-message-role="user"],[data-message-author-role="user"],[data-role="user"]';
 let roots=[];
 for(const selector of ['[data-message-role="assistant"],[data-message-author-role="assistant"],[data-role="assistant"]','[data-testid="assistant-message"],[data-testid="assistant-turn"]']){
  const els=[...document.querySelectorAll(selector)].filter(e=>!e.closest(user+',textarea,[contenteditable="true"],#arena-runner-float'));
  roots=els.filter(e=>!els.some(o=>o!==e&&o.contains(e)));
  if(roots.length)break;
 }
 const last=roots.at(-1);
 const stream='[data-is-streaming="true"],[data-streaming="true"],[data-state="streaming"],[aria-busy="true"]';
 const stop=[...document.querySelectorAll('button,[role="button"]')].some(b=>visible(b)&&/^(stop|stop generating|stop generation|stop response|停止|停止生成|停止响应)$/i.test((b.getAttribute('aria-label')||b.title||b.textContent||'').trim()));
 const generating=stop||!!(last&&(last.matches(stream)||[...last.querySelectorAll(stream)].some(visible)));
 const explicitDone=!!last&&last.matches('[data-state="completed"],[data-state="complete"],[data-status="completed"],[data-status="complete"]');
 const editorReady=[...document.querySelectorAll('textarea,[contenteditable="true"][data-lexical-editor],.ProseMirror[contenteditable="true"]')].some(e=>visible(e)&&!e.disabled&&!e.readOnly&&e.getAttribute('aria-disabled')!=='true');
 return {key:last?(last.getAttribute('data-message-id')||last.getAttribute('data-id')||last.id||''):'',count:roots.length,text:last?(last.innerText||last.textContent||''):'',generating,explicitDone,editorReady};
}'''




def normalize_composer_text(text):
    """Compare content, ignoring editor-only whitespace/paragraph formatting."""
    import re
    return re.sub(r'\s+', ' ', str(text or '').replace('\u200b','').replace('\ufeff','')).strip()


READ_COMPOSER = r'''e => {
 const block=new Set(['P','DIV','SECTION','LI','UL','OL','PRE']);
 function walk(n){
  if(n.nodeType===Node.TEXT_NODE)return n.nodeValue||'';
  if(n.nodeType!==Node.ELEMENT_NODE)return '';
  if(n.tagName==='BR')return '\n';
  if(['SCRIPT','STYLE','BUTTON'].includes(n.tagName))return '';
  const text=[...n.childNodes].map(walk).join('');
  return block.has(n.tagName)?'\n'+text+'\n':text;
 }
 if(e.tagName==='TEXTAREA'||e.tagName==='INPUT')return {value:e.value||''};
 return {rendered:e.innerText||'',structured:walk(e),plain:e.textContent||''};
}'''


class PelicanTasks:
    def __init__(self, manager):
        self.manager = manager
        self.history = History(manager)
        self.runs = {}
        self.control = asyncio.Lock()
        self.interaction = asyncio.Lock()  # Foreground/focus operations never compete.
        self.last_send = {}

    def initialize(self):
        self.history.initialize()
        with self.manager.db:
            self.manager.db.execute('CREATE TABLE IF NOT EXISTS pelican_settings (environment_id TEXT PRIMARY KEY, settings TEXT NOT NULL)')

    def saved(self, eid):
        import json
        row = self.manager.db.execute('SELECT settings FROM pelican_settings WHERE environment_id=?', (eid,)).fetchone()
        config=json.loads(row[0]) if row else TaskSettings().model_dump(exclude={'confirmed'})
        if config.get('kind') not in TASK_PROMPTS:
            config['kind']='pelican'  # Retired task settings must not break the selector.
        config.pop('stop_on_thinking',None)
        return config

    def snapshot(self, eid):
        run = self.runs.get(eid)
        if not run:
            return {'status': 'idle', 'settings': self.saved(eid), 'jobs': [], 'success': 0, 'failed': 0, 'unknown': 0, 'active': 0, 'submitted': 0, 'untracked': 0, 'finished': 0}
        jobs = run['jobs']
        return {'id': run['id'], 'status': run['status'], 'settings': run['settings'],
                'started_at': run['started_at'], 'finished_at': run.get('finished_at'),
                'jobs': [{k:v for k,v in j.items() if k not in ('turns','raw_text','events','analysis') and not k.startswith('_')} for j in jobs], 'success': sum(j['status']=='success' for j in jobs),
                'failed': sum(j['status'] in ('failed',) for j in jobs),
                'finished': sum(j['status']=='success' or bool(j.get('page_closed')) for j in jobs),
                'submitted': sum(bool(j.get('submitted')) for j in jobs),
                'untracked': sum(j['status']=='untracked' for j in jobs),
                'unknown': sum(j['status']=='unknown' for j in jobs),
                'active': sum(j['status'] in ('opening','waiting','typing','sending','confirming','generating','attention') for j in jobs)}

    async def start(self, eid, settings):
        import json
        async with self.control:
            context = self.manager.require_context(eid)
            if not settings.confirmed:
                raise HTTPException(400, '请确认已登录、有权使用该账号，并授权发送本轮试题')
            old = self.runs.get(eid)
            if old and old['status'] in ACTIVE:
                raise HTTPException(409, '该环境已有任务在运行，请先停止')
            if old and any(j['status']=='unknown' for j in old['jobs']):
                # The UI confirmation explicitly warns about prior uncertain sends.
                self.manager.log(eid, '用户确认开始新一轮；上一轮不确定发送不自动重试')
            config = settings.model_dump(exclude={'confirmed'})
            prompts=[[{'prompt':TASK_PROMPTS[settings.kind]}] for _ in range(settings.total)]
            with self.manager.db:
                self.manager.db.execute('INSERT OR REPLACE INTO pelican_settings VALUES (?,?)', (eid,json.dumps(config)))
            run = {'id': uuid.uuid4().hex, 'status':'running', 'settings':config,
                   'started_at':datetime.now(timezone.utc).isoformat(), 'stop':asyncio.Event(),
                   'environment_id':eid,'environment_name':self.manager.get(eid)['name'],
                   'jobs':[{'record_id':uuid.uuid4().hex,'number':i+1,'status':'pending','message':'等待执行','url':'','turns':[dict(t,status='pending',raw_text='') for t in prompts[i]]} for i in range(settings.total)],
                   'context':context, 'workers':[], 'next':0, 'opening_gate':asyncio.Lock(), 'last_open':0.0, 'open_not_before':0.0}
            self.history.save_run(run)
            self.runs[eid] = run
            run['task'] = asyncio.create_task(self.execute(eid,run))
            self.manager.log(eid, f'开始 {settings.kind} 任务：{settings.total} 项，最小间隔 {settings.interval} 秒，并发 {settings.concurrency}')
            return self.snapshot(eid)

    async def stop(self, eid):
        async with self.control:
            run = self.runs.get(eid)
            if not run or run['status'] not in ACTIVE:
                return
            run['status']='stopping'
            run['stop'].set()
            for worker in run['workers']:
                worker.cancel()
            await run['task']

    async def shutdown(self):
        for eid in list(self.runs):
            await self.stop(eid)

    def browser_closed(self, eid):
        run = self.runs.get(eid)
        if run and run['status'] in ACTIVE:
            run['stop'].set()
            for worker in run['workers']:
                worker.cancel()

    async def pause(self, run, seconds):
        if run['stop'].is_set():
            raise asyncio.CancelledError
        try:
            await asyncio.wait_for(run['stop'].wait(), timeout=max(0.001,seconds))
        except asyncio.TimeoutError:
            return
        raise asyncio.CancelledError

    def checkpoint(self, run):
        if run['stop'].is_set():
            raise asyncio.CancelledError

    async def persist_loop(self,run):
        while True:
            await asyncio.sleep(1)
            try:
                self.history.save_run(run)
            except Exception as exc:
                run['stop'].set()
                for worker in run['workers']: worker.cancel()
                self.manager.log(run['environment_id'],'记录写入失败，已停止任务：'+str(exc)[:400])
                return

    async def execute(self, eid, run):
        monitor=asyncio.create_task(self.persist_loop(run))
        try:
            if not run['stop'].is_set():
                run['workers']=[asyncio.create_task(self.worker(eid,run)) for _ in range(run['settings']['concurrency'])]
                await asyncio.gather(*run['workers'], return_exceptions=True)
        finally:
            monitor.cancel()
            await asyncio.gather(monitor,return_exceptions=True)
            for job in run['jobs']:
                if job['status']=='pending':
                    job.update(status='cancelled',message='未执行，已停止')
            run['status']='stopped' if run['stop'].is_set() else 'completed'
            run['finished_at']=datetime.now(timezone.utc).isoformat()
            self.history.save_run(run)
            for job in run['jobs']: self.history.cache.pop(job['record_id'],None)
            self.manager.log(eid, '任务结束：' + run['status'] + '；已打开的标签页保留')

    async def wait_open_slot(self, run):
        # Recompute after every wait: another worker may close a page meanwhile.
        while True:
            self.checkpoint(run)
            deadline = max(run['last_open'] + run['settings']['interval'],
                           run.get('open_not_before', 0.0))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await self.pause(run, remaining)

    def can_refill_after_close(self, eid, run, page, page_closed):
        return (page is not None and (page_closed or page.is_closed())
                and not run['stop'].is_set()
                and self.manager.contexts.get(eid) is run['context']
                and any(not p.is_closed() for p in run['context'].pages))

    def record_page_closed(self, eid, run, job, attempted, submitted):
        # Keep captured output and the consumed job number; never resend this job.
        if job['status'] == 'success':
            return
        closed_at = time.monotonic()
        run['open_not_before'] = max(run.get('open_not_before', 0.0),
                                     closed_at + run['settings']['interval'])
        if attempted:
            self.last_send[eid] = closed_at
        status = 'untracked' if submitted else ('unknown' if attempted else 'cancelled')
        message = ('已发送但标签页已关闭，停止跟踪；' if submitted else
                   '发送结果不确定，标签页已关闭；' if attempted else '标签页已关闭，本题未发送；')
        message += '已释放名额，该题不重发，后续任务按间隔继续'
        job.update(status=status, page_closed=True,
                   closed_at=datetime.now(timezone.utc).isoformat(), message=message)
        if job.get('current_turn'):
            job['turns'][job['current_turn']-1]['status'] = status
        self.manager.log(eid, f'任务 #{job["number"]}：{message}')

    async def worker(self, eid, run):
        while not run['stop'].is_set() and run['next']<len(run['jobs']):
            job=run['jobs'][run['next']]
            run['next']+=1
            page=None
            page_closed=False
            close_handler=None
            close_cancel_requested=False
            owner=asyncio.current_task()
            attempted=False
            submitted=False
            try:
                async with run['opening_gate']:
                    job.update(status='waiting',message='等待开页间隔')
                    await self.wait_open_slot(run)
                    self.checkpoint(run)
                    page=await run['context'].new_page()
                    run['last_open']=time.monotonic()
                def close_handler(*_):
                    nonlocal page_closed, close_cancel_requested
                    if page_closed:
                        return
                    page_closed = True
                    if not run['stop'].is_set() and job['status'] != 'success':
                        run['open_not_before'] = max(run.get('open_not_before', 0.0),
                            time.monotonic() + run['settings']['interval'])
                    if not owner.done():
                        close_cancel_requested = True
                        owner.cancel()
                page.on('close', close_handler)
                if page.is_closed():
                    close_handler()
                job.update(status='opening',message='打开 Arena，等待页面加载')
                self.history.save_run(run)
                await page.goto(URL,wait_until='domcontentloaded',timeout=45000)
                job['url']=page.url
                for index,turn in enumerate(job['turns']):
                    attempted=False
                    submitted=False
                    prompt=turn['prompt']
                    job['current_turn']=index+1
                    async with self.interaction:
                        self.checkpoint(run)
                        job.update(status='waiting',message=f'第 {index+1} 题：等待输入框')
                        editor=await self.wait_editor(page,run)
                        job.update(status='typing',message=f'第 {index+1} 题：填写内容')
                        await editor.fill(prompt,timeout=10000)
                        editor=await self.verify_composer(page,editor,prompt,run,job)
                        job.update(status='waiting',message='等待最小发送间隔')
                        await self.pause(run,run['settings']['interval']-(time.monotonic()-self.last_send.get(eid,0)))
                        # The app may have re-rendered while waiting for the send interval.
                        editor=await self.verify_composer(page,editor,prompt,run,job)
                        button=await self.wait_button(page,editor,run)
                        baseline=await page.locator(USER).count()
                        reply_baseline=await page.evaluate(READ_REPLY)
                        turn['reply_baseline']={'count':reply_baseline['count'],'key':reply_baseline['key']}
                        turn.update(status='sending',message='准备点击发送一次')
                        job.update(status='sending',message=f'第 {index+1} 题：点击发送（仅一次）')
                        self.history.save_run(run)  # Durable checkpoint BEFORE an irreversible click.
                        self.checkpoint(run)
                        attempted=True
                        await button.click(timeout=10000)
                        self.last_send[eid]=time.monotonic()
                    job.update(status='confirming',message=f'第 {index+1} 题：确认提交，不重复点击')
                    evidence=await page.wait_for_function(CHECK_SUBMITTED,arg={'prompt':prompt,'selector':USER,'baseline':baseline},timeout=25000,polling=500)
                    submitted=True
                    turn.update(status='generating',submitted=True)
                    job.update(status='generating',submitted=True,message=f'第 {index+1} 题：已发送，等待回复',url=page.url)
                    seen_generating=(await evidence.json_value())=='generating'
                    await evidence.dispose()
                    self.history.save_run(run)
                    self.manager.log(eid,f'任务 #{job["number"]} 第 {index+1} 题已发送')
                    await self.wait_reply(page,run,job,reply_baseline,seen_generating)
                    turn['status']='completed'
                    turn['completed_at']=datetime.now(timezone.utc).isoformat()
                    self.history.save_run(run)
                    # Each task uses its own page/conversation.
                job.update(status='success',message='回复完成，已保存原文并释放名额',url=page.url)
                self.history.save_run(run)
                if run['settings']['capture_screenshot']:
                    await self.history.screenshot(run,job,page)
                self.manager.log(eid,f'任务 #{job["number"]}：{job["message"]}')
            except asyncio.CancelledError:
                if self.can_refill_after_close(eid, run, page, page_closed):
                    self.record_page_closed(eid, run, job, attempted, submitted)
                    # Python 3.11+ retains a cancellation count after it is caught.
                    if close_cancel_requested and hasattr(owner, 'uncancel'):
                        owner.uncancel()
                    continue
                if page_closed and not run['stop'].is_set():
                    # No live page/context remains: this is an environment shutdown.
                    run['stop'].set()
                    for other in run['workers']:
                        if other is not owner:
                            other.cancel()
                # Cancellation while saving a screenshot must not undo a finished result.
                if job['status']=='success':
                    return
                if attempted: self.last_send[eid]=time.monotonic()
                job.update(status='untracked' if submitted else ('unknown' if attempted else 'cancelled'),message='已发送；停止跟踪，网页可能仍在生成' if submitted else ('停止时可能已发送，不自动重试' if attempted else '已停止，当前题未点击发送'))
                if job.get('current_turn'):
                    job['turns'][job['current_turn']-1]['status']=job['status']
                return
            except Exception as exc:
                # Playwright's closed-page error can arrive before its close callback.
                if self.can_refill_after_close(eid, run, page, page_closed):
                    self.record_page_closed(eid, run, job, attempted, submitted)
                    if close_cancel_requested and hasattr(owner, 'uncancel'):
                        owner.uncancel()
                    continue
                if attempted: self.last_send[eid]=time.monotonic()
                message=('已发送，无法确认完成；' if submitted else ('发送不确定，不重试；' if attempted else '未确认发送；'))+str(exc)[:600]
                job.update(status='untracked' if submitted else ('unknown' if attempted else 'failed'),message=message)
                if job.get('current_turn'):
                    job['turns'][job['current_turn']-1]['status']=job['status']
                self.manager.log(eid,f'任务 #{job["number"]}：{message}')
                run['stop'].set()
                for other in run['workers']:
                    if other is not asyncio.current_task(): other.cancel()
                if run['settings']['capture_screenshot']:
                    await self.history.screenshot(run,job,page)
                return
            finally:
                # Completed/old tabs must never cancel a worker processing a new job.
                if page is not None and close_handler is not None:
                    page.remove_listener('close', close_handler)
                self.history.save_run(run)

    async def wait_reply(self, page, run, job, baseline, seen_generating):
        """Retain the worker's slot until a conservative completion observation.

        No idle-text-only completion, no timeout that frees a slot. If site
        signals are missing, hold the slot and ask for manual inspection.
        """
        began=time.monotonic()
        stable_since=None
        previous=None
        while True:
            self.checkpoint(run)
            state=await page.evaluate(READ_REPLY)
            turn=job['turns'][job['current_turn']-1]
            is_new_response=(state['count']>baseline['count'] or
                bool(state.get('key') and state['key']!=baseline.get('key')))
            if run['settings']['kind'] in TASK_PROMPTS:
                is_new_response=is_new_response or state['text']!=baseline['text']
            if is_new_response:
                captured=await page.evaluate(READ_OUTPUT)
                turn.update(raw_text=captured['text'],capture_source=captured['source'],truncated=captured['truncated'])
                job['url']=page.url
                self.history.save_job(run,job)
            seen_generating=seen_generating or state['generating']
            signature=(state['count'],state['text'])
            new_output=bool(state['text'].strip()) and is_new_response
            candidate=(new_output and not state['generating'] and state['editorReady']
                       and (seen_generating or state['explicitDone']))
            if not candidate or signature!=previous:
                stable_since=None
            if candidate:
                if stable_since is None:
                    stable_since=time.monotonic()
                if time.monotonic()-stable_since>=30:
                    return
            previous=signature
            if time.monotonic()-began>=900:
                job.update(status='attention',message='15 分钟未确认回复完成；可关闭此任务标签释放名额并继续后续任务，或停止本轮；本题不重发')
            elif candidate:
                job.update(status='generating',message='生成信号已结束，等待输出稳定 30 秒；仍占用名额')
            else:
                job.update(status='generating',message='已发送，等待回复完成；仍占用并发名额')
            await self.pause(run,1)

    async def wait_editor(self, page, run):
        started=time.monotonic()
        activated=False
        while time.monotonic()-started<40:
            self.checkpoint(run)
            handle=await page.evaluate_handle(FIND_INPUT)
            element=handle.as_element()
            if element:
                if await element.is_visible() and await element.is_editable():
                    return element
            await handle.dispose()
            if not activated and run['settings']['activate_fallback'] and time.monotonic()-started>=6:
                await page.bring_to_front()
                activated=True
            await self.pause(run,0.5)
        raise RuntimeError('40 秒内未找到可编辑输入框。请检查是否已登录、完成必要的人工验证，或站点结构已变化。')

    async def verify_composer(self, page, editor, prompt, run, job):
        expected=normalize_composer_text(prompt)
        deadline=time.monotonic()+6
        consecutive=0
        observed={}
        last_error=''
        while time.monotonic()<deadline:
            self.checkpoint(run)
            try:
                observed=await editor.evaluate(READ_COMPOSER)
                matched=[source for source,text in observed.items()
                         if normalize_composer_text(text)==expected]
                if matched:
                    consecutive+=1
                    if consecutive>=2:
                        job['turns'][job['current_turn']-1]['input_check']={
                            'ok':True,'source':matched[0],'normalization':'whitespace-and-paragraphs',
                            'expected_length':len(prompt),'observed_length':len(observed[matched[0]])}
                        return editor
                else:
                    consecutive=0
            except Exception as exc:
                consecutive=0
                last_error=str(exc)[:250]
                handle=await page.evaluate_handle(FIND_INPUT)
                replacement=handle.as_element()
                if replacement is not None:
                    editor=replacement
                else:
                    await handle.dispose()
            await self.pause(run,0.25)
        job['turns'][job['current_turn']-1]['input_check']={
            'ok':False,'expected_normalized':expected[:2000],
            'observed':{k:normalize_composer_text(v)[:2000] for k,v in observed.items()},
            'last_error':last_error}
        self.history.save_run(run)
        raise RuntimeError('输入内容校验仍未通过，未点击发送；已保存各读取方式的差异，见任务记录导出中的 input_check')

    async def wait_button(self, page, editor, run):
        for _ in range(20):
            self.checkpoint(run)
            handle=await page.evaluate_handle(FIND_SEND,editor)
            button=handle.as_element()
            if button:
                return button
            await handle.dispose()
            await self.pause(run,0.5)
        raise RuntimeError('无法唯一识别发送按钮，已停止，避免误点其他功能')

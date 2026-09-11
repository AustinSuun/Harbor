"""Standalone local browser environment manager. Run: python browser_manager.py"""
from __future__ import annotations
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys
import uuid
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from task_history import ReviewInput
from pydantic import BaseModel, Field, field_validator
from runtime_paths import RESOURCE_DIR, DATA_DIR, FROZEN, ensure_browser_resources
from playwright.async_api import async_playwright
from pelican_tasks import PelicanTasks, TaskSettings

BASE = RESOURCE_DIR
DATA = DATA_DIR
MAX_RUNNING = 6


def now():
    return datetime.now(timezone.utc).isoformat()


class EnvironmentInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    note: str = Field(default='', max_length=500)
    start_url: str = Field(default='https://arena.ai/agent', max_length=2048)

    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('名称不能为空')
        return value

    @field_validator('start_url')
    @classmethod
    def valid_url(cls, value):
        if value == 'about:blank':
            return value
        parsed = urlparse(value)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('启动地址仅支持 HTTP(S) 或 about:blank')
        return value


class Manager:
    def __init__(self):
        self.contexts = {}
        self.states = {}
        self.errors = {}
        self.logs = deque(maxlen=200)
        self.lock = asyncio.Lock()
        self.db = None
        self.pw = None
        self.guard = None

    def log(self, eid, message):
        self.logs.append({'time': now(), 'environment_id': eid, 'message': message})

    def acquire(self):
        DATA.mkdir(parents=True, exist_ok=True)
        self.guard = (DATA / 'manager.lock').open('a+b')
        self.guard.seek(0)
        self.guard.write(b'0')
        self.guard.flush()
        self.guard.seek(0)
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(self.guard.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.guard.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.guard.close()
            raise RuntimeError('此数据目录已有管理器运行，请勿使用多 worker 或重复启动。')
        self.db = sqlite3.connect(DATA / 'environments.sqlite3')
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL, start_url TEXT NOT NULL, extension_enabled INTEGER NOT NULL, created_at TEXT NOT NULL)')
        # Keep the old schema so existing profiles/history remain compatible.
        self.db.execute('UPDATE environments SET extension_enabled=0 WHERE extension_enabled<>0')
        self.db.commit()

    def get(self, eid):
        row = self.db.execute('SELECT * FROM environments WHERE id=?', (eid,)).fetchone()
        if row is None:
            raise HTTPException(404, '环境不存在')
        return dict(row)

    def snapshot(self):
        result = []
        for row in self.db.execute('SELECT * FROM environments ORDER BY created_at ASC, rowid ASC'):
            item = dict(row)
            eid = item['id']
            item.pop('extension_enabled',None)  # Legacy DB column is not a feature.
            item['task'] = pelican.snapshot(eid)
            item.update(status=self.states.get(eid, 'stopped'), error=self.errors.get(eid, ''), profile_path=str(DATA / 'profiles' / eid))
            result.append(item)
        return result

    def closed(self, eid, context):
        if self.contexts.get(eid) is context:
            self.contexts.pop(eid, None)
            pelican.browser_closed(eid)
            self.states[eid] = 'stopped'
            self.log(eid, '浏览器已关闭，登录数据保留')

    async def launch(self, eid):
        async with self.lock:
            item = self.get(eid)
            if eid in self.contexts:
                return
            if len(self.contexts) >= MAX_RUNNING:
                raise HTTPException(409, f'最多同时运行 {MAX_RUNNING} 个环境，请先关闭其他环境')
            self.states[eid] = 'starting'
            self.errors.pop(eid, None)
            context = None
            try:
                profile = DATA / 'profiles' / eid
                profile.mkdir(parents=True, exist_ok=True)
                context = await self.pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile), channel='chromium', headless=False,
                    no_viewport=True, args=['--disable-extensions'], timeout=45000,
                )
                self.contexts[eid] = context
                context.on('close', lambda *_: self.closed(eid, context))
                self.states[eid] = 'running'
                self.log(eid, '环境启动成功；插件加载已禁用')
                page = context.pages[0] if context.pages else await context.new_page()
                try:
                    await page.goto(item['start_url'], wait_until='domcontentloaded', timeout=20000)
                except Exception as exc:
                    self.errors[eid] = f'浏览器已打开，但导航失败：{exc}'[:1000]
                    self.log(eid, self.errors[eid])
            except Exception as exc:
                if context is not None:
                    await context.close()
                self.states[eid] = 'error'
                self.errors[eid] = str(exc)[:1000]
                self.log(eid, '启动失败：' + self.errors[eid])
                raise HTTPException(500, '启动失败，请确认浏览器资源完整、当前机器有桌面环境，且配置目录未被占用。源码模式可执行 python -m playwright install chromium。详情：' + str(exc)[:700])

    async def stop(self, eid):
        async with self.lock:
            self.get(eid)
            await pelican.stop(eid)
            context = self.contexts.get(eid)
            if context:
                self.states[eid] = 'stopping'
                try:
                    await context.close()
                except Exception as exc:
                    self.states[eid] = 'error'
                    self.errors[eid] = str(exc)[:1000]
                    raise HTTPException(500, '关闭失败：' + str(exc)[:500])
                self.contexts.pop(eid, None)
            pelican.browser_closed(eid)
            self.states[eid] = 'stopped'
            self.errors.pop(eid, None)

    def require_context(self, eid):
        """Future automation adapters must request one explicit environment."""
        self.get(eid)
        if eid not in self.contexts or self.states.get(eid) != 'running':
            raise HTTPException(409, '请先启动该环境')
        return self.contexts[eid]


manager = Manager()
pelican = PelicanTasks(manager)


@asynccontextmanager
async def lifespan(app):
    ensure_browser_resources()
    manager.acquire()
    try:
        pelican.initialize()
        manager.pw = await async_playwright().start()
        yield
    finally:
        await pelican.shutdown()
        for context in list(manager.contexts.values()):
            try:
                await context.close()
            except Exception:
                pass
        if manager.pw:
            await manager.pw.stop()
        if manager.db:
            manager.db.close()
        if manager.guard:
            manager.guard.close()


app = FastAPI(title='Harbor · 多浏览器环境管理', lifespan=lifespan)


@app.middleware('http')
async def local_only(request: Request, call_next):
    # Local management endpoints must not be exposed to arbitrary web origins.
    host = request.headers.get('host', '')
    allowed = {'127.0.0.1:8766', 'localhost:8766'}
    if host not in allowed:
        return JSONResponse({'detail': '仅允许本机访问'}, status_code=403)
    origin = request.headers.get('origin')
    if origin and origin not in {f'http://{h}' for h in allowed}:
        return JSONResponse({'detail': '拒绝跨站请求'}, status_code=403)
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.headers.get('x-manager-request') != '1':
        return JSONResponse({'detail': '缺少管理请求标识'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Frame-Options'] = 'DENY'
    return response


@app.get('/', response_class=HTMLResponse)
async def index():
    return (BASE / 'browser_manager.html').read_text(encoding='utf-8')


@app.get('/api/environments')
async def environments():
    return {'environments': manager.snapshot(), 'max_running': MAX_RUNNING,
            'browser_mode': '内置 Chromium' if FROZEN else 'Playwright Chromium（源码模式）'}


@app.post('/api/environments', status_code=201)
async def create(inp: EnvironmentInput):
    async with manager.lock:
        eid = uuid.uuid4().hex
        with manager.db:
            manager.db.execute('INSERT INTO environments (id, name, note, start_url, extension_enabled, created_at) VALUES (?,?,?,?,?,?)',
                               (eid, inp.name, inp.note, inp.start_url, 0, now()))
        manager.log(eid, '创建环境：' + inp.name)
        return {'id': eid}


@app.put('/api/environments/{eid}')
async def update(eid: str, inp: EnvironmentInput):
    async with manager.lock:
        manager.get(eid)
        if eid in manager.contexts:
            raise HTTPException(409, '请关闭环境后再编辑')
        with manager.db:
            manager.db.execute('UPDATE environments SET name=?,note=?,start_url=?,extension_enabled=? WHERE id=?',
                               (inp.name, inp.note, inp.start_url, 0, eid))
        return {'ok': True}


@app.delete('/api/environments/{eid}')
async def delete(eid: str):
    async with manager.lock:
        manager.get(eid)
        if eid in manager.contexts:
            raise HTTPException(409, '请先关闭环境')
        await pelican.stop(eid)
        # Archive profile data instead of silently destroying saved sessions.
        profile = DATA / 'profiles' / eid
        if profile.exists():
            archive = DATA / 'archive'
            archive.mkdir(exist_ok=True)
            profile.rename(archive / f'{eid}-{uuid.uuid4().hex[:8]}')
        with manager.db:
            manager.db.execute('DELETE FROM environments WHERE id=?', (eid,))
            manager.db.execute('DELETE FROM pelican_settings WHERE environment_id=?', (eid,))
        pelican.runs.pop(eid, None)
        pelican.last_send.pop(eid, None)
        manager.states.pop(eid, None)
        manager.errors.pop(eid, None)
        manager.log(eid, '移除环境；如有配置数据，已归档至 data/browser-manager/archive')
        return {'ok': True}


@app.post('/api/environments/{eid}/start')
async def start(eid: str):
    await manager.launch(eid)
    return {'ok': True}


@app.post('/api/environments/{eid}/stop')
async def stop(eid: str):
    await manager.stop(eid)
    return {'ok': True}


@app.post('/api/environments/{eid}/open-tab')
async def open_tab(eid: str):
    async with manager.lock:
        context = manager.require_context(eid)
        page = await context.new_page()
        try:
            await page.goto(manager.get(eid)['start_url'], wait_until='domcontentloaded', timeout=20000)
            await page.bring_to_front()
        except Exception as exc:
            raise HTTPException(502, '标签页已创建，但导航失败：' + str(exc)[:500])
        manager.log(eid, '已在该环境打开启动页')
        return {'ok': True}


@app.get('/api/environments/{eid}/pelican')
async def task_status(eid: str):
    manager.get(eid)
    return pelican.snapshot(eid)


@app.post('/api/environments/{eid}/pelican/start')
async def task_start(eid: str, settings: TaskSettings):
    async with manager.lock:
        return await pelican.start(eid, settings)


@app.post('/api/environments/{eid}/pelican/stop')
async def task_stop(eid: str):
    manager.get(eid)
    await pelican.stop(eid)
    return pelican.snapshot(eid)


@app.get('/api/records')
async def record_list(q: str=Query(default='',max_length=200),rating: str='',starred: bool=False,
                      kind: str='',environment_id: str='',page: int=Query(default=1,ge=1,le=100000)):
    return pelican.history.list(q,rating,starred,kind,environment_id,page)


@app.get('/api/records/{rid}')
async def record_detail(rid: str):
    return pelican.history.get(rid)


@app.put('/api/records/{rid}/review')
async def record_review(rid: str,inp: ReviewInput):
    return pelican.history.review(rid,inp)


@app.get('/api/records/{rid}/screenshot')
async def record_screenshot(rid: str):
    return FileResponse(pelican.history.screenshot_path(rid),media_type='image/png')


@app.get('/api/records/{rid}/export')
async def record_export(rid: str):
    record=pelican.history.get(rid)
    return JSONResponse(record,headers={'Content-Disposition':f'attachment; filename="task-{record["id"]}.json"'})


@app.post('/api/records/{rid}/open')
async def record_open(rid: str):
    record=pelican.history.get(rid)
    parsed=urlparse(record['url'])
    if parsed.scheme!='https' or parsed.netloc!='arena.ai':
        raise HTTPException(409,'未记录有效的 Arena 对话链接，请查看原文或截图')
    if parsed.path.rstrip('/') in ('','/agent') and not parsed.query:
        raise HTTPException(409,'未获取到具体对话地址；请在所属环境的历史列表查找')
    async with manager.lock:
        context=manager.require_context(record['environment_id'])
        page=await context.new_page()
        try:
            await page.goto(record['url'],wait_until='domcontentloaded',timeout=20000)
            await page.bring_to_front()
        except Exception as exc:
            raise HTTPException(502,'已在所属环境开页，但导航失败：'+str(exc)[:300])
    return {'ok':True}


@app.post('/api/environments/{eid}/open-arena')
async def open_arena(eid: str):
    async with manager.lock:
        context=manager.require_context(eid)
        page=await context.new_page()
        try:
            await page.goto('https://arena.ai/agent',wait_until='domcontentloaded',timeout=20000)
            await page.bring_to_front()
        except Exception as exc:
            raise HTTPException(502,'已开页，请在浏览器中检查网络：'+str(exc)[:300])
    return {'ok':True}


@app.get('/api/logs')
async def logs():
    return {'logs': list(manager.logs)[-100:]}


if __name__ == '__main__':
    import uvicorn
    print('Harbor 浏览器管理器：http://127.0.0.1:8766（Ctrl+C 关闭管理器及浏览器）')
    uvicorn.run(app, host='127.0.0.1', port=8766, workers=1)

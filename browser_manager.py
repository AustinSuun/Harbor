"""Standalone local browser environment manager. Run: python browser_manager.py"""
from __future__ import annotations
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time
import shutil
from typing import Literal
import sys
import uuid
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, Response
from html_results import preview_html
import yescaptcha_support
import trace_inspector_support
import default_plugins
import re
from task_history import ReviewInput
from pydantic import BaseModel, Field, SecretStr, field_validator
from fastapi.exceptions import RequestValidationError
from manager_credentials import encrypt_password, decrypt_password, CredentialError
from manager_login import login as arena_login, confirmed as login_confirmed, probe as login_probe
from runtime_paths import RESOURCE_DIR, DATA_DIR, FROZEN, ensure_browser_resources
from playwright.async_api import async_playwright
from pelican_tasks import PelicanTasks, TaskSettings
from app_version import VERSION
from update_service import Updates

BASE = RESOURCE_DIR
DATA = DATA_DIR
MAX_RUNNING = 6
updates = Updates(DATA)


def now():
    return datetime.now(timezone.utc).isoformat()


class AccountInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    note: str = Field(default='', max_length=500)
    login_email: str = Field(default='', max_length=254)
    login_password: SecretStr | None = None
    clear_credentials: bool = False

    @field_validator('login_email')
    @classmethod
    def valid_email(cls, value):
        value = value.strip()
        if value and ('@' not in value or any(c.isspace() for c in value)):
            raise ValueError('请输入有效邮箱')
        return value

    @field_validator('login_password')
    @classmethod
    def valid_password(cls, value):
        if value is not None and len(value.get_secret_value()) > 4096:
            raise ValueError('密码过长')
        return value
    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('名称不能为空')
        return value


class GlobalPluginInput(BaseModel):
    client_key: SecretStr | None = None
    clear: bool = False


class YesCaptchaInput(BaseModel):
    enabled: bool = False
    folder: str = Field(default='', max_length=2048)


class TraceInspectorInput(BaseModel):
    enabled: bool = False
    folder: str = Field(default='', max_length=2048)


class ManualLoginInput(BaseModel):
    confirmed: bool = False
    email: str = Field(min_length=1, max_length=254)


class EnvironmentInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    note: str = Field(default='', max_length=500)
    account_id: str = Field(min_length=1, max_length=80)
    mode: Literal['persistent', 'incognito'] = 'persistent'
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
        self.yescaptcha_started = {}
        self.trace_inspector_started = {}
        self.browsers = {}
        self.login_jobs = {}
        self.auth_watch_jobs = {}
        self.auth_states = {}
        self.auth_evidence = {}
        self.manual_login = {}
        self.temporary_sessions = set()
        self.temporary_profiles = {}
        self.discard_pending = set()
        self.cleanup_tasks = {}
        self.background_tasks = set()
        self.states = {}
        self.errors = {}
        self.logs = deque(maxlen=200)
        self.lock = asyncio.Lock()
        self.db = None
        self.pw = None
        self.shutting_down = False
        self.updating = False
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
        columns = {r[1] for r in self.db.execute('PRAGMA table_info(environments)')}
        for name in ('login_email', 'password_cipher'):
            if name not in columns:
                self.db.execute(f"ALTER TABLE environments ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
        # Idempotent, transactional migration: never decrypt credentials during migration.
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', login_email TEXT NOT NULL, password_cipher TEXT NOT NULL, created_at TEXT NOT NULL)")
            if 'account_id' not in columns:
                self.db.execute("ALTER TABLE environments ADD COLUMN account_id TEXT NOT NULL DEFAULT ''")
            if 'mode' not in columns:
                self.db.execute("ALTER TABLE environments ADD COLUMN mode TEXT NOT NULL DEFAULT 'incognito'")
            for row in self.db.execute("SELECT * FROM environments WHERE account_id='' AND login_email<>'' AND password_cipher<>''").fetchall():
                aid = uuid.uuid4().hex
                self.db.execute('INSERT INTO accounts VALUES (?,?,?,?,?,?)',
                    (aid, row['name'], row['note'], row['login_email'], row['password_cipher'], now()))
                self.db.execute("UPDATE environments SET account_id=?, login_email='', password_cipher='' WHERE id=?", (aid, row['id']))
        # Legacy profiles are not reused or deleted by migration.
        self.db.execute('UPDATE environments SET extension_enabled=0 WHERE extension_enabled<>0')
        self.db.commit()
        yescaptcha_support.initialize(self.db, DATA / 'migration-backups')
        trace_inspector_support.initialize(self.db, DATA / 'migration-backups')
        default_plugins.initialize(self.db, DATA)

    def get(self, eid):
        row = self.db.execute('SELECT * FROM environments WHERE id=?', (eid,)).fetchone()
        if row is None:
            raise HTTPException(404, '环境不存在')
        return dict(row)

    def account(self, aid):
        row = self.db.execute('SELECT * FROM accounts WHERE id=?', (aid,)).fetchone()
        if row is None:
            raise HTTPException(404, '账号不存在，请先添加或关联账号')
        return dict(row)

    def account_for(self, eid):
        return self.account(self.get(eid)['account_id'])

    def account_snapshot(self):
        result = []
        for row in self.db.execute('SELECT * FROM accounts ORDER BY created_at, rowid'):
            item = dict(row)
            item['has_password'] = bool(item.pop('password_cipher', ''))
            envs = self.db.execute('SELECT id FROM environments WHERE account_id=?', (item['id'],)).fetchall()
            item['environment_count'] = len(envs)
            item['running_count'] = sum(r['id'] in self.contexts for r in envs)
            result.append(item)
        return result

    def unique_environment_name(self, requested):
        """Allocate a name inside the creation transaction; compare without case."""
        base = requested.strip()
        occupied = {row[0].strip().casefold() for row in self.db.execute('SELECT name FROM environments')}
        if base.casefold() not in occupied:
            return base
        number = 2
        while True:
            suffix = f' ({number})'
            candidate = base[:80-len(suffix)].rstrip() + suffix
            if candidate.casefold() not in occupied:
                return candidate
            number += 1

    def create_environment(self, inp):
        self.account(inp.account_id)
        eid = uuid.uuid4().hex
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            name = self.unique_environment_name(inp.name)
            self.db.execute('INSERT INTO environments (id,name,note,start_url,extension_enabled,created_at,account_id,mode) VALUES (?,?,?,?,?,?,?,?)',
                (eid, name, inp.note, inp.start_url, 0, now(), inp.account_id, inp.mode))
        self.log(eid, '创建环境：' + name)
        return eid

    def snapshot(self):
        result = []
        for row in self.db.execute('SELECT * FROM environments ORDER BY created_at DESC, rowid DESC'):
            item = dict(row)
            eid = item['id']
            item.pop('password_cipher', None)
            item.pop('login_email', None)
            account = self.account(item['account_id']) if item['account_id'] else {}
            item['account_name'] = account.get('name', '未关联账号')
            item['login_email'] = account.get('login_email', '')
            item['auth_status'] = self.auth_states.get(eid, 'not_logged_in')
            item['auth_detail'] = self.auth_evidence.get(eid, {})
            item.pop('extension_enabled',None)  # Legacy column remains unrelated.
            item['trace_inspector'] = {'enabled':True,'folder':'','automatic':True}
            item['trace_inspector']['runtime'] = ('requested_on_launch' if self.trace_inspector_started.get(eid) else 'disabled_on_launch') if eid in self.contexts else 'not_running'
            item['yescaptcha'] = {'enabled':True,'folder':'','automatic':True}
            item['yescaptcha']['runtime'] = ('requested_on_launch' if self.yescaptcha_started.get(eid) else 'disabled_on_launch') if eid in self.contexts else 'not_running'
            item['task'] = pelican.snapshot(eid)
            item.update(status=self.states.get(eid, 'stopped'), error=self.errors.get(eid, ''), profile_path=str(DATA / 'session-profiles' / eid) if item['mode']=='persistent' else '')
            result.append(item)
        return result

    def background(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.background_tasks.add(task)
        def finished(done):
            self.background_tasks.discard(done)
            if not done.cancelled() and done.exception() is not None:
                self.log('system', '浏览器后台收尾失败，请检查环境状态；未输出原始错误以保护凭据')
        task.add_done_callback(finished)
        return task

    async def close_empty_context(self, eid, context):
        # Closing a result tab is not closing the environment if other tabs remain.
        await asyncio.sleep(0)
        if self.contexts.get(eid) is context and not context.pages:
            try:
                await context.close()
            except Exception:
                self.log(eid, '最后一个标签页关闭后未能确认浏览器退出，请在管理器中关闭环境')

    def watch_pages(self, eid, context):
        def watch(page):
            page.on('close', lambda *_: self.background(self.close_empty_context(eid, context)))
        for page in context.pages:
            watch(page)
        context.on('page', watch)

    async def discard_temporary(self, eid, browser, login_job):
        try:
            if browser and browser.is_connected():
                await browser.close()
            if login_job:
                await asyncio.gather(login_job, return_exceptions=True)
            await default_plugins.remove_temporary_profile(self.temporary_profiles.get(eid))
            self.temporary_profiles.pop(eid, None)
            async with self.lock:
                # Wait for final task history writes before dropping runtime state.
                await pelican.stop(eid)
                row = self.db.execute('SELECT mode FROM environments WHERE id=?', (eid,)).fetchone()
                if row is not None and row['mode'] == 'incognito' and eid not in self.contexts:
                    with self.db:
                        self.db.execute('DELETE FROM pelican_settings WHERE environment_id=?', (eid,))
                        self.db.execute('DELETE FROM environments WHERE id=?', (eid,))
                    pelican.runs.pop(eid, None)
                    pelican.last_send.pop(eid, None)
                    self.states.pop(eid, None)
                    self.auth_states.pop(eid, None)
                    self.errors.pop(eid, None)
                    self.log(eid, '临时无痕环境已关闭并丢弃；账号、加密凭据和历史任务保留')
                self.discard_pending.discard(eid)
        except Exception:
            # Never delete records if task finalization or browser closure failed.
            self.states[eid] = 'error'
            self.errors[eid] = '临时环境清理未完成，请确认浏览器退出后手动删除环境；历史记录保留。'
            self.log(eid, self.errors[eid])
        finally:
            self.cleanup_tasks.pop(eid, None)

    def closed(self, eid, context):
        if self.contexts.get(eid) is context:
            self.contexts.pop(eid, None)
            self.manual_login.pop(eid, None)
            self.auth_evidence.pop(eid, None)
            watcher = self.auth_watch_jobs.pop(eid, None)
            if watcher and watcher is not asyncio.current_task():
                watcher.cancel()
            pelican.browser_closed(eid)
            self.states[eid] = 'stopped'
            self.auth_states[eid] = 'not_logged_in'
            job = self.login_jobs.pop(eid, None)
            if job and job is not asyncio.current_task():
                job.cancel()
            browser = self.browsers.pop(eid, None)
            if eid in self.temporary_sessions:
                self.temporary_sessions.discard(eid)
                self.discard_pending.add(eid)
                self.states[eid] = 'stopping'
                self.cleanup_tasks[eid] = self.background(self.discard_temporary(eid, browser, job))
            else:
                if browser and browser.is_connected():
                    self.background(browser.close())
                self.log(eid, '浏览器已关闭；保留型环境资料、账号与历史记录保留')

    async def launch(self, eid):
        async with self.lock:
            item = self.get(eid)
            if self.updating:raise HTTPException(409, '正在安装更新，暂不能启动环境')
            if eid in self.discard_pending:
                raise HTTPException(409, '此临时环境正在丢弃，请从账号管理新建环境')
            if eid in self.contexts:
                return
            if len(self.contexts) >= MAX_RUNNING:
                raise HTTPException(409, f'最多同时运行 {MAX_RUNNING} 个环境，请先关闭其他环境')
            self.states[eid] = 'starting'
            self.errors.pop(eid, None)
            context = None
            try:
                account = self.account_for(eid)
                if not account['login_email'] or not account['password_cipher']:
                    raise CredentialError('请先在账号管理中保存 Arena 邮箱和密码。')
                key = default_plugins.key_value(self.db)
                extension_args = await default_plugins.launch_resources(DATA)
                if item['mode'] == 'persistent':
                    profile = DATA / 'session-profiles' / eid
                    profile.mkdir(parents=True, exist_ok=True)
                else:
                    decrypt_password(account['password_cipher'])
                    profile = default_plugins.make_temporary_profile(DATA)
                    self.temporary_profiles[eid] = profile
                context = await self.pw.chromium.launch_persistent_context(
                    user_data_dir=str(profile), channel='chromium', headless=False,
                    no_viewport=True, args=extension_args, offline=True, timeout=45000)
                await default_plugins.configure_context(context, key)
                key = None
                await context.set_offline(False)
                self.contexts[eid] = context
                self.yescaptcha_started[eid] = True
                self.trace_inspector_started[eid] = True
                context.on('close', lambda *_: self.closed(eid, context))
                self.watch_pages(eid, context)
                self.states[eid] = 'running'
                self.auth_states[eid] = 'logging_in'
                page = context.pages[0] if context.pages else await context.new_page()
                if item['mode'] == 'incognito':
                    self.temporary_sessions.add(eid)
                self.login_jobs[eid] = asyncio.create_task(self.auto_login(eid, context, page))
                self.log(eid, ('保留型环境已打开' if item['mode']=='persistent' else '全新无痕会话已启动') + '，正在检查登录')
            except Exception as exc:
                if context is not None:
                    await context.close()
                browser = self.browsers.pop(eid, None)
                if browser:
                    await browser.close()
                try:
                    await default_plugins.remove_temporary_profile(self.temporary_profiles.get(eid))
                    self.temporary_profiles.pop(eid, None)
                except ValueError:
                    self.log(eid, '临时资料清理失败，请退出浏览器后检查 temporary-plugin-profiles')
                self.auth_states[eid] = 'not_logged_in'
                self.states[eid] = 'error'
                self.errors[eid] = str(exc)[:1000]
                self.log(eid, '启动失败：' + self.errors[eid])
                raise HTTPException(500, '启动失败，请确认浏览器资源完整、当前机器有桌面环境，且配置目录未被占用。源码模式可执行 python -m playwright install chromium。详情：' + str(exc)[:700])

    def credentials(self, inp, old=None):
        old = old or {}
        if inp.clear_credentials:
            return '', ''
        email = inp.login_email
        password = inp.login_password.get_secret_value() if inp.login_password else ''
        cipher = old.get('password_cipher', '')
        if not password and email != old.get('login_email', '') and cipher:
            raise HTTPException(400, '更换邮箱时必须重新输入密码，或清除凭据。')
        if password:
            if not email:
                raise HTTPException(400, '保存密码时必须填写邮箱。')
            try:
                cipher = encrypt_password(password)
            except CredentialError as exc:
                raise HTTPException(400, str(exc)) from None
        if bool(email) != bool(cipher):
            raise HTTPException(400, '请同时保存邮箱和密码。')
        return email, cipher

    async def auto_login(self, eid, context, page):
        cancelled = False
        try:
            item = self.account_for(eid)
            try:
                await page.goto('https://arena.ai/agent', wait_until='domcontentloaded', timeout=45000)
                evidence = await login_probe(page, item['login_email'], interact=True)
                ok = evidence['status'] == 'authenticated'
                if not ok:
                    ok = await arena_login(page, item['login_email'], decrypt_password(item['password_cipher']))
                    if ok:
                        evidence = await login_probe(page, item['login_email'], interact=True)
                        ok = evidence['status'] == 'authenticated'
            except Exception:
                # Playwright errors can contain fill values. Never expose raw errors.
                ok = False
            if self.contexts.get(eid) is not context:
                return
            self.auth_states[eid] = 'authenticated' if ok else 'needs_attention'
            if ok:
                self.auth_evidence[eid] = evidence
                self.errors.pop(eid, None)
                self.log(eid, '已自动识别登录态，可启动自动任务：' + evidence['reason'])
            else:
                evidence = await self.login_evidence(eid)
                if self.contexts.get(eid) is not context:
                    return
                self.auth_evidence[eid] = evidence
                if evidence['status'] == 'authenticated':
                    self.auth_states[eid] = 'authenticated'
                    self.errors.pop(eid, None)
                    self.log(eid, '已通过补充页面检查确认登录身份')
                    return
                self.errors[eid] = '自动登录未确认：' + evidence['reason'] + '。请检查登录，或在核对账号后使用人工确认。'
                self.log(eid, self.errors[eid])
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if self.login_jobs.get(eid) is asyncio.current_task():
                self.login_jobs.pop(eid, None)
            if not self.shutting_down and not cancelled and self.contexts.get(eid) is context and self.auth_states.get(eid) != 'authenticated' and eid not in self.auth_watch_jobs:
                self.auth_watch_jobs[eid] = asyncio.create_task(self.watch_login(eid, context))

    async def watch_login(self, eid, context):
        # Observe after a delayed/manual login; never send, navigate, or open menus here.
        try:
            while self.contexts.get(eid) is context:
                await asyncio.sleep(5)
                if self.contexts.get(eid) is not context:
                    return
                if pelican.snapshot(eid)['status'] in ('running', 'stopping'):
                    continue
                email = self.account_for(eid)['login_email']
                for page in reversed(context.pages):
                    evidence = await login_probe(page, email, interact=False)
                    if self.contexts.get(eid) is not context:
                        return
                    if evidence['status'] == 'authenticated':
                        self.auth_evidence[eid] = evidence
                        self.auth_states[eid] = 'authenticated'
                        self.manual_login.pop(eid, None)
                        self.errors.pop(eid, None)
                        self.log(eid, '自动观察已识别登录态：' + evidence['reason'])
                        return
        except asyncio.CancelledError:
            raise
        except Exception:
            self.log(eid, '登录状态观察已停止，可点击检查登录重试')
        finally:
            if self.auth_watch_jobs.get(eid) is asyncio.current_task():
                self.auth_watch_jobs.pop(eid, None)

    async def login_evidence(self, eid):
        context = self.require_context(eid)
        email = self.account_for(eid)['login_email']
        best = {'status':'unknown', 'reason':'没有可检查的 Arena 标签页', 'ready':False, 'method':'none'}
        ranks = {'unknown':0, 'logged_out':1, 'blocked':2, 'mismatch':3}
        interacting = pelican.snapshot(eid)['status'] not in ('running', 'stopping')
        for page in reversed(context.pages):
            evidence = await login_probe(page, email, interact=interacting)
            if evidence['status'] == 'authenticated':
                return evidence
            if ranks.get(evidence['status'],0) > ranks.get(best['status'],0) or (evidence['status']==best['status']=='unknown' and (evidence['ready'] or (best['method']=='none' and evidence['method']=='inconclusive'))):
                best = evidence
        return best

    async def check_login(self, eid):
        context = self.require_context(eid)
        if self.auth_states.get(eid) == 'logging_in':
            raise HTTPException(409, '正在自动登录，请稍候。')
        evidence = await self.login_evidence(eid)
        self.auth_evidence[eid] = evidence
        if evidence['status'] == 'authenticated':
            self.auth_states[eid] = 'authenticated'
            self.manual_login.pop(eid, None)
            self.errors.pop(eid, None)
            return evidence
        approval = self.manual_login.get(eid)
        if evidence['status']=='unknown' and evidence['ready'] and approval and approval[0] is context and time.monotonic()<approval[1]:
            self.auth_states[eid] = 'manual_confirmed'
            self.errors.pop(eid, None)
            return dict(evidence, method='manual', reason='已由用户核对账号并确认；非自动识别')
        self.manual_login.pop(eid, None)
        self.auth_states[eid] = 'needs_attention'
        self.errors[eid] = evidence['reason']
        raise HTTPException(409, evidence['reason'] + ('；若已核对账号且聊天页可用，可点击“人工确认登录”。' if evidence['status']=='unknown' else ''))

    async def confirm_manual_login(self, eid, inp):
        context = self.require_context(eid)
        if not inp.confirmed or inp.email.strip().lower()!=self.account_for(eid)['login_email'].strip().lower():
            raise HTTPException(400, '请明确确认当前浏览器已登录所选账号')
        if self.auth_states.get(eid)=='logging_in':
            raise HTTPException(409, '自动登录尚未结束，请稍候')
        if pelican.snapshot(eid)['status'] in ('running','stopping'):
            raise HTTPException(409, '任务运行期间不能更改人工确认状态')
        evidence = await self.login_evidence(eid)
        self.auth_evidence[eid] = evidence
        if evidence['status'] == 'authenticated':
            self.auth_states[eid] = 'authenticated'
            self.errors.pop(eid, None)
            return evidence
        if evidence['status']!='unknown' or not evidence['ready']:
            raise HTTPException(409, '不能人工放行：'+evidence['reason']+'。需在 Arena 聊天页完成登录和验证。')
        self.manual_login[eid] = (context, time.monotonic()+600)
        self.auth_states[eid] = 'manual_confirmed'
        self.errors.pop(eid, None)
        self.log(eid, '用户人工确认当前账号登录；仅本次会话、10分钟内有效，不代表自动身份识别成功')
        return {'status':'manual_confirmed', 'method':'manual'}

    async def stop(self, eid):
        async with self.lock:
            self.get(eid)
            await pelican.stop(eid)
            watcher = self.auth_watch_jobs.pop(eid, None)
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            job = self.login_jobs.pop(eid, None)
            if job:
                job.cancel()
                await asyncio.gather(job, return_exceptions=True)
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
            browser = self.browsers.pop(eid, None)
            if browser:
                await browser.close()
            self.auth_states[eid] = 'not_logged_in'
            self.states[eid] = 'stopped'
            self.errors.pop(eid, None)
        # The context close callback schedules cleanup; do not await it under self.lock.
        cleanup = self.cleanup_tasks.get(eid)
        if cleanup:
            await asyncio.shield(cleanup)

    def require_context(self, eid):
        """Future automation adapters must request one explicit environment."""
        self.get(eid)
        if eid not in self.contexts or self.states.get(eid) != 'running':
            raise HTTPException(409, '请先启动该环境')
        return self.contexts[eid]


manager = Manager()
pelican = PelicanTasks(manager)
from file_probe import FileProbe, PROBE_PAGE
file_probe = FileProbe(manager)
from thinking_probe import ThinkingProbe, PROBE_UI as THINKING_PROBE_UI
thinking_probe = ThinkingProbe(manager)


@asynccontextmanager
async def lifespan(app):
    ensure_browser_resources()
    manager.acquire()
    try:
        pelican.initialize()
        manager.pw = await async_playwright().start()
        yield
    finally:
        manager.shutting_down = True
        await pelican.shutdown()
        jobs = list(manager.login_jobs.values()) + list(manager.auth_watch_jobs.values())
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        for context in list(manager.contexts.values()):
            try:
                await context.close()
            except Exception:
                pass
        for browser in list(manager.browsers.values()):
            try:
                await browser.close()
            except Exception:
                pass
        # Context close callbacks may still be finalizing ephemeral environments.
        while manager.background_tasks:
            await asyncio.gather(*list(manager.background_tasks), return_exceptions=True)
        if manager.pw:
            await manager.pw.stop()
        if manager.db:
            manager.db.close()
        if manager.guard:
            manager.guard.close()


app = FastAPI(title='Harbor · 多浏览器环境管理', lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # Pydantic's default response may echo rejected input, including passwords.
    return JSONResponse({'detail': '请求字段不合法，请检查邮箱、密码长度和环境设置。'}, status_code=422)


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


@app.get('/api/updates')
async def update_info():
    release=await asyncio.to_thread(updates.check)
    return {**release,'install_supported':FROZEN and sys.platform=='win32','status':updates.status}


@app.post('/api/updates/install',status_code=202)
async def install_update():
    if not FROZEN or sys.platform!='win32':raise HTTPException(409,'源码/Mac版请从项目页面手动更新')
    if not getattr(app.state,'request_exit',None):raise HTTPException(409,'请使用 Harbor 启动器运行更新')
    async with manager.lock:
        if manager.updating:raise HTTPException(409,'更新已经在进行')
        if manager.contexts or any(r['status'] in ('running','stopping') for r in pelican.runs.values()):
            raise HTTPException(409,'请先保存工作并关闭浏览器环境，再一键更新；不会强制中断任务')
        manager.updating=True
    async def perform():
        try:
            release=await asyncio.to_thread(updates.check)
            exe=await asyncio.to_thread(updates.prepare,release)
            import os
            updates.schedule(exe,os.getpid(),release['latest_version'])
            asyncio.get_running_loop().call_later(1,app.state.request_exit)
        except Exception:
            updates.status={'phase':'failed','message':'更新失败，旧程序和数据未覆盖；可到项目页面手动下载'}
            manager.updating=False
    app.state.update_task=asyncio.create_task(perform())
    return {'started':True}


@app.get('/api/plugins')
async def plugin_settings():
    return default_plugins.settings(manager.db)


@app.put('/api/plugins')
async def plugin_settings_update(inp: GlobalPluginInput):
    async with manager.lock:
        try:
            default_plugins.save_key(manager.db, inp.client_key.get_secret_value() if inp.client_key is not None else None, inp.clear)
        except (ValueError, CredentialError):
            raise HTTPException(422, '密钥未保存：请检查 ClientKey 格式和本机凭据存储；不会保存明文') from None
        return {**default_plugins.settings(manager.db), 'running_unchanged':True}


@app.get('/api/accounts')
async def accounts():
    return {'accounts': manager.account_snapshot()}


@app.post('/api/accounts', status_code=201)
async def account_create(inp: AccountInput):
    async with manager.lock:
        email, cipher = manager.credentials(inp)
        if not email or not cipher:
            raise HTTPException(400, '新账号必须保存邮箱和密码')
        aid = uuid.uuid4().hex
        with manager.db:
            manager.db.execute('INSERT INTO accounts VALUES (?,?,?,?,?,?)',
                (aid, inp.name, inp.note, email, cipher, now()))
        return {'id': aid}


@app.put('/api/accounts/{aid}')
async def account_update(aid: str, inp: AccountInput):
    async with manager.lock:
        old = manager.account(aid)
        linked = manager.db.execute('SELECT id FROM environments WHERE account_id=?', (aid,)).fetchall()
        active = any(r['id'] in manager.contexts or manager.states.get(r['id']) in ('starting', 'running', 'stopping') for r in linked)
        if active:
            if inp.clear_credentials or inp.login_password or inp.login_email != old['login_email']:
                raise HTTPException(409, '环境运行时只能修改名称和备注；更换登录凭据请先关闭关联环境')
            with manager.db:
                manager.db.execute('UPDATE accounts SET name=?,note=? WHERE id=?', (inp.name, inp.note, aid))
            return {'ok': True}
        # Email identity is immutable once linked: never reuse another account's profile.
        if linked and (inp.clear_credentials or inp.login_email != old['login_email']):
            raise HTTPException(409, '已有环境关联时不可更换邮箱或清空账号，请另建账号；密码仍可更新')
        email, cipher = manager.credentials(inp, old)
        if not email or not cipher:
            raise HTTPException(400, '账号必须保存邮箱和密码；不再使用请删除账号')
        with manager.db:
            manager.db.execute('UPDATE accounts SET name=?,note=?,login_email=?,password_cipher=? WHERE id=?',
                (inp.name, inp.note, email, cipher, aid))
        return {'ok': True}


@app.delete('/api/accounts/{aid}')
async def account_delete(aid: str):
    async with manager.lock:
        manager.account(aid)
        if manager.db.execute('SELECT 1 FROM environments WHERE account_id=?', (aid,)).fetchone():
            raise HTTPException(409, '请先删除该账号关联的环境，防止产生失去账号的环境')
        with manager.db:
            manager.db.execute('DELETE FROM accounts WHERE id=?', (aid,))
        return {'ok': True}


@app.post('/api/accounts/{aid}/launch', status_code=201)
async def account_launch(aid: str, inp: EnvironmentInput):
    if aid != inp.account_id:
        raise HTTPException(400, '账号不匹配')
    async with manager.lock:
        eid = manager.create_environment(inp)
    # launch obtains its own lock; keep the newly created environment on failure for retry.
    try:
        await manager.launch(eid)
    except HTTPException as exc:
        return JSONResponse({'id': eid, 'detail': '环境已创建，但启动失败：' + str(exc.detail)}, status_code=exc.status_code)
    return {'id': eid}


@app.post('/api/environments', status_code=201)
async def create(inp: EnvironmentInput):
    async with manager.lock:
        return {'id': manager.create_environment(inp)}


@app.put('/api/environments/{eid}')
async def update(eid: str, inp: EnvironmentInput):
    async with manager.lock:
        old = manager.get(eid)
        if eid in manager.discard_pending:
            raise HTTPException(409, '临时环境正在丢弃，不可编辑')
        if eid in manager.contexts:
            raise HTTPException(409, '请关闭环境后再编辑')
        manager.account(inp.account_id)
        if old['account_id'] and (old['account_id'] != inp.account_id or old['mode'] != inp.mode):
            raise HTTPException(409, '已有环境不能更换账号或类型；请新建环境，避免混用登录资料')
        with manager.db:
            manager.db.execute('UPDATE environments SET name=?,note=?,start_url=?,account_id=?,mode=? WHERE id=?',
                (inp.name, inp.note, inp.start_url, inp.account_id, inp.mode, eid))
        return {'ok': True}


@app.delete('/api/environments/{eid}')
async def delete(eid: str):
    async with manager.lock:
        manager.get(eid)
        if eid in manager.contexts:
            raise HTTPException(409, '请先关闭环境')
        await pelican.stop(eid)
        # Delete only the new managed profile, after explicit UI confirmation.
        profile = DATA / 'session-profiles' / eid
        if profile.exists():
            try:
                shutil.rmtree(profile)
            except OSError:
                raise HTTPException(409, '环境资料删除失败，请确认浏览器已完全退出后重试') from None
        # Legacy data stays archived rather than silently deleted.
        profile = DATA / 'profiles' / eid
        if profile.exists():
            archive = DATA / 'archive'
            archive.mkdir(exist_ok=True)
            profile.rename(archive / f'{eid}-{uuid.uuid4().hex[:8]}')
        with manager.db:
            manager.db.execute('DELETE FROM environments WHERE id=?', (eid,))
            manager.db.execute('DELETE FROM yescaptcha_settings WHERE environment_id=?', (eid,))
            manager.db.execute('DELETE FROM trace_inspector_settings WHERE environment_id=?', (eid,))
            manager.db.execute('DELETE FROM pelican_settings WHERE environment_id=?', (eid,))
        pelican.runs.pop(eid, None)
        pelican.last_send.pop(eid, None)
        manager.states.pop(eid, None)
        manager.yescaptcha_started.pop(eid, None)
        manager.trace_inspector_started.pop(eid, None)
        manager.errors.pop(eid, None)
        manager.auth_states.pop(eid, None)
        manager.manual_login.pop(eid, None)
        manager.auth_evidence.pop(eid, None)
        manager.discard_pending.discard(eid)
        manager.temporary_sessions.discard(eid)
        manager.log(eid, '环境已删除；账号和历史任务保留，旧版 profile 如存在则归档')
        return {'ok': True}


@app.put('/api/environments/{eid}/trace-inspector')
async def configure_trace_inspector(eid: str, inp: TraceInspectorInput):
    async with manager.lock:
        item = manager.get(eid)
        try:
            with manager.db:
                trace_inspector_support.write_settings(manager.db, eid, item['mode'], inp.enabled, inp.folder)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {'ok': True, 'takes_effect': 'next_environment_start', 'running_unchanged': eid in manager.contexts}


@app.put('/api/environments/{eid}/yescaptcha')
async def configure_yescaptcha(eid: str, inp: YesCaptchaInput):
    async with manager.lock:
        item = manager.get(eid)
        try:
            with manager.db:
                yescaptcha_support.write_settings(manager.db, eid, item['mode'], inp.enabled, inp.folder)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {'ok': True, 'takes_effect': 'next_environment_start', 'running_unchanged': eid in manager.contexts}


@app.post('/api/environments/{eid}/start')
async def start(eid: str):
    await manager.launch(eid)
    return {'ok': True}


@app.post('/api/environments/{eid}/check-login')
async def check_login(eid: str):
    async with manager.lock:
        await manager.check_login(eid)
    return {'ok': True, 'auth_status': manager.auth_states.get(eid), 'detail': manager.auth_evidence.get(eid,{})}


@app.post('/api/environments/{eid}/manual-confirm-login')
async def manual_confirm_login(eid: str, inp: ManualLoginInput):
    async with manager.lock:
        return await manager.confirm_manual_login(eid, inp)


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
        await manager.check_login(eid)
        return await pelican.start(eid, settings)


@app.post('/api/environments/{eid}/pelican/stop')
async def task_stop(eid: str):
    manager.get(eid)
    await pelican.stop(eid)
    return pelican.snapshot(eid)


@app.get('/thinking-probe',response_class=HTMLResponse)
async def thinking_probe_ui():return HTMLResponse(THINKING_PROBE_UI)


@app.get('/api/thinking-probe/pages')
async def thinking_probe_pages():return {'pages':thinking_probe.list_pages()}


class ThinkingMarkInput(BaseModel):
    mark: Literal['unmarked','visible-thinking','thinking-ended','reply-completed','uncertain'] = 'unmarked'


@app.post('/api/thinking-probe/{key}/sample')
async def thinking_probe_sample(key: str, inp: ThinkingMarkInput):
    return await thinking_probe.sample(key,inp.mark)


@app.get('/api/thinking-probe/{key}/report')
async def thinking_probe_report(key: str):
    return JSONResponse(thinking_probe.report(key),headers={'Content-Disposition':'attachment; filename="thinking-diagnostic.json"'})


@app.get('/file-probe',response_class=HTMLResponse)
async def file_probe_ui():return HTMLResponse(PROBE_PAGE,headers={'Cache-Control':'no-store'})


@app.get('/api/file-probe/pages')
async def file_probe_pages(eid: str):return {'pages':file_probe.page_list(eid)}


def require_probe_idle(key):
    file_probe.get_page(key)
    eid=file_probe.pages[key][0]
    if pelican.snapshot(eid)['status'] in ('running','stopping'):
        raise HTTPException(409,'请先停止该环境的自动调度；探测不会代你停止任务')


@app.post('/api/file-probe/{key}/watch')
async def file_probe_watch(key: str):
    require_probe_idle(key)
    return file_probe.start(key)


@app.post('/api/file-probe/{key}/inspect')
async def file_probe_inspect(key: str):
    require_probe_idle(key)
    return await file_probe.inspect(key)


@app.post('/api/file-probe/{key}/stop')
async def file_probe_stop(key: str):
    file_probe.finish(key)
    return file_probe.status(key)


@app.get('/api/file-probe/{key}/content')
async def file_probe_content(key: str,index: int=Query(default=0,ge=0,le=1)):
    return JSONResponse({'html':file_probe.content(key,index)},headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})


@app.get('/api/file-probe/{key}')
async def file_probe_status(key: str):return file_probe.status(key)


@app.get('/api/html-results')
async def html_results(q: str=Query(default='',max_length=200),kind: str='',rating: str='',starred: bool=False):
    return pelican.history.html.list(q,kind,rating,starred)


@app.get('/api/html-results/{rid}/preview')
async def html_preview(rid: str):
    return JSONResponse({'html':preview_html(pelican.history.html.source(rid))},headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})


@app.get('/api/html-results/{rid}/download')
async def html_download(rid: str):
    content=pelican.history.html.source(rid)
    if not re.fullmatch(r'[0-9a-f]{32}',rid):raise HTTPException(400,'无效记录 ID')
    return Response(content.encode('utf-8'),media_type='application/octet-stream',headers={
        'Content-Disposition':f'attachment; filename="result-{rid}.html"',
        'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'no-store'})


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

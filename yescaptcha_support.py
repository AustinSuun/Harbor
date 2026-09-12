"""Opt-in local extension loading. No ClientKey, downloads, or CAPTCHA API calls."""
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import uuid

STORE_URL = 'https://chromewebstore.google.com/detail/yescaptcha-assistant/jiofmdifioeejeilfkpegipdjiopiekl'


def validate_folder(value):
    value = value.strip()
    if not value or any(c in value for c in (',', '\n', '\r', '\x00')) or value.startswith(('\\\\', '//')):
        raise ValueError('请选择本机已解压的 YesCaptcha 插件目录；不支持网络路径、逗号或换行')
    folder = Path(value).expanduser()
    if not folder.is_absolute():
        raise ValueError('插件目录必须使用绝对路径')
    folder = folder.resolve()
    try:
        with (folder/'manifest.json').open('rb') as f:
            raw = f.read(262145)
        if len(raw) > 262144:
            raise ValueError('manifest 过大')
        manifest = json.loads(raw.decode('utf-8-sig'))
        name = manifest.get('name', '')
        if name.startswith('__MSG_') and name.endswith('__'):
            locale = manifest.get('default_locale', '')
            if not re.fullmatch(r'[a-zA-Z_0-9-]{1,40}', locale):
                raise ValueError('无效语言')
            with (folder/'_locales'/locale/'messages.json').open('rb') as f:
                text = f.read(262145)
            if len(text) > 262144:
                raise ValueError('语言文件过大')
            name = json.loads(text.decode('utf-8-sig')).get(name[6:-2], {}).get('message', '')
        if 'yescaptcha' not in re.sub(r'[\s_-]', '', name).casefold():
            raise ValueError('不是 YesCaptcha')
        worker = manifest.get('background', {}).get('service_worker', '')
        if manifest.get('manifest_version') != 3 or not isinstance(worker, str) or not worker:
            raise ValueError('需要 MV3 service worker')
        worker_path = (folder/worker).resolve()
        if not worker_path.is_relative_to(folder) or not worker_path.is_file():
            raise ValueError('缺少插件文件')
    except (OSError, ValueError, TypeError, AttributeError):
        raise ValueError('插件目录无效：需要完整的 YesCaptcha Manifest V3 解压目录（含 manifest.json 和后台脚本）') from None
    # This is structural validation, NOT publisher/signature verification.
    return str(folder)


def launch_args(mode, enabled, folder):
    if not enabled:
        return ['--disable-extensions']
    if mode != 'persistent':
        raise ValueError('YesCaptcha 仅支持保留型环境，临时无痕环境不能启用')
    folder = validate_folder(folder)
    return [f'--disable-extensions-except={folder}', f'--load-extension={folder}']


def initialize(db, backup_dir):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='yescaptcha_settings'").fetchone():
        return
    # Called only after the manager's exclusive data-directory lock and previous commits.
    if db.in_transaction:
        raise RuntimeError('插件设置迁移需要已提交的数据库')
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir/('before-yescaptcha-'+uuid.uuid4().hex+'.sqlite3')
    with closing(sqlite3.connect(backup)) as target:
        db.backup(target)
    with db:
        db.execute('CREATE TABLE yescaptcha_settings (environment_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), folder TEXT NOT NULL DEFAULT \'\')')


def read_settings(db, eid):
    row = db.execute('SELECT enabled,folder FROM yescaptcha_settings WHERE environment_id=?', (eid,)).fetchone()
    return dict(enabled=bool(row[0]), folder=row[1]) if row else dict(enabled=False, folder='')


def write_settings(db, eid, mode, enabled, folder):
    if mode != 'persistent':
        raise ValueError('YesCaptcha 仅支持保留型环境')
    if enabled:
        folder = validate_folder(folder)
    else:
        folder = folder.strip()
    db.execute('INSERT INTO yescaptcha_settings(environment_id,enabled,folder) VALUES (?,?,?) ON CONFLICT(environment_id) DO UPDATE SET enabled=excluded.enabled,folder=excluded.folder', (eid, int(enabled), folder))

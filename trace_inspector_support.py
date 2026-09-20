"""Opt-in unpacked Trace Inspector loading, separate from task scheduling.
No extension download, trace ingestion, token capture, or automatic listening.
"""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import uuid
from trace_inspector_bundle import verified_bundle


def validate_folder(value):
    value = value.strip()
    if not value or any(c in value for c in (',', '\n', '\r', '\x00')) or value.startswith(('\\\\', '//')):
        raise ValueError('请选择本机完整解压的 Trace Inspector 目录；不支持网络路径、逗号或换行')
    folder = Path(value).expanduser()
    if not folder.is_absolute():
        raise ValueError('插件目录必须使用绝对路径')
    folder = folder.resolve()
    try:
        with (folder / 'manifest.json').open('rb') as f:
            raw = f.read(262145)
        if len(raw) > 262144:
            raise ValueError('manifest too large')
        manifest = json.loads(raw.decode('utf-8-sig'))
        if manifest.get('name') != 'Arena Trace Inspector' or manifest.get('manifest_version') != 3:
            raise ValueError('wrong extension')
        if set(manifest.get('permissions', [])) - {'activeTab', 'debugger', 'storage'}:
            raise ValueError('unexpected permissions')
        if set(manifest.get('host_permissions', [])) - {'https://arena.ai/*', 'https://api.trigger.dev/*'}:
            raise ValueError('unexpected hosts')
        if manifest.get('optional_permissions') or manifest.get('optional_host_permissions') or manifest.get('externally_connectable'):
            raise ValueError('additional access not supported')
        worker = manifest.get('background', {}).get('service_worker')
        if not isinstance(worker, str) or not worker:
            raise ValueError('missing worker')
        entries = [worker]
        popup = manifest.get('action', {}).get('default_popup')
        if popup:
            entries.append(popup)
        for script in manifest.get('content_scripts', []):
            if set(script.get('matches', [])) - {'https://arena.ai/*'}:
                raise ValueError('unexpected content-script hosts')
            entries.extend(script.get('js', []))
            entries.extend(script.get('css', []))
        for entry in entries:
            if not isinstance(entry, str) or not entry:
                raise ValueError('invalid entry')
            path = (folder / entry).resolve()
            if not path.is_relative_to(folder) or not path.is_file():
                raise ValueError('missing or escaped entry')
    except (OSError, ValueError, TypeError, AttributeError):
        raise ValueError('插件校验失败：需要完整 Arena Trace Inspector MV3 目录及已审核的权限范围（activeTab/debugger/storage、Arena/Trigger.dev）；不支持新增权限或缺失文件') from None
    # Declared-entry/permission checks are not a signature or full source audit.
    return str(folder)


def resolve_folder(value=''):
    value = value.strip()
    return validate_folder(value or verified_bundle())


def launch_args(mode, settings, existing_args):
    if not settings['enabled']:
        return list(existing_args)
    if mode != 'persistent':
        raise ValueError('Trace Inspector 当前仅支持保留型环境，不改变临时无痕环境的隔离方式')
    folder = resolve_folder(settings['folder'])
    paths = []
    for arg in existing_args:
        if arg.startswith('--load-extension='):
            paths.extend(arg.split('=', 1)[1].split(','))
    if folder not in paths:
        paths.append(folder)
    joined = ','.join(paths)
    return [f'--disable-extensions-except={joined}', f'--load-extension={joined}']


def initialize(db, backup_dir):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trace_inspector_settings'").fetchone():
        return
    if db.in_transaction:
        raise RuntimeError('插件设置迁移需要已提交的数据库')
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(backup_dir / ('before-trace-inspector-' + uuid.uuid4().hex + '.sqlite3'))) as target:
        db.backup(target)
    with db:
        db.execute("CREATE TABLE trace_inspector_settings (environment_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), folder TEXT NOT NULL DEFAULT '')")


def read_settings(db, eid):
    row = db.execute('SELECT enabled,folder FROM trace_inspector_settings WHERE environment_id=?', (eid,)).fetchone()
    return dict(enabled=bool(row[0]), folder=row[1]) if row else dict(enabled=False, folder='')


def write_settings(db, eid, mode, enabled, folder):
    if mode != 'persistent':
        raise ValueError('Trace Inspector 当前仅支持保留型环境')
    folder = folder.strip()
    if enabled:
        resolved = resolve_folder(folder)
        folder = resolved if folder else ''  # Empty is the portable bundled-resource sentinel.
    db.execute('INSERT INTO trace_inspector_settings(environment_id,enabled,folder) VALUES (?,?,?) ON CONFLICT(environment_id) DO UPDATE SET enabled=excluded.enabled,folder=excluded.folder', (eid, int(enabled), folder))

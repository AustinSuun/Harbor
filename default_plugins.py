"""Default extensions; official pinned download, local encrypted key, no solver API calls."""
import asyncio
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tempfile
import threading
import urllib.request
import uuid
from manager_credentials import encrypt_password, decrypt_password
from trace_inspector_bundle import verified_bundle

YES_VERSION = '1.4.7'
YES_URL = 'https://yescaptcha.atlassian.net/wiki/rest/api/content/25722881/child/attachment/att1364000786/download'
YES_SHA256 = 'fe7f65e1d20016a867eb83bcb238d5015a441276101fcab89dd2606d027693e4'
_install_lock = threading.Lock()


def initialize(db, data):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_plugin_settings'").fetchone():
        return
    if db.in_transaction:
        raise RuntimeError('插件设置迁移需要已提交事务')
    folder = Path(data)/'migration-backups';folder.mkdir(parents=True,exist_ok=True)
    target=sqlite3.connect(folder/('before-global-plugins-'+uuid.uuid4().hex+'.sqlite3'))
    try:db.backup(target)
    finally:target.close()
    with db:
        db.execute("CREATE TABLE global_plugin_settings (id INTEGER PRIMARY KEY CHECK(id=1), key_cipher TEXT NOT NULL)")
        db.execute("INSERT INTO global_plugin_settings VALUES (1,'')")


def settings(db):
    row=db.execute('SELECT key_cipher FROM global_plugin_settings WHERE id=1').fetchone()
    return {'configured':bool(row and row[0]),'default_loaded':True,'apply_on':'next_launch','yescaptcha_version':YES_VERSION}


def save_key(db, value=None, clear=False):
    if clear:
        if value:raise ValueError('清空密钥时不要同时输入新密钥')
        cipher=''
    elif value is None:
        return
    else:
        value=value.strip()
        if not 1<=len(value)<=4096 or any(ord(c)<33 or ord(c)>126 for c in value):
            raise ValueError('请输入有效 ClientKey，或使用清空密钥按钮')
        cipher=encrypt_password(value)
    with db:db.execute('UPDATE global_plugin_settings SET key_cipher=? WHERE id=1',(cipher,))


def key_value(db):
    row=db.execute('SELECT key_cipher FROM global_plugin_settings WHERE id=1').fetchone()
    return decrypt_password(row[0]) if row and row[0] else ''


def _runtime_files(raw):
    import zipfile
    if hashlib.sha256(raw).hexdigest()!=YES_SHA256:
        raise ValueError('官方插件下载校验不匹配，未安装；请更新 Harbor 后重试')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries=[i for i in archive.infolist() if not i.is_dir()]
        if len(entries)>1000 or sum(i.file_size for i in entries)>20*1024*1024:
            raise ValueError('插件压缩包超过安全限制')
        files={}
        for entry in entries:
            path=PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or ':' in entry.filename or entry.filename in files or (entry.external_attr>>16)&0o170000==0o120000:
                raise ValueError('插件压缩包路径无效')
            files[entry.filename]=archive.read(entry)
    manifest=json.loads(files['manifest.json'])
    if manifest.get('version')!=YES_VERSION or manifest.get('manifest_version')!=3:
        raise ValueError('插件版本不匹配')
    return files


def ensure_yescaptcha(data):
    """No vendor code goes to public repository/package; download once to user cache."""
    root=Path(data)/'plugin-cache';folder=root/('yescaptcha-'+YES_VERSION)
    with _install_lock:
        root.mkdir(parents=True,exist_ok=True)
        archive=root/('yescaptcha-'+YES_VERSION+'.zip')
        raw=archive.read_bytes() if archive.is_file() and archive.stat().st_size<=3*1024*1024 else None
        if raw is None or hashlib.sha256(raw).hexdigest()!=YES_SHA256:
            try:
                req=urllib.request.Request(YES_URL,headers={'User-Agent':'Harbor-plugin-installer'})
                with urllib.request.urlopen(req,timeout=45) as response:raw=response.read(3*1024*1024+1)
                if len(raw)>3*1024*1024:raise ValueError('too large')
                files=_runtime_files(raw)
            except Exception:
                raise ValueError('首次启动需联网从 YesCaptcha 官方安装插件；下载或校验失败，未启动浏览器，请检查网络后重试') from None
            staging=root/('download-'+uuid.uuid4().hex+'.tmp')
            try:staging.write_bytes(raw);staging.replace(archive)
            finally:staging.unlink(missing_ok=True)
        else:files=_runtime_files(raw)
        if folder.exists():
            actual={p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()}
            if folder.is_symlink() or actual!=set(files) or any(p.is_symlink() for p in folder.rglob('*')) or any((folder/name).read_bytes()!=value for name,value in files.items()):
                raise ValueError('YesCaptcha 缓存文件已变化；未加载未知代码，请退出所有环境后移除 plugin-cache 中的该插件目录并重试')
            return folder.resolve()
        stage=Path(tempfile.mkdtemp(prefix='install-',dir=root))
        try:
            for name,value in files.items():
                target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(value)
            stage.rename(folder)
        finally:
            if stage.exists():shutil.rmtree(stage)
        return folder.resolve()


async def launch_resources(data):
    trace=verified_bundle()
    yes=str(await asyncio.to_thread(ensure_yescaptcha,data))
    if any(c in yes+trace for c in (',','\n','\r')):
        raise ValueError('插件路径不能包含逗号或换行，请将 Harbor 放在不含这些字符的路径')
    joined=yes+','+trace
    return [f'--disable-extensions-except={joined}',f'--load-extension={joined}']


async def configure_context(context, key):
    """Run before opening sites. Never put the key in a URL, file, log, or exception."""
    try:
        async with asyncio.timeout(20):
            while True:
                for worker in context.service_workers:
                    if not worker.url.startswith('chrome-extension://'):continue
                    identity=await worker.evaluate("({version:chrome.runtime.getManifest().version,name:chrome.i18n.getMessage('name')||chrome.runtime.getManifest().name})")
                    if identity['version']!=YES_VERSION or 'yescaptcha' not in identity['name'].lower().replace(' ',''):continue
                    await worker.evaluate('''async key=>{
                        let config;
                        for(let i=0;i<100;i++){
                            config=(await chrome.storage.local.get('config')).config;
                            if(config)break;
                            await new Promise(resolve=>setTimeout(resolve,50));
                        }
                        if(!config)throw Error('configuration unavailable');
                        const next={...config,clientKey:key,host:'https://api.yescaptcha.com',autorun:!!key,isHideKey:true,allowJsInject:false};
                        await chrome.storage.local.set({config:next});
                        const saved=(await chrome.storage.local.get('config')).config;
                        if(saved.clientKey!==key||saved.autorun!==!!key)throw Error('configuration not saved');
                    }''',key)
                    return
                await asyncio.sleep(.1)
    except Exception:
        raise ValueError('YesCaptcha 密钥配置失败；浏览器未进入网站，请重新启动环境。密钥未写入日志') from None


def make_temporary_profile(data):
    folder=Path(data)/'temporary-plugin-profiles';folder.mkdir(parents=True,exist_ok=True)
    return Path(tempfile.mkdtemp(prefix='session-',dir=folder))


async def remove_temporary_profile(folder):
    if not folder:return
    for attempt in range(10):
        try:
            await asyncio.to_thread(shutil.rmtree,folder)
            return
        except FileNotFoundError:return
        except OSError:await asyncio.sleep(.2*(attempt+1))
    raise ValueError('临时资料目录清理失败，请退出浏览器后清理 temporary-plugin-profiles')

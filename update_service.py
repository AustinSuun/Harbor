"""Fixed-repository updater. Side-by-side installation; never overwrite user data.
SHA256 detects corrupt downloads; it is not a publisher code signature.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import time
import urllib.request
import uuid
import zipfile
from app_version import VERSION

REPO='https://github.com/AustinSuun/Harbor'
API='https://api.github.com/repos/AustinSuun/Harbor/releases?per_page=20'
MAX_ZIP=512*1024*1024
MAX_UNPACKED=2*1024**3


def version(value):
    match=re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)',str(value))
    return tuple(map(int,match.groups())) if match else None


def asset_url(url):
    return isinstance(url,str) and url.startswith(REPO+'/releases/download/') and '?' not in url and '#' not in url


def fetch(url,limit,destination=None):
    if url!=API and not asset_url(url):raise ValueError('不允许的更新来源')
    request=urllib.request.Request(url,headers={'User-Agent':'Harbor-Updater','Accept':'application/vnd.github+json' if url==API else 'application/octet-stream'})
    with urllib.request.urlopen(request,timeout=30) as response:
        if not response.geturl().startswith('https://'):raise ValueError('不安全的更新重定向')
        size=0;chunks=[]
        f=Path(destination).open('wb') if destination else None
        try:
            while True:
                block=response.read(1024*1024)
                if not block:break
                size+=len(block)
                if size>limit:raise ValueError('更新下载超过大小限制')
                if f:f.write(block)
                else:chunks.append(block)
        finally:
            if f:f.close()
    return b''.join(chunks) if not destination else size


def release_info(data,current=VERSION,allow_preview=True):
    latest=version(data.get('tag_name'));installed=version(current.split('-')[0])
    result={'current_version':current,'latest_version':data.get('tag_name',''),'available':False,'release_url':REPO+'/releases','package':None}
    result['prerelease']=bool(data.get('prerelease'))
    if not latest or not installed or data.get('draft') or (data.get('prerelease') and not allow_preview) or latest<=installed:return result
    assets=data.get('assets',[])
    zips=[a for a in assets if re.fullmatch(r'Harbor-Windows-x64-[A-Za-z0-9._-]+\.zip',a.get('name',''))]
    if len(zips)!=1:return result
    package=zips[0];checks=[a for a in assets if a.get('name')==package['name']+'.sha256']
    if len(checks)!=1 or not asset_url(package.get('browser_download_url')) or not asset_url(checks[0].get('browser_download_url')):return result
    result.update(available=True,release_url=REPO+'/releases/tag/'+data['tag_name'],package={'name':package['name'],'url':package['browser_download_url'],'checksum_url':checks[0]['browser_download_url']})
    return result


def extract_checked(archive,destination,digest):
    h=hashlib.sha256()
    with Path(archive).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    if h.hexdigest()!=digest.lower():raise ValueError('更新包 SHA256 校验失败')
    destination=Path(destination)
    with zipfile.ZipFile(archive) as z:
        infos=z.infolist();seen=set();total=0
        if len(infos)>20000:raise ValueError('更新包文件过多')
        for item in infos:
            name=item.filename;parts=PurePosixPath(name).parts
            total+=item.file_size
            if (not parts or parts[0]!='Harbor' or any(p in ('.','..') for p in parts)
                    or name.startswith('/') or '\\' in name or ':' in name
                    or name != '/'.join(parts)+('/' if name.endswith('/') else '')
                    or any(p.endswith((' ','.')) or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',p,re.I) for p in parts)
                    or stat.S_ISLNK(item.external_attr>>16) or total>MAX_UNPACKED):
                raise ValueError('更新包包含不安全路径或超出限制')
            lowered=name.rstrip('/').casefold()
            if lowered in seen:raise ValueError('更新包存在重复路径')
            seen.add(lowered)
            if any(p.lower() in ('profiles','session-profiles','migration-backups','file-probes') for p in parts) or name.lower().endswith(('.sqlite3','.sqlite3-wal','.sqlite3-shm')):
                raise ValueError('更新包不应包含用户资料')
        if 'harbor/harbor.exe' not in seen or 'harbor/distribution-manifest.json' not in seen:raise ValueError('更新包缺少程序或清单')
        z.extractall(destination)
    return destination/'Harbor'/'Harbor.exe'


class Updates:
    def __init__(self,data_dir):
        self.root=Path(data_dir)/'updates';self.cached=None;self.checked=0
        self.status={'phase':'idle','message':''}
    def check(self):
        if self.cached is not None and time.monotonic()-self.checked<1800:return self.cached
        try:
            data=json.loads(fetch(API,1024*1024))
            releases=[r for r in data if not r.get('draft') and version(r.get('tag_name'))]
            newest=max(releases,key=lambda r:version(r['tag_name'])) if releases else {}
            self.cached=release_info(newest)
            self.cached['error']=''
        except Exception:
            self.cached={'current_version':VERSION,'available':False,'release_url':REPO+'/releases','error':'更新检查失败，请稍后重试'}
        self.checked=time.monotonic();return self.cached
    def prepare(self,release):
        if not release.get('available') or not version(release.get('latest_version')):raise ValueError('没有可安装的新版本')
        self.root.mkdir(parents=True,exist_ok=True)
        staging=self.root/('staging-'+uuid.uuid4().hex);staging.mkdir()
        try:
            self.status={'phase':'downloading','message':'正在下载并校验更新包'}
            package=release['package'];name=package['name']
            checksum=fetch(package['checksum_url'],8192).decode('ascii').strip().split()
            if len(checksum)!=2 or not re.fullmatch(r'[0-9a-fA-F]{64}',checksum[0]) or checksum[1].lstrip('*')!=name:raise ValueError('校验文件与更新包不匹配')
            archive=staging/'package.zip';fetch(package['url'],MAX_ZIP,archive)
            exe=extract_checked(archive,staging/'unpacked',checksum[0])
            manifest=json.loads((exe.parent/'distribution-manifest.json').read_text(encoding='utf-8'))
            if version(manifest.get('application_version'))!=version(release['latest_version']):raise ValueError('包版本与发行版本不符')
            target=self.root/('version-'+release['latest_version'].lstrip('v')+'-'+uuid.uuid4().hex[:8])
            shutil.move(str(exe.parent),str(target))
            exe=target/'Harbor.exe'
            self.status={'phase':'ready','message':'更新已校验，准备切换；旧程序和用户资料保留'}
            return exe
        finally:
            shutil.rmtree(staging,ignore_errors=True)
    def schedule(self,exe,server_pid,new_version):
        exe=Path(exe).resolve()
        if not exe.is_relative_to(self.root.resolve()) or not exe.is_file():raise ValueError('无效更新目录')
        # New process starts only after the old server has gracefully released its port and DB lock.
        script=self.root/('switch-'+uuid.uuid4().hex+'.ps1')
        quote=lambda s:"'"+str(s).replace("'","''")+"'"
        script.write_text('Wait-Process -Id '+str(int(server_pid))+' -ErrorAction SilentlyContinue\nStart-Process -FilePath '+quote(exe)+'\n',encoding='utf-8-sig')
        process=subprocess.Popen(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script)],creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        pointer=self.root/'current.json';tmp=self.root/'current.tmp'
        tmp.write_text(json.dumps({'version':new_version,'executable':str(exe)}),encoding='utf-8');os.replace(tmp,pointer)
        return process.pid


def installed_update(data_dir,current=VERSION):
    root=(Path(data_dir)/'updates').resolve()
    try:
        data=json.loads((root/'current.json').read_text(encoding='utf-8'))
        if not version(data.get('version')) or version(data['version'])<=version(current):return None
        exe=Path(data['executable']).resolve()
        if exe.is_relative_to(root) and exe.name=='Harbor.exe' and exe.is_file():return exe
    except (OSError,ValueError,TypeError,KeyError):pass
    return None

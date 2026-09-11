"""Build a clean Windows x64 ZIP with Chromium; never copy project user data."""
from __future__ import annotations
import datetime
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import venv

BASE=Path(__file__).resolve().parent
WORK=BASE/'.packaging'
VENV=BASE/'.packaging-venv'


def command(args,env=None):
    print('\n> '+' '.join(map(str,args)),flush=True)
    subprocess.run([str(a) for a in args],cwd=str(BASE),env=env,check=True)


def conda_runtime_files(python):
    """Collect only native dependencies of Python's standard runtime, not a whole conda env."""
    base=Path(sys.base_prefix)
    lib=base/'Library'/'bin'
    if not (base/'conda-meta').is_dir():
        return [], []
    script=r"""
import json, sys, pefile
from pathlib import Path
base=Path(sys.base_prefix)
lib=base/'Library'/'bin'
lookup={p.name.lower():p for p in lib.glob('*.dll')}
seeds=['_lzma.pyd','_bz2.pyd','_decimal.pyd','_hashlib.pyd','_ssl.pyd','_ctypes.pyd','pyexpat.pyd','_sqlite3.pyd']
queue=[base/'DLLs'/n for n in seeds]+list(base.glob('python3*.dll'))
seen=set(); found={}
while queue:
    item=queue.pop()
    if item in seen or not item.is_file(): continue
    seen.add(item)
    with pefile.PE(str(item),fast_load=True) as pe:
        pe.parse_data_directories(directories=[1,13])
        for entry in list(getattr(pe,'DIRECTORY_ENTRY_IMPORT',[]))+list(getattr(pe,'DIRECTORY_ENTRY_DELAY_IMPORT',[])):
            name=entry.dll.decode('ascii').lower()
            if name in lookup:
                found[name]=lookup[name]
                queue.append(lookup[name])
print(json.dumps([str(found[n]) for n in sorted(found)]))
"""
    dlls=[Path(p) for p in json.loads(subprocess.check_output([str(python),'-c',script],text=True))]
    wanted={p.name.lower() for p in dlls}
    covered=set()
    notices=[]
    for path in (base/'conda-meta').glob('*.json'):
        meta=json.loads(path.read_text(encoding='utf-8'))
        owned={Path(f).name.lower() for f in meta.get('files',[])} & wanted
        if not owned: continue
        covered.update(owned)
        source=meta.get('link',{}).get('source')
        license_dir=Path(source)/'info'/'licenses' if source else None
        if license_dir and license_dir.is_dir():
            notices.append((meta['name'],license_dir))
        elif meta['name']=='libsqlite':
            notices.append(('libsqlite',None))
        else:
            raise RuntimeError('Missing native-library license: '+meta['name'])
    if wanted-covered:
        raise RuntimeError('Unidentified native-library licenses: '+', '.join(sorted(wanted-covered)))
    return dlls, notices


def main():
    if sys.platform!='win32' or platform.machine().lower() not in ('amd64','x86_64'):
        raise RuntimeError('此构建脚本须在 Windows x64 上运行，不能在 Linux 上生成 Windows 程序。')
    if shutil.disk_usage(BASE).free<2*1024**3:
        raise RuntimeError('构建需要至少约 2 GB 可用磁盘空间。')
    WORK.mkdir(exist_ok=True)
    python=VENV/'Scripts'/'python.exe'
    if not python.is_file():
        print('创建隔离打包环境，不修改日常 Python 依赖…',flush=True)
        venv.EnvBuilder(with_pip=True).create(VENV)
    command([python,'-m','pip','install','-r',BASE/'requirements-build.txt'])
    native_dlls,native_notices=conda_runtime_files(python)
    cache=WORK/'browser-downloads'
    env=os.environ.copy()
    env['PLAYWRIGHT_BROWSERS_PATH']=str(cache)
    env['PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT']='120000'
    command([python,'-m','playwright','install','chromium','--no-shell'],env=env)
    # Keep browser resources separate from the user's ordinary Playwright cache.
    bundle=WORK/'bundled-browsers'
    if bundle.exists(): shutil.rmtree(bundle)
    bundle.mkdir()
    for item in cache.iterdir():
        if item.is_dir() and not item.name.startswith('.'):
            shutil.copytree(item,bundle/item.name)
    if not list(bundle.glob('**/chrome.exe')):
        raise RuntimeError('下载结果中未找到 Chromium chrome.exe，停止构建。')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    release=BASE/'release'/('Harbor-Windows-x64-'+stamp)
    release.mkdir(parents=True)
    args=[python,'-m','PyInstaller','--noconfirm','--clean','--onedir','--console',
          '--name','Harbor','--distpath',release,'--workpath',WORK/'pyinstaller',
          '--specpath',WORK,'--contents-directory','_internal',
          '--add-data',str(BASE/'browser_manager.html')+os.pathsep+'.',
          '--add-data',str(bundle)+os.pathsep+'bundled-browsers',
          '--collect-all','playwright','--collect-submodules','uvicorn',
          '--hidden-import','pydantic_core','--hidden-import','uvicorn.protocols.http.h11_impl',
          '--hidden-import','uvicorn.lifespan.on']
    for package in ['playwright','fastapi','uvicorn','pydantic','pydantic_core','starlette','anyio']:
        args.extend(['--copy-metadata',package])
    for dll in native_dlls:
        args.extend(['--add-binary',str(dll)+os.pathsep+'.'])
    args.append(BASE/'harbor_launcher.py')
    command(args,env=env)
    app=release/'Harbor'
    missing=[p.name for p in native_dlls if not (app/'_internal'/p.name).is_file()]
    if missing:
        raise RuntimeError('Native DLLs missing from output: '+', '.join(missing))
    shutil.copy2(BASE/'DISTRIBUTION_README.txt',app/'使用说明.txt')
    shutil.copy2(BASE/'THIRD_PARTY_NOTICES.md',app/'THIRD_PARTY_NOTICES.md')
    # Record package versions, but not usernames, machine paths or account data.
    versions=json.loads(subprocess.check_output([str(python),'-c',
        "import importlib.metadata as m,json; print(json.dumps({n:m.version(n) for n in ['playwright','fastapi','uvicorn','pydantic','pyinstaller']}))"],text=True))
    manifest={'application':'Harbor','application_version':'0.3.0','platform':'Windows x64','created_at':stamp,
              'dependencies':versions,'browser_folders':[p.name for p in bundle.iterdir()],
              'native_libraries':[p.name for p in native_dlls],
              'plugins':False,'user_data_included':False,'runtime_validated':False,
              'data_directory':'%LOCALAPPDATA%/Harbor'}
    (app/'distribution-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    licenses=app/'third-party-licenses'
    licenses.mkdir(exist_ok=True)
    for name,source in native_notices:
        if source:
            shutil.copytree(source,licenses/name,dirs_exist_ok=True)
        else:
            (licenses/'SQLite-PUBLIC-DOMAIN.txt').write_text(
                'SQLite is in the public domain. https://www.sqlite.org/copyright.html\n',encoding='utf-8')
    license_text=None
    for name in ['LICENSE_PYTHON.txt','LICENSE.txt','LICENSE']:
        candidate=Path(sys.base_prefix)/name
        if candidate.is_file():
            text=candidate.read_text(encoding='utf-8',errors='replace')
            if 'PYTHON SOFTWARE FOUNDATION' in text.upper():
                license_text=text
                break
    if license_text is None:
        import urllib.request
        url='https://raw.githubusercontent.com/python/cpython/v'+platform.python_version()+'/LICENSE'
        with urllib.request.urlopen(url,timeout=30) as response:
            license_text=response.read().decode('utf-8')
        if 'PYTHON SOFTWARE FOUNDATION' not in license_text.upper():
            raise RuntimeError('无法获取 Python 许可证文本，未生成分发 ZIP。')
    (licenses/'Python-LICENSE.txt').write_text(license_text,encoding='utf-8')
    archive=Path(shutil.make_archive(str(release),'zip',root_dir=release,base_dir='Harbor'))
    (BASE/'release'/'LATEST.txt').write_text(str(archive)+'\n',encoding='utf-8')
    print('\nBUILD_COMPLETE',flush=True)
    print('程序：'+str(app/'Harbor.exe'),flush=True)
    print('分发包：'+str(archive),flush=True)
    print('ZIP 大小：'+str(round(archive.stat().st_size/1024**2,1))+' MB',flush=True)
    print('没有启动程序或浏览器进行测试；首次分发前需在干净 Windows 机器验收。',flush=True)


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print('\nBUILD_FAILED: '+str(exc),flush=True)
        raise SystemExit(1)

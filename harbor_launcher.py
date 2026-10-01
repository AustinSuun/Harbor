"""Windows distribution entry point; also runnable with python in the source tree."""
from __future__ import annotations
import json
import os
from pathlib import Path
import html
import traceback
from desktop_runtime import prepare_output, hidden_process_options
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from runtime_paths import DATA_DIR, FROZEN, RESOURCE_DIR, ensure_browser_resources

URL='http://127.0.0.1:8766'


def is_harbor_running():
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(URL+'/openapi.json',timeout=1) as response:
            data=json.load(response)
        return (str(data.get('info',{}).get('title','')).startswith('Harbor')
                and '/api/environments' in data.get('paths',{}))
    except Exception:
        return False


def open_manager():
    print('管理页面：'+URL,flush=True)
    try:
        if not webbrowser.open(URL,new=2):
            print('无法自动打开默认浏览器，请手动访问上述地址。',flush=True)
    except Exception as exc:
        print('打开页面失败，请手动访问上述地址：'+str(exc),flush=True)



def show_startup_error(message):
    """Use a local browser page, not a console prompt or native confirmation."""
    print(message,flush=True)
    if not FROZEN:return
    try:
        folder=DATA_DIR/'logs'
        try:folder.mkdir(parents=True,exist_ok=True)
        except OSError:
            import tempfile
            folder=Path(tempfile.mkdtemp(prefix='Harbor-startup-'))
        page=folder/f'startup-error-{os.getpid()}.html'
        page.write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Harbor 启动提示</title><style>body{font:18px system-ui;max-width:760px;margin:80px auto;padding:24px;line-height:1.8;color:#23463d}h1{color:#287b69}code{overflow-wrap:anywhere}</style><h1>Harbor 启动提示</h1><p>'+html.escape(message)+'</p><p>日志目录：<code>'+html.escape(str(folder))+'</code></p><p><a href="'+URL+'">访问管理页面</a></p></html>',encoding='utf-8')
        webbrowser.open(page.as_uri(),new=2)
    except Exception:
        traceback.print_exc()


def serve():
    ensure_browser_resources()
    import uvicorn
    from browser_manager import app
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=8766,workers=1,loop='asyncio',http='h11',ws='none'))
    app.state.request_exit=lambda:setattr(server,'should_exit',True)
    server.run()


def launch():
    if FROZEN:
        from update_service import installed_update
        newer=installed_update(DATA_DIR)
        if newer:
            subprocess.Popen([str(newer)],**hidden_process_options())
            return 0
    if is_harbor_running():
        print('管理器已经运行，直接打开页面。',flush=True)
        open_manager()
        return 0
    try:
        with socket.create_connection(('127.0.0.1',8766),timeout=1):
            show_startup_error('端口 8766 被其他服务占用。请检查占用程序；Harbor 不会强制结束它。')
            return 1
    except OSError:
        pass
    ensure_browser_resources()
    print('正在启动 Harbor…',flush=True)
    print('数据目录：'+str(DATA_DIR),flush=True)
    print('管理器在后台运行。退出时先保存并关闭环境，再点击网页右上角的退出管理器。',flush=True)
    command=[sys.executable,'--serve'] if FROZEN else [sys.executable,str(RESOURCE_DIR/'harbor_launcher.py'),'--serve']
    child=subprocess.Popen(command,**(hidden_process_options() if FROZEN else {}))
    try:
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if is_harbor_running():
                open_manager()
                return child.wait()
            code=child.poll()
            if code is not None:
                show_startup_error('后台服务启动失败，请查看日志目录中的 server 日志。')
                return code or 1
            time.sleep(0.4)
        show_startup_error('启动超过 60 秒。后台进程仍在运行，可稍后访问管理页面或查看日志；没有强制终止任何程序。')
        return child.wait()
    except KeyboardInterrupt:
        # Console Ctrl+C is delivered to both parent and child. Give uvicorn
        # time to close tasks and browser contexts before any forced fallback.
        print('\n正在退出，请等待浏览器保存数据…',flush=True)
        try:
            return child.wait(timeout=25)
        except (subprocess.TimeoutExpired,KeyboardInterrupt):
            print('退出超时，结束管理器进程。请下次启动时检查任务记录。',flush=True)
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
            return 1


if __name__=='__main__':
    # PyInstaller may need to intercept multiprocessing flags from dependencies.
    import multiprocessing
    multiprocessing.freeze_support()
    try:
        prepare_output(DATA_DIR,'server' if '--serve' in sys.argv else 'launcher',force=FROZEN)
        if '--self-test' in sys.argv:
            from manager_credentials import encrypt_password,decrypt_password
            from artifact_metrics import candidate_summary
            from yescaptcha_support import launch_args
            from app_version import VERSION
            ensure_browser_resources()
            assert decrypt_password(encrypt_password('Harbor isolated self-test'))=='Harbor isolated self-test'
            assert launch_args('persistent',False,'')==['--disable-extensions']
            assert candidate_summary('<html></html>',complete_validated=True)['line_limit']==150
            from trace_inspector_support import resolve_folder
            resolve_folder('')  # Verify the frozen/source runtime-only bundle, without loading a browser.
            console_window=None
            if sys.platform=='win32':
                import ctypes
                console_window=bool(ctypes.windll.kernel32.GetConsoleWindow())
            report={'version':VERSION,'packaged_imports':'passed','credential_roundtrip':'passed','real_accounts_used':False,'manager_started':False,'console_window':console_window,'standard_streams_ready':sys.stdout is not None and sys.stderr is not None}
            print(json.dumps(report),flush=True)
            if '--self-test-output' in sys.argv:
                output=Path(sys.argv[sys.argv.index('--self-test-output')+1])
                output.write_text(json.dumps(report),encoding='utf-8')
        elif '--serve' in sys.argv:
            serve()
        else:
            result=launch()
            raise SystemExit(result)
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as exc:
        traceback.print_exc()
        if '--serve' not in sys.argv:
            show_startup_error('Harbor 启动失败：'+str(exc))
        raise SystemExit(1)

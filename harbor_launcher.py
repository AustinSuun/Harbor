"""Windows distribution entry point; also runnable with python in the source tree."""
from __future__ import annotations
import json
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
            subprocess.Popen([str(newer)])
            return 0
    if is_harbor_running():
        print('管理器已经运行，直接打开页面。',flush=True)
        open_manager()
        return 0
    try:
        with socket.create_connection(('127.0.0.1',8766),timeout=1):
            print('端口 8766 被其他服务占用。请先检查占用程序；不会强制结束它。',flush=True)
            return 1
    except OSError:
        pass
    ensure_browser_resources()
    print('正在启动 Harbor…',flush=True)
    print('数据目录：'+str(DATA_DIR),flush=True)
    print('请保留此窗口。退出时先保存浏览器工作，再按 Ctrl+C。',flush=True)
    command=[sys.executable,'--serve'] if FROZEN else [sys.executable,str(RESOURCE_DIR/'harbor_launcher.py'),'--serve']
    child=subprocess.Popen(command)
    try:
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if is_harbor_running():
                open_manager()
                return child.wait()
            code=child.poll()
            if code is not None:
                print('启动失败，请查看上方错误信息。',flush=True)
                return code or 1
            time.sleep(0.4)
        print('启动超过 60 秒，请查看控制台日志。按 Ctrl+C 退出。',flush=True)
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
            print(json.dumps({'version':VERSION,'packaged_imports':'passed','credential_roundtrip':'passed','real_accounts_used':False,'manager_started':False}))
        elif '--serve' in sys.argv:
            serve()
        else:
            result=launch()
            if result and FROZEN:
                input('按回车关闭窗口…')
            raise SystemExit(result)
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as exc:
        print('Harbor 启动失败：'+str(exc),flush=True)
        if FROZEN and '--serve' not in sys.argv:
            input('按回车关闭窗口…')
        raise SystemExit(1)

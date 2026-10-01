"""Windowless Windows startup support; logs remain local, never in release assets."""
from __future__ import annotations
import io
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import sys

class LogStream(io.TextIOBase):
    """Provide real writable/isatty streams for print, tracebacks and Uvicorn."""
    def __init__(self,path):
        self.handler=RotatingFileHandler(path,maxBytes=2*1024*1024,backupCount=2,encoding='utf-8')
        self.handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
        # Disk failures must not recursively print back into this same stream.
        self.handler.handleError=lambda record:None
    @property
    def encoding(self):return 'utf-8'
    def writable(self):return True
    def isatty(self):return False
    def write(self,text):
        if text and text.strip():
            self.handler.handle(logging.LogRecord('harbor.desktop',logging.INFO,'',0,text.rstrip(),(),None))
        return len(text)
    def flush(self):self.handler.flush()


def prepare_output(data_dir,role='launcher',force=False):
    """PyInstaller --windowed sets stdout/stderr to None, even with PIPEs."""
    if not force and sys.stdout is not None and sys.stderr is not None:return None
    folder=Path(data_dir)/'logs'
    try:folder.mkdir(parents=True,exist_ok=True)
    except OSError:
        import tempfile
        folder=Path(tempfile.gettempdir())/'Harbor-startup-logs';folder.mkdir(parents=True,exist_ok=True)
    path=folder/f'{role}-{os.getpid()}.log'
    stream=LogStream(path)
    if force or sys.stdout is None:sys.stdout=stream
    if force or sys.stderr is None:sys.stderr=stream
    return path


def hidden_process_options():
    if sys.platform!='win32':return {}
    info=subprocess.STARTUPINFO()
    info.dwFlags|=subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow=subprocess.SW_HIDE
    return {'creationflags':subprocess.CREATE_NO_WINDOW,'startupinfo':info}

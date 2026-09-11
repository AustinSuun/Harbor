"""Separate immutable distribution resources from per-user browser data."""
from pathlib import Path
import os
import sys

FROZEN=bool(getattr(sys,'frozen',False))
RESOURCE_DIR=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))
BUNDLED_BROWSERS=RESOURCE_DIR/'bundled-browsers'

if os.environ.get('HARBOR_DATA_DIR'):
    DATA_DIR=Path(os.environ['HARBOR_DATA_DIR']).expanduser().resolve()
elif FROZEN:
    if sys.platform=='win32':
        DATA_DIR=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'AppData'/'Local')))/'Harbor'
    elif sys.platform=='darwin':
        DATA_DIR=Path.home()/'Library'/'Application Support'/'Harbor'
    else:
        DATA_DIR=Path(os.environ.get('XDG_DATA_HOME',str(Path.home()/'.local'/'share')))/'Harbor'
else:
    # Existing source users keep their original profiles, history and reviews.
    DATA_DIR=RESOURCE_DIR/'data'/'browser-manager'

if FROZEN:
    # Do not silently depend on a developer's browser cache or system Chrome.
    os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(BUNDLED_BROWSERS)


def ensure_browser_resources():
    if FROZEN and not BUNDLED_BROWSERS.is_dir():
        raise RuntimeError('内置浏览器文件缺失。请完整解压发行包，不要只复制 Harbor.exe。')

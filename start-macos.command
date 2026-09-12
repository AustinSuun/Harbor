#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This launcher is for macOS only."; exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "请先安装 Python 3.11 或更新版本，再重新运行。"; exit 1
fi
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ is required"'
export HARBOR_DATA_DIR="${HARBOR_DATA_DIR:-$HOME/Library/Application Support/Harbor}"
export PLAYWRIGHT_BROWSERS_PATH="$HARBOR_DATA_DIR/browser-binaries"
if [[ ! -x .venv-macos/bin/python ]]; then python3 -m venv .venv-macos; fi
.venv-macos/bin/python -m pip install -r requirements-macos.txt
.venv-macos/bin/python -m playwright install chromium
printf '\nHarbor macOS 源码服务：首次保存/读取凭据可能请求钥匙串授权。\n'
printf '数据目录：%s\n保留本窗口，按 Ctrl+C 退出。\n' "$HARBOR_DATA_DIR"
exec .venv-macos/bin/python harbor_launcher.py

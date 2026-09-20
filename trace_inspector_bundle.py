"""Versioned, runtime-only extension resources. No profile or capture files."""
from pathlib import Path
import hashlib
from runtime_paths import RESOURCE_DIR

BUNDLE_VERSION = '2.0.0'
FILE_HASHES = {'agent-detail-view.js': '3ad6e069088f17234c885e5b4152e28fa97e7282dcd3a672f7c276ac9725c61c', 'agent-detail.js': '1d93fcef9fa4d7e72ac982a20bc1cc1aae54a133fff20321ff4751351936a7f0', 'auto-draw.js': 'f673d4bad272d099d447ce4579cf4197d5d38e9911b11377f4108372e2cf6be3', 'background.js': '0f246610f9711079c0064db117ac48b9ced966b8bf69f2e521f7282412a0a0f5', 'battle-auto.js': '591e4541372b44f6354ee789567a5dc6b53da375352a1654de7db082ed33734a', 'battle-core.js': '5161d8286e9a00f117820d201d1d892b0ccd755e92bcdefff40405c0d9062939', 'battle-hud.js': '6074ad77b015734ea1c06b37c2f18610e83cb566952b4f8e6eff961b57354d91', 'battle-popup.js': '4ff03320fd376f8841e76df498956105a1284e1c99a2973af7cbb714bc0fb8a0', 'battle-trace-core.js': 'f8ea0e6c35711cc0d89c5b3ee228a132af3858d810389f4024f8c260dedd4a63', 'battle-trace-popup.js': '46b03909ee925fcb02103e06d0fdefe3094b43b74b1ed5efb3ffa1b54b4908a7', 'battle-trace-service.js': '0dfd24d4d9897441d36efe20ac713435305019136135f477dcb5cb0d4b450121', 'battle-trace-ui.js': '32327a4c1cd906b63daeababb577497cd2ef1696dc388a2d41e1ab0e0de5fc6a', 'billing-global.js': 'fcae42ad845b284ca7204404bb0c637f265a891559ddb7b956a3e2a2d3304f4f', 'billing.js': '5ee6109e765f99a683268729b9b22831c3e6908dbec25ec8e306ab5cd0484964', 'conversation-rename.js': '7736c38ff2addc846382d42a4aa4b6a8ff8362454f90659a96e6d1e8ee9c49db', 'core.js': '9a397acc0922884148c34c12d9a966dccc1373716e68120d9e9942818be4deaf', 'draw-prefs-global.js': '20a8d846f324b6a5111decee2b573ddb0f549208156dda62096efc9ea2a07d72', 'draw-prefs.js': '01d7008139314fc7aebd8141692bf0350a0b4f0f1cab85a8deff19ad7b392341', 'evidence.js': 'f442ae491e95259e21473ce375055b57d743ef4aac24e026d2e80b50fc5662ee', 'history.js': '27f7daa77e3eb34f35a3a197412f8f1af5fa5cb1ecba99706927365e20ee4f49', 'hud-layout.js': '47b1645f451dedf56da447030cb78c18535f9622dc51a2790d1ba27ea26d9639', 'hud-preferences.js': '659075a63e2b6ec72cf4139a59113991e011c7ffa819e1db4b21ef8fedf7648c', 'hud.js': '99abf46f1f59dd2ea7bd5e60b5302462f1f453f2e4a27853ba5d49899f324821', 'manifest.json': 'bda309bd4ab334dfc020cf4c60e5c25225271f198322ef0891b2f101ac34cbe8', 'model-label-global.js': 'd6e189c755595b9658ad1b18dfaef21c14d706a9d1d4a381f62e3a919a6a38c9', 'model-label.js': '8e024c9cc6dc7582712d46eedbde7f210e4c841154e9fa9b048cff2f2563a309', 'panel.js': 'e547fb18b85ca62ce5745d37b8d3cefb62ce4e502171bcff179bda5fae3186bd', 'popup.css': '1d3b9af6f7a8d3238e84331e20c4d11c5448ea64ff2a37527257547c6d4b91b5', 'popup.html': '5a77f0eac5a62d759b15a30d788bfb4d1812177edf54326aa40176bea04db0fb', 'popup.js': '0459cb0a442b35f77aca98d6474979aeb9fb0bffeab4f9d1e7496e4526687db5', 'restore.js': 'eb505149fe47557ea4f2aca68db47f0b46ff39b36c6f33802bb5b7eb4a81075d', 'usage.js': 'de90b0072cf03db0b89b2c8e2b25774654ef640320c1e8e56e76b0e3057774ee', 'view-model.js': '175f94d2ffb57291a1c1ac1103dd926989b0215474d39985cc28079d4d3aecc1'}


def verified_bundle(folder=None):
    root = Path(folder) if folder is not None else RESOURCE_DIR / 'extensions' / 'arena-trace-inspector'
    try:
        if root.is_symlink() or not root.is_dir():
            raise ValueError('missing bundle')
        if {p.name for p in root.iterdir()} != set(FILE_HASHES):
            raise ValueError('unexpected or missing files')
        for name, digest in FILE_HASHES.items():
            path = root / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 1048576:
                raise ValueError('invalid file')
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('modified file')
    except (OSError, ValueError):
        raise ValueError('内置 Trace Inspector 文件缺失或已改变。请完整解压官方 Harbor 分发包；不会回退到未知目录或自动下载。') from None
    return str(root.resolve())

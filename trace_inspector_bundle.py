"""Versioned, runtime-only extension resources. No profile or capture files."""
from pathlib import Path
import hashlib
from runtime_paths import RESOURCE_DIR

BUNDLE_VERSION = '2.3.0'
FILE_HASHES = {'agent-detail-view.js': '12f2296d00bdd0d1daee0fedc95d049ff4d5006885d08351c96e99e668bbfd23', 'agent-detail.js': 'f80cf8619b5de9e6e72a15bbc9589a6655613e8c1fcb07bc2864102f370df7c8', 'auto-draw.js': '61e880c4a114913f893fa59981b655ac3bb53a30f8a60081deeaefd9334ff855', 'background.js': 'e6c58510c4a4949b5adf59370bcae64c89456e57f2f1c9535766f75bbfc9287c', 'battle-auto.js': '591e4541372b44f6354ee789567a5dc6b53da375352a1654de7db082ed33734a', 'battle-core.js': '5161d8286e9a00f117820d201d1d892b0ccd755e92bcdefff40405c0d9062939', 'battle-hud.js': '6074ad77b015734ea1c06b37c2f18610e83cb566952b4f8e6eff961b57354d91', 'battle-popup.js': '4ff03320fd376f8841e76df498956105a1284e1c99a2973af7cbb714bc0fb8a0', 'battle-trace-core.js': 'f8ea0e6c35711cc0d89c5b3ee228a132af3858d810389f4024f8c260dedd4a63', 'battle-trace-popup.js': '46b03909ee925fcb02103e06d0fdefe3094b43b74b1ed5efb3ffa1b54b4908a7', 'battle-trace-service.js': '0dfd24d4d9897441d36efe20ac713435305019136135f477dcb5cb0d4b450121', 'battle-trace-ui.js': '32327a4c1cd906b63daeababb577497cd2ef1696dc388a2d41e1ab0e0de5fc6a', 'billing-global.js': '94143260f466305426286d69717a13a62e6769c1272183de0b386a203a736cb4', 'billing.js': 'cdc95dabf4cb77e777c2994ab5a738e54acd0f64547d85effb42e636d0119a17', 'catalog.js': 'ca47b027980e37ab76f343e506ce96c620192c3dae11b9b23d3bd54b7d6934cf', 'conversation-rename.js': '7736c38ff2addc846382d42a4aa4b6a8ff8362454f90659a96e6d1e8ee9c49db', 'core.js': '9a397acc0922884148c34c12d9a966dccc1373716e68120d9e9942818be4deaf', 'draw-prefs-global.js': '20a8d846f324b6a5111decee2b573ddb0f549208156dda62096efc9ea2a07d72', 'draw-prefs.js': '01d7008139314fc7aebd8141692bf0350a0b4f0f1cab85a8deff19ad7b392341', 'evidence.js': 'f442ae491e95259e21473ce375055b57d743ef4aac24e026d2e80b50fc5662ee', 'history.js': '92bd8c0142214e06c03d69faf0a0ae9528c2f9fceed650d976b130a8e16d5083', 'hud-layout.js': '47b1645f451dedf56da447030cb78c18535f9622dc51a2790d1ba27ea26d9639', 'hud-preferences.js': '659075a63e2b6ec72cf4139a59113991e011c7ffa819e1db4b21ef8fedf7648c', 'hud.js': 'abd6815faf30cfa91e17f11dd853d8a4f581e956fb7d33019f04679ca60e3f7b', 'manifest.json': 'ef7c5949761d9ca3554b92ec320d91d178234f80759ec2d84e1b11114b13b955', 'model-label-global.js': '472d94742c4a19a721c5822fb8ec0e634b55a58245905635d85e56b0e53cf6d5', 'model-label.js': '152fa8b274a11a65d0890bb28b8b1efdfd902aea59254f4017bc1eedff70dff5', 'panel.js': '70d40f079c1fc80ec3a2a34027e8525760228a597659fe2e873b9ba991005fef', 'popup.css': '1d3b9af6f7a8d3238e84331e20c4d11c5448ea64ff2a37527257547c6d4b91b5', 'popup.html': 'e4d13891a870a97c58337b1502e063321018925d216959cbceac93f81942cec1', 'popup.js': 'e78155b677e181cf0077bdf949f612b387035d3bdc7a6699ca59f1b66aa49236', 'restore.js': 'eb505149fe47557ea4f2aca68db47f0b46ff39b36c6f33802bb5b7eb4a81075d', 'usage.js': 'de90b0072cf03db0b89b2c8e2b25774654ef640320c1e8e56e76b0e3057774ee', 'view-model.js': 'd768f80bf6ef28e51c45eb3576a44c26619e092c4f715383fd37231953491689'}


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

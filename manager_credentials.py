"""Current Windows-user DPAPI protection. Never silently fall back to plaintext."""
import base64
import ctypes
from ctypes import wintypes
import sys
import uuid


class CredentialError(Exception):
    pass


def _protect(data, decrypt=False):
    if sys.platform != 'win32':
        raise CredentialError('当前凭据存储仅支持 Windows DPAPI；不支持的平台不会保存明文密码。')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise CredentialError('Windows 无法处理凭据；请使用原 Windows 用户或重新输入密码。')
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(ctypes.cast(output.data, ctypes.c_void_p))


def _mac_keychain():
    try:
        from keyring.backends.macOS import Keyring
        return Keyring()
    except Exception:
        raise CredentialError('macOS 钥匙串不可用；请安装 requirements-macos.txt，不会回退到明文存储') from None


def encrypt_password(password):
    if sys.platform=='darwin':
        token=uuid.uuid4().hex
        try:_mac_keychain().set_password('Harbor',token,password)
        except Exception:raise CredentialError('无法写入 macOS 钥匙串，请确认本机授权') from None
        return 'macos-keychain:'+token
    return base64.b64encode(_protect(password.encode('utf-8'))).decode('ascii')


def decrypt_password(ciphertext):
    if sys.platform=='darwin':
        if not ciphertext.startswith('macos-keychain:'):
            raise CredentialError('其他平台凭据不能直接迁移到 Mac，请重新保存密码')
        try:value=_mac_keychain().get_password('Harbor',ciphertext.split(':',1)[1])
        except Exception:raise CredentialError('无法读取 macOS 钥匙串，请确认本机授权') from None
        if value is None:raise CredentialError('钥匙串凭据不存在，请重新保存密码')
        return value
    try:
        return _protect(base64.b64decode(ciphertext, validate=True), True).decode('utf-8')
    except CredentialError:
        raise
    except Exception:
        raise CredentialError('凭据损坏，请重新保存密码。') from None

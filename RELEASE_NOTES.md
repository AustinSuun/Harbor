# Harbor v0.2.0 — Windows 内置浏览器预览版

## 下载使用

下载 `Harbor-Windows-x64-20260911-145801.zip`，完整解压后双击 `Harbor.exe`。不要只复制 EXE，必须保留 `_internal`。无需安装 Python 或另行下载 Chromium。

GitHub 自动附带的 Source code 压缩包只是源码，不是可直接运行的 Windows 发行包。

## 本次内容

- 独立启动器与内置 Chromium。
- 多环境管理、鹈鹕动画与 HTML/CSS 复刻任务。
- 任务记录、截图和独立人工审核。
- 移除插件功能、三题数字任务及 Thinking 自动操作。
- 补齐 Miniforge 构建时所需的 SQLite、SSL 等本地 DLL 及第三方许可材料。

## 数据与限制

- 不附带开发者账号、登录资料、数据库或历史记录；接收者自行创建环境并登录。
- 用户数据保存在 `%LOCALAPPDATA%\Harbor`，与程序目录分离。
- 本机已有管理器运行时会打开已有实例；换用新版前先退出旧版。
- Windows x64 桌面环境，程序未代码签名。
- **仅完成构建和静态检查，未执行功能测试或干净 Windows 机器运行验收。此版本标记为预览版。**
- 网站兼容性可能随页面变化；停止调度不等于停止网站生成。

## ZIP 校验

SHA-256：

```text
71c9c3b0e5be7bac96f11e78ab3d122c581b910a592f3436df63357e7ab2e9b5
```

同名 `.zip.sha256` 文件也随 Release 提供。

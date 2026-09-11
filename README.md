# Harbor

本地运行的账号、浏览器环境与任务管理工具。支持加密保存凭据、自动登录、保留型/临时无痕环境、任务调度及历史审核。

> **v0.3.5 预览版**：已完成 Windows 打包及静态检查，未执行功能测试或干净机器运行验收。网站页面变化可能影响自动化，请先小规模人工确认。Harbor 是独立工具，与 Arena.ai 无官方关联。

## 下载与启动（Windows x64）

前往 [Releases](https://github.com/AustinSuun/Harbor/releases)，下载 `Harbor-Windows-x64-*.zip`，而不是 GitHub 自动生成的 Source code 压缩包。

1. **完整解压** ZIP。
2. 双击文件夹中的 `Harbor.exe`。
3. 管理页面会在系统默认浏览器打开：`http://127.0.0.1:8766`。
4. 默认进入账号管理：添加邮箱密码，选择新建保留环境或临时无痕环境并启动。
5. 登录后选择自动任务；自动识别不确定时，核对账号后可人工确认。

发行包已包含 Python 运行时及配套 Chromium，不需另行安装。必须保留 `_internal` 文件夹，不能只复制 EXE。账号环境由内置 Chromium 打开；管理页面使用系统默认浏览器。

程序尚未代码签名，Windows 可能提示未知发布者。请核实下载来源，可用 Release 中的 SHA-256 校验文件确认 ZIP 完整性。

## 功能

- 账号独立管理，密码使用 Windows 当前用户 DPAPI 加密（不支持明文回退）。
- 保留型环境保存登录资料；临时无痕环境关闭后丢弃配置及会话，账号和历史记录保留。
- 最多同时运行 6 个环境。新创建的环境显示在最上方，同名环境自动添加 `(2)`、`(3)` 等编号。
- 账号列表直接展示备注。
- 头像邮箱识别忽略大小写，区分完整邮箱核验与截断前缀识别；仍需实机确认兼容性。
- 鹈鹕动画、鹈鹕测试快速版、火柴人大战、纯 HTML + CSS 复刻四种固定任务；选择时展示介绍、观察要点及离线参考效果图，支持展开大图。
- 每轮任务数 1–50、间隔 3–3600 秒、并行数 1–3；并行名额覆盖发送及等待回复阶段。
- 任务记录、可选截图、人工评分、星标、标签、备注与导出。
- **不加载插件**，不提供三题数字任务或 Thinking 自动停止/归档功能。

操作按钮点击即执行，不再二次弹窗确认；开始任务即授权发送本轮题目。删除环境资料不可恢复。停止任务仅停止管理器的调度与跟踪，不会撤回内容或自动停止网站正在生成的回复。不要使用本工具绕过网站限制；请遵守目标网站的使用条款及适用规则。

## 试题介绍与参考效果

快速版保留用户的直接写文件提示词，展示执行要求与普通鹈鹕参考图；不会据此自动判定 Thinking 或淘汰模型。在「自动任务」中切换题目，即可查看鹈鹕优劣对照、火柴人 SMIL 动画或 CSS 多模型复刻图。图示整理自 [ShunCode · 抽卡判断](https://docs.shuncode.top/docs/advanced/gacha/)，保留原始标注；属于第三方参考，不是 Harbor 实测，也不用于认定模型身份或排名。图片内置，可离线查看。详见 [内置介绍说明](BROWSER_MANAGER.md#v034内置试题介绍与效果图)。

## 数据与退出

- 发行版数据：`%LOCALAPPDATA%\Harbor`。
- 源码模式数据：仓库下的 `data/browser-manager/`。
- 可通过 `HARBOR_DATA_DIR` 指定其他数据目录。
- 发布的源码与发行包不附带开发者的账号、登录资料、数据库、任务记录或截图。
- 环境隔离不等于操作系统隔离或指纹伪装。请保护本机用户数据目录，不要上传或共享它。

保存浏览器工作后，在控制台按 **Ctrl+C** 并等待退出。关闭管理网页不会关闭服务。如果已有 Harbor 占用 8766 端口，启动器会打开已有管理器，因此在自己的电脑看见旧账号不代表发行包包含账号。使用新版前先退出旧进程；不要同时运行新旧版本。

管理器仅供本机使用，不要将端口暴露到公网。删除程序目录不会自动删除用户数据。

## 从源码运行

需要 Python 3.10+ 和桌面环境。在仓库根目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe harbor_launcher.py
```

完成依赖安装后，也可双击 `一键启动.bat`。详细操作见 [BROWSER_MANAGER.md](BROWSER_MANAGER.md)。

## 构建 Windows 发行包

在 Windows x64 上双击 `构建Windows发行包.bat`，或执行：

```powershell
python build_windows.py
```

脚本创建隔离的 `.packaging-venv`，下载配套 Chromium，并使用 PyInstaller 生成文件夹及 ZIP。输出在 `release/`，最新 ZIP 路径记录在 `release/LATEST.txt`。构建需要网络和足够磁盘空间。使用 Miniforge/Conda 时，脚本还会收集所需本地 DLL 及许可证；请保留对应包缓存中的许可证文件。

构建不会自动启动程序、浏览器或发送任务；构建成功不等于通过运行验收。发布时只上传程序 ZIP，不要把使用后的数据目录或整个开发项目上传。

## 第三方组件

参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 及发行包中的第三方许可证。第三方软件的原有许可条款继续适用。

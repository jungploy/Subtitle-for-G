# Subtitle-for-G · 字幕双语编辑器

一个**左右分栏、逐行对应**的字幕翻译工具：左边原文、右边翻译，每一行严格对齐；
无论你点选左边还是右边的任意一行，两侧对应的行都会**同步高亮并滚动到视野中央**，对照一目了然。

- 支持 **SRT** 字幕（解析时间轴与文本）
- **打开即智能识别双语字幕**：若 SRT 中每个字幕块含两行且分属不同文字体系（如原文拉丁文 / 译文中日韩文），自动把第一行归原文、第二行归译文，**分列左右两侧**，无需手动拆分；普通单语 SRT 不会误拆
- 原文 / 翻译**均可编辑**（方便校对与补全）
- 翻译可**手动输入**，也能**一键调用 AI**（OpenAI / DeepL），还内置**免费无需 Key 的 MyMemory** 引擎
- 可导出**翻译版 SRT** 或**双语 SRT**
- 提供 **Python（pywebview）桌面端**：打包为**单个 `.exe`**，底层用系统自带的 Edge WebView2，**无需 Rust / Visual Studio**，翻译在本地进程完成，无 CORS、不暴露 key
- （另有 **Tauri（Rust）** 桌面端方案，见文末「备选方案」）

## 核心交互

| 操作 | 效果 |
| --- | --- |
| 点击左侧某行 | 该行高亮，右侧对应行同步高亮并滚到中央 |
| 点击右侧某行 | 该行高亮，左侧对应行同步高亮并滚到中央 |
| 在任一文本框输入 | 实时写入数据，两侧行高自动对齐（严格逐行对应） |
| 翻译全部 / 翻译选中行 | 调用所选引擎，结果回填到右侧对应行 |

## 技术栈

- 前端：**原生 JavaScript（ES Modules）+ HTML + CSS**，零构建、零依赖
- 预览 / 开发：任意静态服务器（如 `python -m http.server` 或自带 `npm run dev`）
- 翻译逻辑：`server/translate-core.cjs`（Web 代理共用）；Web 原型由 `server/translate-proxy.mjs` 转发
- 桌面化（**主方案 · Python**）：**pywebview** —— 用系统自带的 Edge WebView2 开原生窗口，Python 本地进程完成翻译与文件读写，**无需 Rust / VS**，一条 `pyinstaller` 命令出单个 `.exe`
- （备选：Tauri 2（Rust）方案见文末）

## 目录结构

```
Subtitle-for-G/
├── index.html                 # 页面与工具栏
├── style.css                  # 样式（分栏、选中高亮、响应式）
├── src/
│   ├── srt.js                 # SRT 解析 / 序列化
│   ├── editor.js              # 双语编辑器（选中联动 + 滚动对齐 + 编辑）
│   ├── translate.js           # 翻译抽象层（自动识别 pywebview / Tauri / 浏览器）
│   └── app.js                 # 应用主逻辑（加载/导出/翻译按钮）
├── server/
│   ├── translate-core.cjs     # 翻译核心逻辑（Web 与桌面共用）
│   └── translate-proxy.mjs    # 本地翻译代理（仅 Web 原型用；桌面端走 Rust，不经此代理）
├── electron/server.cjs        # 仅用于 `npm run dev` 起一个静态开发服务器
├── python_app/                # Python(pywebview) 桌面壳
│   ├── main.py                # 本地服务器 + pywebview 窗口 + 暴露 translate/open_file/save_as
│   └── requirements.txt       # pywebview, pyinstaller
├── build-exe.bat              # 一键打包单文件 .exe（Python 方案）
├── scripts/
│   ├── build-frontend.cjs     # 复制前端到 dist/（打包用）
│   └── make-icon.cjs          # 生成 Tauri 图标（无第三方依赖）
├── sample.srt                 # 示例字幕
└── src-tauri/                 # Tauri 桌面工程（Rust）
    ├── tauri.conf.json        # 窗口 / 打包 / 注入全局 __TAURI__
    ├── capabilities/default.json
    ├── Cargo.toml
    ├── build.rs
    ├── icons/                 # 由 scripts/make-icon.cjs 生成
    └── src/main.rs            # 入口 + translate / read_file / write_file 命令（Rust 内调用 API 与文件读写）；已注册 tauri-plugin-dialog
```

## 快速开始（浏览器预览）

```bash
cd Subtitle-for-G
python -m http.server 8000
# 打开 http://localhost:8000
```

打开后自动加载 `sample.srt`。你也可以点「打开」选择本地 `.srt` 文件，或直接把文件**拖拽**到窗口里。

## 翻译接入

顶部工具栏选「翻译引擎」并填写 API Key / 模型：

| 引擎 | 说明 |
| --- | --- |
| 手动 | 直接在右侧文本框输入翻译 |
| 演示(mock) | 不联网，给每行加 `[译]` 前缀，用于体验完整流程 |
| 免费 MyMemory | 公共免费翻译 API，**无需 Key**，默认引擎，适合快速出稿 |
| OpenAI | 桌面端由 Rust 本地调用；Web 原型走本地代理 |
| DeepL | 桌面端由 Rust 本地调用；Web 原型走本地代理 |

> Web 原型用真实翻译（OpenAI / DeepL）时需先起代理：
> ```bash
> node server/translate-proxy.mjs        # http://localhost:8787
> # 可选：export OPENAI_API_KEY=sk-xxx / export DEEPL_API_KEY=xxxx
> ```
> 桌面端（Tauri）**不需要代理**——翻译在 Rust 进程里直接调用，key 只存在你本机内存。

## 桌面版（Python pywebview，推荐 · 单文件可执行）

把网页套一个轻量 Python 壳，编译为**原生窗口应用**，产物是单个 `.exe`。
底层用系统自带的 **Edge WebView2**（Win10/11 已预装，无需下载 Electron 那一百多 MB），
**不需要 Rust、不需要 Visual Studio**。翻译与文件打开/保存都在 Python 本地进程完成，API Key 只留存本机内存。

### 1. 安装前置（一次性）
- **Python 3.10+**：https://www.python.org （安装时勾选 "Add python.exe to PATH"）
- **Node**：仅用于生成前端 `dist/`（参与构建，不参与运行）；若已装可跳过
- 系统 **WebView2 Runtime**：Win10/11 已自带；没有就从微软官网装

### 2. 一键构建（双击 `build-exe.bat` 即可）
```bash
cd Subtitle-for-G
build-exe.bat
```
脚本会自动：建虚拟环境 → `pip install -r python_app/requirements.txt` → `npm run build` →
把前端拷进 `python_app/dist` → `pyinstaller --onefile --windowed` 出包。

> 想手动分步也行：
> ```bash
> python -m venv .venv && call .venv\Scripts\activate.bat
> pip install -r python_app/requirements.txt
> npm run build
> xcopy /E /I /Y dist\* python_app\dist\
> pyinstaller --noconfirm --onefile --windowed --name Subtitle-for-G ^
>   --distpath build_exe --workpath build_tmp --add-data "python_app\dist;dist" python_app\main.py
> ```

### 3. 产物位置
```
build_exe\Subtitle-for-G.exe     <-- 单文件可执行，可直接双击运行/分发（无需安装 Python）
```

### 4. 开发预览（不打包，直接跑）
```bash
npm run build
python python_app/main.py        # 直接开原生窗口加载本地前端
```

### 使用
桌面端里操作与网页版完全一致：载入示例 / 「打开」SRT（或把文件拖进窗口）→ 编辑 →
选引擎翻译（默认免费 MyMemory，无需 Key）→ 导出译文版 / 双语版。
「打开」「导出」弹出系统**文件对话框**，文件读写都在 Python 进程内完成，路径不离开本机。

## 备选方案：桌面版（Tauri，Rust）

若你偏好 Rust 技术栈，也可用 **Tauri 2** 编译为单个 `.exe`（需要 Rust 工具链 + C++ 构建工具 + WebView2）：

```bash
npm install
npm run icons
npm run build
npm run tauri:build          # 产物：src-tauri/target/release/Subtitle-for-G.exe
```
> 注意：Tauri 编译需要本机具备 Rust + MSVC 链接器，环境门槛比 Python 方案高。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能 · `fix:` 修复 · `docs:` 文档 · `chore:` 构建/杂项

## 许可证

MIT

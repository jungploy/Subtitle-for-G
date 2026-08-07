# Subtitle-for-G · 字幕双语编辑器

一个**左右分栏、逐行对应**的字幕翻译工具：左边原文、右边翻译，每一行严格对齐；
无论你点选左边还是右边的任意一行，两侧对应的行都会**同步高亮并滚动到视野中央**，对照一目了然。

- 支持 **SRT** 字幕（解析时间轴与文本）
- 原文 / 翻译**均可编辑**（方便校对与补全）
- 翻译可**手动输入**，也能**一键调用 AI**（OpenAI / DeepL），还内置**免费无需 Key 的 MyMemory** 引擎
- 可导出**翻译版 SRT** 或**双语 SRT**
- 提供 **Tauri（Rust）桌面端**：编译为**单个原生可执行文件**，翻译在本地进程完成，无 CORS、不暴露 key

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
- 桌面化：**Tauri 2（Rust）** —— 原生窗口 + Rust 本地进程调用翻译 API，编译为单个 `.exe`

## 目录结构

```
Subtitle-for-G/
├── index.html                 # 页面与工具栏
├── style.css                  # 样式（分栏、选中高亮、响应式）
├── src/
│   ├── srt.js                 # SRT 解析 / 序列化
│   ├── editor.js              # 双语编辑器（选中联动 + 滚动对齐 + 编辑）
│   ├── translate.js           # 翻译抽象层（自动识别 Tauri / 浏览器）
│   └── app.js                 # 应用主逻辑（加载/导出/翻译按钮）
├── server/
│   ├── translate-core.cjs     # 翻译核心逻辑（Web 与桌面共用）
│   └── translate-proxy.mjs    # 本地翻译代理（仅 Web 原型用；桌面端走 Rust，不经此代理）
├── electron/server.cjs        # 仅用于 `npm run dev` 起一个静态开发服务器
├── scripts/
│   ├── build-frontend.cjs     # 复制前端到 dist/（Tauri 打包用）
│   └── make-icon.cjs          # 生成 Tauri 图标（无第三方依赖）
├── sample.srt                 # 示例字幕
└── src-tauri/                 # Tauri 桌面工程（Rust）
    ├── tauri.conf.json        # 窗口 / 打包 / 注入全局 __TAURI__
    ├── capabilities/default.json
    ├── Cargo.toml
    ├── build.rs
    ├── icons/                 # 由 scripts/make-icon.cjs 生成
    └── src/main.rs            # 入口 + translate 命令（Rust 内调用 API）
```

## 快速开始（浏览器预览）

```bash
cd Subtitle-for-G
python -m http.server 8000
# 打开 http://localhost:8000
```

打开后自动加载 `sample.srt`。你也可以点「上传」选择本地 `.srt` 文件。

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

## 桌面版（Tauri，推荐 · 单文件可执行）

把网页直接编译为**原生窗口应用**，产物是单个 `.exe`（Windows 上还依赖系统自带的 WebView2，Win10/11 已预装）。

### 1. 安装前置依赖（一次性）
- **Rust 工具链**：https://rustup.rs （安装后确保 `cargo` 可用）
- **系统 WebView2**：Win10/11 通常已自带；否则从微软官网装 "WebView2 Runtime"
- **C++ 构建工具**（Windows）：装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 勾选「使用 C++ 的桌面开发」
- **Node**（仅用于跑脚本生成 dist/ 与图标，不参与运行）

### 2. 安装并构建
```bash
cd Subtitle-for-G
npm install                 # 仅装 @tauri-apps/cli（小体积）
npm run icons              # 生成 src-tauri/icons 下的图标（可选，已生成过可跳过）
npm run build              # 复制前端到 dist/（Tauri 打包需要）
npm run tauri:build        # 编译 Rust → 产出单文件可执行
```

### 3. 产物位置
```
src-tauri/target/release/Subtitle-for-G.exe     <-- 这就是单文件可执行，可直接双击运行/分发
src-tauri/target/release/bundle/...             # 同时还会生成安装包（msi/nsis），不需要可忽略
```

### 4. 开发预览（热重载窗口）
```bash
npm run tauri:dev
```

### 使用
桌面端里操作与网页版完全一致：载入示例/上传 SRT → 编辑 → 选引擎翻译（默认免费 MyMemory，无需 Key）→ 导出译文版/双语版。
导出会弹出系统保存对话框，落到你选的位置。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能 · `fix:` 修复 · `docs:` 文档 · `chore:` 构建/杂项

## 许可证

MIT

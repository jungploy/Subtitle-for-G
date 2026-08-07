# Subtitle-for-G · 字幕双语编辑器

一个**左右分栏、逐行对应**的字幕翻译工具：左边原文、右边翻译，每一行严格对齐；
无论你点选左边还是右边的任意一行，两侧对应的行都会**同步高亮并滚动到视野中央**，对照一目了然。

- 支持 **SRT** 字幕（解析时间轴与文本）
- 原文 / 翻译**均可编辑**（方便校对与补全）
- 翻译可**手动输入**，也可**一键调用 AI**（OpenAI / DeepL）
- 可导出**翻译版 SRT** 或**双语 SRT**
- 桌面端用 **Tauri** 打包（Rust 端安全保管 API key、调用翻译）

## 核心交互

| 操作 | 效果 |
| --- | --- |
| 点击左侧某行 | 该行高亮，右侧对应行同步高亮并滚到中央 |
| 点击右侧某行 | 该行高亮，左侧对应行同步高亮并滚到中央 |
| 在任一文本框输入 | 实时写入数据，两侧行高自动对齐（严格逐行对应） |
| 翻译全部 / 翻译选中行 | 调用所选引擎，结果回填到右侧对应行 |

## 技术栈

- 前端：**原生 JavaScript（ES Modules）+ HTML + CSS**，零构建、零依赖
- 预览 / 开发：任意静态服务器（如 `python -m http.server`）
- 翻译（Web 原型）：本地 **Node 代理** `server/translate-proxy.mjs` 转发，key 不进浏览器
- 桌面化：**Tauri 2**（Rust 端负责文件读写与翻译调用）

## 目录结构

```
Subtitle-for-G/
├── index.html                 # 页面与工具栏
├── style.css                  # 样式（分栏、选中高亮、响应式）
├── src/
│   ├── srt.js                 # SRT 解析 / 序列化
│   ├── editor.js              # 双语编辑器（选中联动 + 滚动对齐 + 编辑）
│   ├── translate.js           # 翻译抽象层（manual/mock/openai/deepl）
│   └── app.js                 # 应用主逻辑（加载/导出/翻译按钮）
├── server/
│   └── translate-proxy.mjs    # 本地翻译代理（Web 原型用）
├── sample.srt                 # 示例字幕
└── src-tauri/                 # 桌面化配置（Tauri 2）
    ├── tauri.conf.json
    ├── Cargo.toml
    ├── build.rs
    └── src/main.rs
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
| OpenAI | 走本地代理调用 OpenAI 兼容接口 |
| DeepL | 走本地代理调用 DeepL 接口 |

### Web 原型使用真实翻译（OpenAI / DeepL）

真实翻译经本地代理转发，**API key 只存在你本机**，不暴露给前端：

```bash
# 需要 Node 18+
node server/translate-proxy.mjs
# 监听 http://localhost:8787

# 可选：用环境变量注入 key，前端就不必手填
export OPENAI_API_KEY=sk-xxxx        # OpenAI
export DEEPL_API_KEY=xxxx            # DeepL
```

代理起来后，在网页选对应引擎、填 key（或留空走环境变量），点「翻译全部」即可。

## 桌面化打包（Tauri）

前端是纯静态文件，可直接用 Tauri 包成 Windows / macOS 窗口应用。
桌面端由 Rust 在本地调用翻译 API，key 更安全，且能直接读写字幕文件。

1. 安装 [Rust](https://www.rust-lang.org/) 与 [Tauri 预置依赖](https://v2.tauri.app/start/prerequisites/)
2. 安装前端 CLI：`npm install`（或直接用现有静态文件，无需构建）
3. 开发预览：`npm run tauri dev`
4. 打包成安装包：`npm run tauri build`

`src-tauri/src/main.rs` 已预留 `translate` 命令（前端用 `window.__TAURI__.invoke('translate', ...)` 调用）。
把里面的 `reqwest` 调用补全即可对接 OpenAI / DeepL；文件打开/保存可接 Tauri 的 `dialog` 插件。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能 · `fix:` 修复 · `docs:` 文档 · `chore:` 构建/杂项

## 许可证

MIT

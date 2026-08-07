# Subtitle-for-G · 字幕双语编辑器

一个**左右分栏、逐行对应**的字幕翻译工具：左边原文、右边翻译，每一行严格对齐；
无论你点选左边还是右边的任意一行，两侧对应的行都会**同步高亮并滚动到视野中央**，对照一目了然。

- 支持 **SRT** 字幕（解析时间轴与文本）
- 原文 / 翻译**均可编辑**（方便校对与补全）
- 翻译可**手动输入**，也能**一键调用 AI**（OpenAI / DeepL），还内置**免费无需 Key 的 MyMemory** 引擎
- 可导出**翻译版 SRT** 或**双语 SRT**
- 提供 **Electron 桌面端**（原生窗口，翻译在本地进程完成，无 CORS、不暴露 key）

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
- 翻译（Web / 桌面共用）：`server/translate-core.cjs` 统一逻辑；Web 原型由 `server/translate-proxy.mjs` 转发，key 不进浏览器
- 桌面化：**Electron**（原生窗口 + 内嵌本地服务，零 Rust 依赖）
- （`src-tauri/` 为早期 Tauri 试验配置，可忽略）

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
│   ├── translate-core.cjs     # 翻译核心逻辑（Web 与桌面共用）
│   └── translate-proxy.mjs    # 本地翻译代理（Web 原型用）
├── electron/
│   ├── main.js                # 桌面入口：打开原生窗口
│   └── server.cjs             # 内嵌本地服务（静态文件 + /api/translate）
├── sample.srt                 # 示例字幕
└── src-tauri/                 # （可选）早期 Tauri 试验配置，可忽略
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

## 桌面版（Electron，推荐）

把上面的网页直接包成**原生窗口**应用：翻译在本地进程完成（不走外部代理、不暴露 key、无 CORS），
文件打开用系统原生对话框，保存走浏览器下载。只需 Node，无需安装 Rust。

```bash
cd Subtitle-for-G
npm install          # 安装 electron（仅需一次，约 100MB）
npm start            # 启动桌面程序（自动开一个原生窗口加载应用）
```

构建可分发的安装包（可选）：

```bash
npm run dist         # 由 electron-builder 产出对应平台的安装包
```

> 说明：桌面端内嵌服务默认也用 `http://localhost:8787`，前端代码**无需任何改动**。
> 保存字幕会落到系统「下载」文件夹（如需原生「另存为」对话框，后续可接入 `electron.dialog`）。
> 当前默认引擎即「免费 MyMemory」，开箱即可一键翻译，无需任何 Key。

## 桌面化打包（Tauri，可选）

早期还试过用 Tauri 2（Rust）打包，配置留在 `src-tauri/`，但本项目当前桌面方案以 Electron 为主，
该目录可忽略，或自行补全 `translate` 命令与 `dialog` 插件后使用。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能 · `fix:` 修复 · `docs:` 文档 · `chore:` 构建/杂项

## 许可证

MIT

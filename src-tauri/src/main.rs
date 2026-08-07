// src-tauri/src/main.rs
// 桌面端入口。负责：窗口、文件打开/保存、翻译命令（在本地安全调用 API，key 不进前端）。
// 注：本文件在你的本地 Rust 环境中编译（需要 `cargo` 与系统 WebView）。
// 沙箱环境未编译验证，仅提供可直接使用的骨架。

use tauri::Manager;

#[derive(serde::Serialize)]
struct TranslateRequest {
    lines: Vec<String>,
    provider: String,
    api_key: String,
    model: String,
}

/// 翻译命令：由前端 window.__TAURI__.invoke('translate', ...) 调用。
/// 真实实现请用 reqwest 调用 OpenAI / DeepL（参考 README 的 Rust 片段）。
/// 这里先返回错误，提醒接入网络调用，避免无网络时编译失败。
#[tauri::command]
async fn translate(req: TranslateRequest) -> Result<Vec<String>, String> {
    let _ = req;
    Err("桌面端翻译命令请接入 reqwest 调用 OpenAI/DeepL（详见 README 的 Rust 示例）".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![translate])
        .run(tauri::generate_context!())
        .expect("error while running Subtitle-for-G");
}

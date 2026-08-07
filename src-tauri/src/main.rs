// src-tauri/src/main.rs
// Tauri 2 桌面端入口：窗口 + 翻译命令（在本地 Rust 进程内调用翻译 API）。
// 翻译命令由前端 window.__TAURI__.core.invoke('translate', ...) 调用。
// 注：本文件在你的本地 Rust 环境中编译（需要 cargo 与系统 WebView2）。
// 沙箱环境无 Rust 工具链，未做编译验证，仅提供可直接编译使用的实现。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct TranslateArgs {
    lines: Vec<String>,
    provider: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    target: Option<String>,
}

/// 翻译命令：逐行翻译，返回与输入等长的译文数组。
#[tauri::command]
async fn translate(args: TranslateArgs) -> Result<Vec<String>, String> {
    let source = args.source.clone().unwrap_or_else(|| "en".to_string());
    let target = args.target.clone().unwrap_or_else(|| "zh-CN".to_string());
    let client = reqwest::Client::new();
    let mut out = Vec::with_capacity(args.lines.len());
    for line in &args.lines {
        let t = translate_one(
            &client,
            line,
            &args.provider,
            &args.api_key,
            &args.model,
            &source,
            &target,
        )
        .await?;
        out.push(t);
    }
    Ok(out)
}

async fn translate_one(
    client: &reqwest::Client,
    line: &str,
    provider: &str,
    api_key: &str,
    model: &str,
    source: &str,
    target: &str,
) -> Result<String, String> {
    match provider {
        "mymemory" => {
            let pair = format!("{}|{}", source, target);
            let resp: Value = client
                .get("https://api.mymemory.translated.net/get")
                .query(&[("q", line), ("langpair", &pair)])
                .send()
                .await
                .map_err(|e| format!("MyMemory 请求失败: {}", e))?
                .json()
                .await
                .map_err(|e| format!("MyMemory 解析失败: {}", e))?;
            resp.get("responseData")
                .and_then(|d| d.get("translatedText"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "MyMemory 返回格式异常".to_string())
        }
        "openai" => {
            let m = if model.is_empty() { "gpt-4o-mini" } else { model };
            let body = serde_json::json!({
                "model": m,
                "messages": [
                    {"role": "system", "content": "You are a subtitle translator. Translate the user's subtitle line into Chinese. Output only the translation, no quotes, no explanations."},
                    {"role": "user", "content": line}
                ],
                "temperature": 0.3
            });
            let resp: Value = client
                .post("https://api.openai.com/v1/chat/completions")
                .bearer_auth(api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenAI 请求失败: {}", e))?
                .json()
                .await
                .map_err(|e| format!("OpenAI 解析失败: {}", e))?;
            resp.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .map(|s| s.trim().to_string())
                .ok_or_else(|| "OpenAI 返回格式异常（检查 key / 模型）".to_string())
        }
        "deepl" => {
            let resp: Value = client
                .post("https://api-free.deepl.com/v2/translate")
                .header("Authorization", format!("DeepL-Auth-Key {}", api_key))
                .form(&[("text", line), ("target_lang", "ZH")])
                .send()
                .await
                .map_err(|e| format!("DeepL 请求失败: {}", e))?
                .json()
                .await
                .map_err(|e| format!("DeepL 解析失败: {}", e))?;
            resp.get("translations")
                .and_then(|t| t.get(0))
                .and_then(|t| t.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "DeepL 返回格式异常（检查 key）".to_string())
        }
        other => Err(format!("未知翻译引擎: {}", other)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![translate])
        .run(tauri::generate_context!())
        .expect("error while running Subtitle-for-G");
}

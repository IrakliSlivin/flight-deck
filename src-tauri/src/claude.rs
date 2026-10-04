use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const MODEL: &str = "claude-sonnet-5";
const MAX_TOKENS: u32 = 1024;

fn get_key() -> Result<String, String> {
    let entry = Entry::new(SERVICE, "anthropic.api_key").map_err(|e| e.to_string())?;
    entry
        .get_password()
        .map_err(|_| "Claude API key not set. Add it in Settings.".to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct ResponseBody {
    content: Vec<ContentBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
}
#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

/// One Messages API call. `extra` is merged into the request body (system, output_config, ...).
/// Returns the concatenated text blocks.
pub async fn complete(
    messages: &[ChatMessage],
    max_tokens: u32,
    extra: serde_json::Value,
) -> Result<String, String> {
    let key = get_key()?;
    let mut body = serde_json::json!({
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }

    let resp = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Claude API error ({status}): {text}"));
    }

    let parsed: ResponseBody = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Claude response: {e}"))?;
    match parsed.stop_reason.as_deref() {
        Some("refusal") => return Err("Claude declined this request.".into()),
        Some("max_tokens") => return Err("Claude's reply was cut off (max_tokens).".into()),
        _ => {}
    }

    Ok(parsed
        .content
        .into_iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join(""))
}

#[tauri::command]
pub async fn send_claude_message(messages: Vec<ChatMessage>) -> Result<String, String> {
    complete(&messages, MAX_TOKENS, serde_json::json!({})).await
}

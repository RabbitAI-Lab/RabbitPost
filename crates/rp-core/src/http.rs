//! 与 RabbitPost 服务端的通信基础：统一解包 { ok, data } / { ok, error } 信封，
//! 错误信息原文透传，便于直接看到服务端返回的原因。
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
// 显式声明反序列化约束，避免 serde 因 `default` 属性额外要求 T: Default
#[serde(bound(deserialize = "T: DeserializeOwned"))]
struct Envelope<T> {
    ok: bool,
    #[serde(default)]
    data: Option<T>,
    #[serde(default)]
    error: Option<ApiErrorBody>,
}

/// 解析一次 API 响应：非 JSON 原文抛出，error 信封透传 code 与 message。
/// 拆成纯函数以便单元测试，HttpClient::send 只是它的 HTTP 封装。
pub(crate) fn parse_envelope<T: DeserializeOwned>(
    url: &str,
    status: reqwest::StatusCode,
    text: &str,
) -> anyhow::Result<T> {
    let envelope: Envelope<T> = serde_json::from_str(text).map_err(|e| {
        // 网关 / 代理返回非 JSON 时原文抛出，避免掩盖真实问题
        anyhow::anyhow!("{url} returned non-JSON ({status}): {text} [{e}]")
    })?;
    if !envelope.ok {
        let err = envelope.error.unwrap_or(ApiErrorBody {
            code: "UNKNOWN".to_string(),
            message: text.to_string(),
        });
        anyhow::bail!("{} {}: {}", status, err.code, err.message);
    }
    envelope
        .data
        .ok_or_else(|| anyhow::anyhow!("{url} returned ok without data: {text}"))
}

/// Bearer Token 认证的 API 客户端；Runner Token 与个人 API Key 通用
pub struct HttpClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl HttpClient {
    pub fn new(server: &str, token: &str, user_agent: &str) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(user_agent.to_string())
            .build()?;
        Ok(Self {
            http,
            base: server.trim_end_matches('/').to_string(),
            token: token.to_string(),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn send<T: DeserializeOwned>(
        &self,
        url: &str,
        req: reqwest::RequestBuilder,
    ) -> anyhow::Result<T> {
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        parse_envelope(url, status, &text)
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let url = format!("{}{}", self.base, path);
        let req = self.http.get(&url).bearer_auth(&self.token);
        self.send(&url, req).await
    }

    pub async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> anyhow::Result<T> {
        let url = format!("{}{}", self.base, path);
        let req = self.http.post(&url).bearer_auth(&self.token).json(body);
        self.send(&url, req).await
    }

    pub async fn patch<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> anyhow::Result<T> {
        let url = format!("{}{}", self.base, path);
        let req = self.http.patch(&url).bearer_auth(&self.token).json(body);
        self.send(&url, req).await
    }

    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let url = format!("{}{}", self.base, path);
        let req = self.http.delete(&url).bearer_auth(&self.token);
        self.send(&url, req).await
    }
}

// ---------------------------------------------------------------------------
// 单元测试：API 信封解析的各种成功 / 失败形态
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::parse_envelope;
    use reqwest::StatusCode;
    use serde_json::Value;

    #[test]
    fn parses_ok_envelope() {
        let data: Value = parse_envelope(
            "http://x/api",
            StatusCode::OK,
            r#"{"ok":true,"data":{"jobId":"j1","concurrency":4}}"#,
        )
        .unwrap();
        assert_eq!(data["jobId"], "j1");
        assert_eq!(data["concurrency"], 4);
    }

    #[test]
    fn error_envelope_keeps_code_and_message() {
        let err = parse_envelope::<Value>(
            "http://x/api",
            StatusCode::UNAUTHORIZED,
            r#"{"ok":false,"error":{"code":"RUNNER_UNAUTHORIZED","message":"Invalid runner token"}}"#,
        )
        .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("401"), "missing status: {text}");
        assert!(text.contains("RUNNER_UNAUTHORIZED"), "missing code: {text}");
        assert!(
            text.contains("Invalid runner token"),
            "missing message: {text}"
        );
    }

    #[test]
    fn non_json_response_is_passed_through() {
        let err = parse_envelope::<Value>(
            "http://x/api",
            StatusCode::BAD_GATEWAY,
            "Bad Gateway from proxy",
        )
        .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("non-JSON"), "expected non-JSON marker: {text}");
        assert!(text.contains("Bad Gateway from proxy"), "missing body: {text}");
    }

    #[test]
    fn ok_envelope_without_data_is_an_error() {
        let err = parse_envelope::<Value>("http://x/api", StatusCode::OK, r#"{"ok":true}"#)
            .unwrap_err();
        assert!(err.to_string().contains("without data"));
    }
}

//! 与 packages/shared 中契约对应的数据结构。
//! 字段命名跟随服务端的 camelCase JSON；反序列化时未支持的字段一律忽略而不报错，
//! 以便服务端新增配置时旧 Runner / CLI 仍可运行。
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KeyValueItem {
    /// 列表渲染稳定键；CLI 新建条目时生成 uuid，服务端数据自带
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// 与服务端一致：未标记 enabled 的行不参与发送
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// form-data 行类型：text / file
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    #[serde(default, rename = "fileBase64", skip_serializing_if = "Option::is_none")]
    pub file_base64: Option<String>,
    #[serde(default, rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBody {
    #[serde(default = "body_type_none", rename = "type")]
    pub body_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_data: Option<Vec<KeyValueItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urlencoded: Option<Vec<KeyValueItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphql_query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphql_variables: Option<String>,
}

fn body_type_none() -> String {
    "none".to_string()
}

impl Default for RequestBody {
    fn default() -> Self {
        Self {
            body_type: body_type_none(),
            raw: None,
            raw_language: None,
            form_data: None,
            urlencoded: None,
            binary_base64: None,
            binary_file_name: None,
            graphql_query: None,
            graphql_variables: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BasicAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BearerAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// Digest Auth；realm/nonce 缺省时由执行器先发一次请求取 401 挑战
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// 缺省 MD5
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce_count: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opaque: Option<String>,
}

/// OAuth 2.0：仅携带已有 Access Token，不自动走授权流程换取
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuth2Auth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// header 前缀；缺省 Bearer
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_prefix: Option<String>,
    /// 注入位置；缺省 header
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add_token_to: Option<String>,
    // 以下为换取 token 的配置，仅保存备查
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_authentication: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiKeyAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// header / query，缺省 header
    #[serde(default, rename = "in", skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAuth {
    #[serde(default = "auth_type_none", rename = "type")]
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basic: Option<BasicAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer: Option<BearerAuth>,
    #[serde(default, rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<ApiKeyAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<DigestAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth2: Option<OAuth2Auth>,
    /// 旧版扁平字段（服务端 normalizeRequestAuth 的兼容路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basic_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basic_password: Option<String>,
    #[serde(default, rename = "apiKeyKey", skip_serializing_if = "Option::is_none")]
    pub api_key_key: Option<String>,
    #[serde(default, rename = "apiKeyValue", skip_serializing_if = "Option::is_none")]
    pub api_key_value: Option<String>,
    #[serde(default, rename = "apiKeyIn", skip_serializing_if = "Option::is_none")]
    pub api_key_in: Option<String>,
}

fn auth_type_none() -> String {
    "none".to_string()
}

impl Default for RequestAuth {
    fn default() -> Self {
        Self {
            auth_type: auth_type_none(),
            basic: None,
            bearer: None,
            api_key: None,
            digest: None,
            oauth2: None,
            bearer_token: None,
            basic_username: None,
            basic_password: None,
            api_key_key: None,
            api_key_value: None,
            api_key_in: None,
        }
    }
}

/// 请求脚本：pre-request 在发送前执行，test 在响应返回后执行
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestScripts {
    #[serde(default, rename = "preRequest", skip_serializing_if = "Option::is_none")]
    pub pre_request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
}

/// 请求级设置；缺省值与 shared 的 DEFAULT_REQUEST_SETTINGS 保持一致
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSettings {
    #[serde(default = "default_true")]
    pub verify_ssl: bool,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    #[serde(default = "default_max_redirects")]
    pub max_redirects: usize,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_max_redirects() -> usize {
    10
}

fn default_timeout_ms() -> u64 {
    30_000
}

impl Default for RequestSettings {
    fn default() -> Self {
        Self {
            verify_ssl: true,
            follow_redirects: true,
            max_redirects: default_max_redirects(),
            timeout_ms: default_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub params: Vec<KeyValueItem>,
    #[serde(default)]
    pub headers: Vec<KeyValueItem>,
    #[serde(default)]
    pub body: RequestBody,
    #[serde(default)]
    pub auth: RequestAuth,
    #[serde(default)]
    pub scripts: RequestScripts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs: Option<String>,
    #[serde(default)]
    pub settings: RequestSettings,
}

fn default_method() -> String {
    "GET".to_string()
}

// ---------------------------------------------------------------------------
// Runner 任务契约
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobItem {
    #[serde(default)]
    pub item_id: Option<String>,
    /// 服务端展开时用例作为独立执行项（name 形如「接口 / 用例」）；请求本身为 None
    #[serde(default)]
    pub case_id: Option<String>,
    pub name: String,
    pub request: RequestConfig,
}

/// 接口用例（GET /api/v1/items/:id/cases 与 /api/v1/collections/:id/cases 的返回元素）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestCase {
    pub id: String,
    pub item_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub request: RequestConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAssignment {
    pub job_id: String,
    #[serde(default)]
    pub target_type: String,
    #[serde(default)]
    pub target_name: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub variables: HashMap<String, String>,
    #[serde(default)]
    pub items: Vec<JobItem>,
}

fn default_concurrency() -> usize {
    4
}

/// rp.test 断言结果（与 shared TestResult 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 脚本 console 输出（与 shared ConsoleLogEntry 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLogEntry {
    pub level: String,
    pub args: Vec<String>,
}

/// 上报给服务端的单请求结果；也是 CLI 报告 results 数组的元素
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    #[serde(default)]
    pub item_id: Option<String>,
    /// 该结果来自接口用例时为用例 id；请求本身为 None（由调用方在执行后填充）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub ok: bool,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub status_text: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    /// 执行过脚本时才有值（Runner 旧版本不执行脚本则为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_results: Option<Vec<TestResult>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub console_logs: Option<Vec<ConsoleLogEntry>>,
    /// 脚本执行后的变量表（含 rp.variables.set 的改动）；场景执行时用于步骤间传递
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_variables: Option<std::collections::HashMap<String, String>>,
    /// 响应头（上报服务端，供 Send 按钮 Body / Headers tab 与报告展示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<std::collections::HashMap<String, String>>,
    /// 响应体文本（截断上报，主要供 Send 按钮 Body tab 展示；二进制以 lossy UTF-8 近似）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_body: Option<String>,
}

// ---------------------------------------------------------------------------
// CLI 管理面契约（团队 / 工作区 / Collection / 环境，均只需 tolerant 读取）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeResponse {
    pub user: Option<UserInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub team_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

/// Collection 树节点（folder / request，自引用嵌套）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionItemNode {
    pub id: String,
    pub collection_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(rename = "type")]
    pub item_type: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<CollectionItemNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentVariable {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<EnvironmentVariable>,
}

/// CLI 报告上传后服务端返回的 RunJob（仅取展示所需字段）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedRunJob {
    pub id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub total_count: Option<i64>,
    #[serde(default)]
    pub succeeded_count: Option<i64>,
    #[serde(default)]
    pub failed_count: Option<i64>,
    #[serde(default)]
    pub test_passed_count: Option<i64>,
    #[serde(default)]
    pub test_failed_count: Option<i64>,
}

// ---------------------------------------------------------------------------
// 反序列化契约测试：锁定与服务端 shared 一致的 JSON 形状，
// 且服务端新增字段（settings 扩展项等）不得导致旧客户端解析失败。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// 服务端实际下发的完整 RequestConfig（含 settings 扩展字段与 docs）
    /// 注意：内容里含 `"#` 序列，raw string 需要用两个 # 作为分隔符
    const FULL_REQUEST_JSON: &str = r##"{
        "protocol": "http",
        "method": "POST",
        "url": "https://{{host}}/api/items",
        "params": [
            {"id": "p1", "key": "page", "value": "1", "enabled": true},
            {"id": "p2", "key": "off", "value": "x", "enabled": false}
        ],
        "headers": [
            {"id": "h1", "key": "X-Trace", "value": "t", "enabled": true, "description": "d"}
        ],
        "body": {
            "type": "raw",
            "raw": "{\"a\":1}",
            "rawLanguage": "json",
            "binaryBase64": "AAE=",
            "graphqlSchemaMode": "auto"
        },
        "auth": {
            "type": "bearer",
            "bearer": {"token": "{{token}}"},
            "bearerToken": "legacy"
        },
        "scripts": {"preRequest": "rp.variables.set('x','1');", "test": "rp.test('ok');"},
        "docs": "# hello",
        "settings": {
            "httpVersion": "http2",
            "verifySsl": false,
            "followRedirects": true,
            "followOriginalHttpMethod": false,
            "maxRedirects": 5,
            "disabledTlsProtocols": ["TLSv1"],
            "cipherSuites": "TLS_AES_128_GCM_SHA256",
            "timeoutMs": 1000,
            "encodeUrl": true
        }
    }"##;

    #[test]
    fn request_config_parses_full_server_payload_and_ignores_unknown_fields() {
        let cfg: RequestConfig = serde_json::from_str(FULL_REQUEST_JSON).unwrap();
        assert_eq!(cfg.method, "POST");
        assert_eq!(cfg.params.len(), 2);
        assert!(cfg.params[0].enabled);
        assert!(!cfg.params[1].enabled);
        assert_eq!(cfg.body.body_type, "raw");
        assert_eq!(cfg.body.raw.as_deref(), Some("{\"a\":1}"));
        assert_eq!(cfg.auth.auth_type, "bearer");
        assert_eq!(cfg.auth.bearer.unwrap().token.as_deref(), Some("{{token}}"));
        assert_eq!(
            cfg.scripts.pre_request.as_deref(),
            Some("rp.variables.set('x','1');")
        );
        // 服务端扩展字段（settings 里的精细项）被静默忽略，而不是解析失败
        assert!(!cfg.settings.verify_ssl);
        assert!(cfg.settings.follow_redirects);
        assert_eq!(cfg.settings.max_redirects, 5);
        assert_eq!(cfg.settings.timeout_ms, 1000);
    }

    #[test]
    fn request_config_defaults_match_server_semantics() {
        let cfg: RequestConfig = serde_json::from_str(r#"{"url":"example.com"}"#).unwrap();
        assert_eq!(cfg.method, "GET");
        assert_eq!(cfg.body.body_type, "none");
        assert_eq!(cfg.auth.auth_type, "none");
        assert!(cfg.scripts.pre_request.is_none());
        // 与服务端 DEFAULT_REQUEST_SETTINGS 保持一致
        assert!(cfg.settings.verify_ssl);
        assert!(cfg.settings.follow_redirects);
        assert_eq!(cfg.settings.max_redirects, 10);
        assert_eq!(cfg.settings.timeout_ms, 30_000);
    }

    #[test]
    fn kv_item_without_enabled_flag_is_skipped() {
        // 与服务端一致：未标记 enabled 的行不参与发送
        let item: KeyValueItem = serde_json::from_str(r#"{"key":"a","value":"b"}"#).unwrap();
        assert!(!item.enabled);
    }

    #[test]
    fn legacy_flat_auth_fields_are_parsed() {
        let auth: RequestAuth = serde_json::from_str(
            r#"{"type":"api-key","apiKeyKey":"X-Key","apiKeyValue":"v","apiKeyIn":"query"}"#,
        )
        .unwrap();
        assert_eq!(auth.api_key_key.as_deref(), Some("X-Key"));
        assert_eq!(auth.api_key_in.as_deref(), Some("query"));
    }

    #[test]
    fn job_assignment_parses_camel_case_envelope_data() {
        let json = r#"{
            "jobId": "job-1",
            "workspaceId": "ws-1",
            "targetType": "collection",
            "targetName": "Demo",
            "concurrency": 3,
            "variables": {"host": "http://localhost"},
            "items": [
                {"itemId": "i1", "name": "f / r1", "request": {"method": "GET", "url": "x"}}
            ]
        }"#;
        let job: JobAssignment = serde_json::from_str(json).unwrap();
        assert_eq!(job.job_id, "job-1");
        assert_eq!(job.concurrency, 3);
        assert_eq!(job.variables["host"], "http://localhost");
        assert_eq!(job.items[0].name, "f / r1");
        assert_eq!(job.items[0].item_id.as_deref(), Some("i1"));
    }

    #[test]
    fn job_assignment_defaults_concurrency_and_variables() {
        let job: JobAssignment = serde_json::from_str(r#"{"jobId":"j"}"#).unwrap();
        assert_eq!(job.concurrency, 4);
        assert!(job.variables.is_empty());
        assert!(job.items.is_empty());
    }

    #[test]
    fn job_result_serializes_camel_case_for_reporting() {
        let result = JobResult {
            item_id: None,
            case_id: None,
            name: "n".to_string(),
            method: "GET".to_string(),
            url: "u".to_string(),
            ok: true,
            status: Some(200),
            status_text: Some("OK".to_string()),
            size_bytes: Some(5),
            duration_ms: Some(3),
            error: None,
            test_results: None,
            console_logs: None,
            script_variables: None,
            response_headers: None,
            response_body: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        // 服务端 results 接口按 camelCase 解析
        assert!(json.get("itemId").is_some());
        assert!(json.get("statusText").is_some());
        assert!(json.get("sizeBytes").is_some());
        assert!(json.get("durationMs").is_some());
        // 未执行脚本时不下发这两个字段（skip_serializing_if）
        assert!(json.get("testResults").is_none());
        assert!(json.get("consoleLogs").is_none());
        // 非用例结果不带 caseId 字段
        assert!(json.get("caseId").is_none());
    }

    #[test]
    fn job_result_serializes_case_id_when_present() {
        let result = JobResult {
            item_id: Some("i1".to_string()),
            case_id: Some("c1".to_string()),
            name: "req / case".to_string(),
            method: "GET".to_string(),
            url: "u".to_string(),
            ok: true,
            status: Some(200),
            status_text: None,
            size_bytes: None,
            duration_ms: None,
            error: None,
            test_results: None,
            console_logs: None,
            script_variables: None,
            response_headers: None,
            response_body: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json.get("caseId").and_then(|v| v.as_str()), Some("c1"));
    }

    #[test]
    fn job_item_parses_case_id_from_expanded_assignment() {
        let item: JobItem = serde_json::from_str(
            r#"{"itemId":"i1","caseId":"c1","name":"r / c","request":{"method":"GET","url":"x"}}"#,
        )
        .unwrap();
        assert_eq!(item.case_id.as_deref(), Some("c1"));
        // 旧服务端不下发 caseId 字段时解析为 None
        let legacy: JobItem = serde_json::from_str(
            r#"{"itemId":"i1","name":"r","request":{"method":"GET","url":"x"}}"#,
        )
        .unwrap();
        assert!(legacy.case_id.is_none());
    }
}

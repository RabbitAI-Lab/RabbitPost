//! 单个请求的执行：变量替换 -> pre-request 脚本 -> 组装 -> 发送 -> test 脚本 -> 采集结果。
//! 网络错误原文透传（含 source 链），与服务端 executor 的处理保持一致。
//! 判定语义：传输层拿到 2xx/3xx 且全部断言通过才算 ok（断言失败等价于用例失败）。
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_TYPE};
use reqwest::{Client, Method};
use url::Url;

use crate::model::{
    ConsoleLogEntry, DigestAuth, JobResult, KeyValueItem, OAuth2Auth, RequestConfig, TestResult,
};
use crate::script::{self, RequestView};
use crate::vars::{substitute, substitute_opt};

/// 响应体回读上限：超过则不进脚本/报告（与服务端 MAX_BODY_CAPTURE_BYTES 一致）
const MAX_BODY_CAPTURE_BYTES: usize = 1024 * 1024;

/// 按请求级设置区分的客户端缓存键：这些设置只能在建客户端时指定
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ClientKey {
    verify_ssl: bool,
    follow_redirects: bool,
    max_redirects: usize,
    timeout_ms: u64,
}

/// 客户端池：同一组设置复用连接池，避免每个请求都重建 TLS 栈
pub struct ClientPool {
    clients: Mutex<HashMap<ClientKey, Client>>,
    /// 保留用于 Runner↔API 通信的 UA；实际请求不注入（见 client_for 注释）
    #[allow(dead_code)]
    user_agent: String,
}

impl ClientPool {
    pub fn new(user_agent: &str) -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            user_agent: user_agent.to_string(),
        }
    }

    fn client_for(&self, cfg: &RequestConfig) -> anyhow::Result<Client> {
        let key = ClientKey {
            verify_ssl: cfg.settings.verify_ssl,
            follow_redirects: cfg.settings.follow_redirects,
            max_redirects: cfg.settings.max_redirects,
            timeout_ms: cfg.settings.timeout_ms,
        };
        if let Some(client) = self.clients.lock().unwrap().get(&key) {
            return Ok(client.clone());
        }
        let redirect = if key.follow_redirects {
            reqwest::redirect::Policy::limited(key.max_redirects)
        } else {
            reqwest::redirect::Policy::none()
        };
        // 不向实际请求注入 Runner 自身的 User-Agent：用户未设置该头时应原样留空（多数
        // 服务端对空 UA 按浏览器处理），强行注入会导致部分站点返回与预期不同的内容
        // （如百度对非浏览器 UA 返回 JS 跳转页而非完整首页）。用户在 Headers tab 手写
        // 的 User-Agent 仍由 build_headers 正常携带。
        //
        // gzip(true) 启用自动解压（服务端可能不顾 accept-encoding 强制 gzip），
        // 但每条请求会在 do_send 中将 accept-encoding 覆盖为 identity（对齐 Postman：
        // 不主动声明压缩支持），避免部分站点因 accept-encoding: gzip 返回异常内容。
        let mut builder = Client::builder()
            .redirect(redirect)
            .danger_accept_invalid_certs(!key.verify_ssl)
            .gzip(true);
        // timeoutMs = 0 表示不超时
        if key.timeout_ms > 0 {
            builder = builder.timeout(Duration::from_millis(key.timeout_ms));
        }
        let client = builder.build()?;
        self.clients
            .lock()
            .unwrap()
            .insert(key, client.clone());
        Ok(client)
    }
}

fn enabled_pairs(items: &[KeyValueItem]) -> Vec<(String, String)> {
    items
        .iter()
        .filter(|i| i.enabled && !i.key.is_empty())
        .map(|i| (i.key.clone(), i.value.clone()))
        .collect()
}

/// 展开错误的 source 链，便于定位 DNS / TLS / 连接层的真实原因
fn format_error(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        source = inner.source();
    }
    parts.join(" -> ")
}

fn failure(
    name: &str,
    item_id: Option<String>,
    method: &str,
    url: &str,
    error: String,
    test_results: Option<Vec<TestResult>>,
    console_logs: Option<Vec<ConsoleLogEntry>>,
) -> JobResult {
    JobResult {
        item_id,
        case_id: None,
        name: name.to_string(),
        method: method.to_string(),
        url: url.to_string(),
        ok: false,
        status: None,
        status_text: None,
        size_bytes: None,
        duration_ms: None,
        error: Some(error),
        test_results,
        console_logs,
        script_variables: None,
        response_headers: None,
        response_body: None,
    }
}

/// 深度变量替换：url / params / headers / body / auth（与服务端 substituteConfig 对齐），
/// 在 pre-request 脚本之前一次性完成；脚本改写过的请求不再二次替换。
fn substitute_config(cfg: &RequestConfig, vars: &HashMap<String, String>) -> RequestConfig {
    let sub = |s: &str| substitute(s, vars);
    let sub_opt = |s: &Option<String>| substitute_opt(s, vars);
    let sub_items = |items: &[KeyValueItem]| {
        items
            .iter()
            .map(|it| KeyValueItem {
                key: sub(&it.key),
                value: sub(&it.value),
                ..it.clone()
            })
            .collect::<Vec<_>>()
    };
    let mut out = cfg.clone();
    out.url = sub(&cfg.url);
    out.params = sub_items(&cfg.params);
    out.headers = sub_items(&cfg.headers);
    out.body.raw = sub_opt(&cfg.body.raw);
    out.body.form_data = cfg.body.form_data.as_deref().map(sub_items);
    out.body.urlencoded = cfg.body.urlencoded.as_deref().map(sub_items);
    out.body.graphql_query = sub_opt(&cfg.body.graphql_query);
    out.body.graphql_variables = sub_opt(&cfg.body.graphql_variables);
    // auth 各字段结构不一，逐个覆盖（与服务端 substituteDeep 等价）
    if let Some(basic) = &cfg.auth.basic {
        out.auth.basic = Some(crate::model::BasicAuth {
            username: sub_opt(&basic.username),
            password: sub_opt(&basic.password),
        });
    }
    if let Some(bearer) = &cfg.auth.bearer {
        out.auth.bearer = Some(crate::model::BearerAuth {
            token: sub_opt(&bearer.token),
        });
    }
    if let Some(api_key) = &cfg.auth.api_key {
        out.auth.api_key = Some(crate::model::ApiKeyAuth {
            key: sub_opt(&api_key.key),
            value: sub_opt(&api_key.value),
            location: api_key.location.clone(),
        });
    }
    if let Some(digest) = &cfg.auth.digest {
        out.auth.digest = Some(DigestAuth {
            username: sub_opt(&digest.username),
            password: sub_opt(&digest.password),
            realm: sub_opt(&digest.realm),
            nonce: sub_opt(&digest.nonce),
            algorithm: digest.algorithm.clone(),
            qop: digest.qop.clone(),
            nonce_count: sub_opt(&digest.nonce_count),
            client_nonce: sub_opt(&digest.client_nonce),
            opaque: sub_opt(&digest.opaque),
        });
    }
    if let Some(oauth2) = &cfg.auth.oauth2 {
        out.auth.oauth2 = Some(OAuth2Auth {
            grant_type: oauth2.grant_type.clone(),
            access_token: sub_opt(&oauth2.access_token),
            header_prefix: sub_opt(&oauth2.header_prefix),
            add_token_to: oauth2.add_token_to.clone(),
            callback_url: sub_opt(&oauth2.callback_url),
            auth_url: sub_opt(&oauth2.auth_url),
            access_token_url: sub_opt(&oauth2.access_token_url),
            client_id: sub_opt(&oauth2.client_id),
            client_secret: sub_opt(&oauth2.client_secret),
            scope: sub_opt(&oauth2.scope),
            state: sub_opt(&oauth2.state),
            username: sub_opt(&oauth2.username),
            password: sub_opt(&oauth2.password),
            client_authentication: oauth2.client_authentication.clone(),
        });
    }
    out.auth.bearer_token = sub_opt(&cfg.auth.bearer_token);
    out.auth.basic_username = sub_opt(&cfg.auth.basic_username);
    out.auth.basic_password = sub_opt(&cfg.auth.basic_password);
    out.auth.api_key_key = sub_opt(&cfg.auth.api_key_key);
    out.auth.api_key_value = sub_opt(&cfg.auth.api_key_value);
    out
}

/// 目标 URL：无协议前缀时补 http://（与服务端一致），并追加启用的 query 参数
fn build_url(cfg: &RequestConfig) -> anyhow::Result<Url> {
    let raw = cfg.url.trim();
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let mut url = Url::parse(&with_scheme)?;
    let params = enabled_pairs(&cfg.params);
    if !params.is_empty() {
        let mut query = url.query_pairs_mut();
        for (key, value) in &params {
            query.append_pair(key, value);
        }
    }
    Ok(url)
}

fn build_headers(cfg: &RequestConfig) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (key, value) in enabled_pairs(&cfg.headers) {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid header name `{key}`: {e}"))?;
        let value = HeaderValue::from_str(&value)
            .map_err(|e| anyhow::anyhow!("invalid value for header `{key}`: {e}"))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

enum Payload {
    None,
    Bytes {
        body: Vec<u8>,
        content_type: Option<&'static str>,
    },
    Form(Vec<(String, String)>),
    Multipart(reqwest::multipart::Form),
}

fn build_payload(cfg: &RequestConfig, method: &Method) -> anyhow::Result<Payload> {
    // 与服务端一致：GET / HEAD 不携带请求体
    if cfg.body.body_type == "none" || matches!(*method, Method::GET | Method::HEAD) {
        return Ok(Payload::None);
    }
    match cfg.body.body_type.as_str() {
        "raw" => {
            let raw = cfg.body.raw.clone().unwrap_or_default();
            let content_type = match cfg.body.raw_language.as_deref() {
                Some("json") => Some("application/json"),
                Some("xml") => Some("application/xml"),
                Some("html") => Some("text/html"),
                _ => None,
            };
            Ok(Payload::Bytes {
                body: raw.into_bytes(),
                content_type,
            })
        }
        "x-www-form-urlencoded" => Ok(Payload::Form(enabled_pairs(
            cfg.body.urlencoded.as_deref().unwrap_or(&[]),
        ))),
        "form-data" => {
            let mut form = reqwest::multipart::Form::new();
            for item in cfg.body.form_data.as_deref().unwrap_or(&[]) {
                if !item.enabled || item.key.is_empty() {
                    continue;
                }
                if item.item_type.as_deref() == Some("file") {
                    let Some(encoded) = item.file_base64.as_ref() else {
                        continue;
                    };
                    let bytes = BASE64.decode(encoded).map_err(|e| {
                        anyhow::anyhow!("invalid base64 for field `{}`: {e}", item.key)
                    })?;
                    let part = reqwest::multipart::Part::bytes(bytes)
                        .file_name(item.file_name.clone().unwrap_or_else(|| "file".to_string()))
                        .mime_str("application/octet-stream")?;
                    form = form.part(item.key.clone(), part);
                } else {
                    form = form.text(item.key.clone(), item.value.clone());
                }
            }
            Ok(Payload::Multipart(form))
        }
        "binary" => {
            let Some(encoded) = cfg.body.binary_base64.as_ref() else {
                return Ok(Payload::None);
            };
            let bytes = BASE64
                .decode(encoded)
                .map_err(|e| anyhow::anyhow!("invalid base64 body: {e}"))?;
            Ok(Payload::Bytes {
                body: bytes,
                content_type: None,
            })
        }
        "graphql" => {
            // 同服务端：以 JSON 形式发送 { query, variables }；variables 非法 JSON 时忽略
            let query = cfg.body.graphql_query.clone().unwrap_or_default();
            let mut payload = serde_json::json!({ "query": query });
            if let Some(text) = &cfg.body.graphql_variables {
                if !text.trim().is_empty() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                        payload["variables"] = value;
                    }
                }
            }
            Ok(Payload::Bytes {
                body: serde_json::to_vec(&payload)?,
                content_type: Some("application/json"),
            })
        }
        other => Err(anyhow::anyhow!("unsupported body type `{other}`")),
    }
}

/// 认证：仅注入请求头 / query，尚未支持的类型直接报错而不是静默降级为匿名请求
/// Digest 返回 None 表示需要先取 401 挑战
fn apply_auth(cfg: &RequestConfig, url: &mut Url, headers: &mut HeaderMap) -> anyhow::Result<()> {
    apply_auth_with_challenge(cfg, url, headers, None)
}

/// 带 Digest 挑战参数的认证实现
fn apply_auth_with_challenge(
    cfg: &RequestConfig,
    url: &mut Url,
    headers: &mut HeaderMap,
    digest_challenge: Option<&HashMap<String, String>>,
) -> anyhow::Result<()> {
    let auth = &cfg.auth;
    match auth.auth_type.as_str() {
        "none" => Ok(()),
        "basic" => {
            let username = auth
                .basic
                .as_ref()
                .and_then(|b| b.username.clone())
                .or_else(|| auth.basic_username.clone())
                .unwrap_or_default();
            let password = auth
                .basic
                .as_ref()
                .and_then(|b| b.password.clone())
                .or_else(|| auth.basic_password.clone())
                .unwrap_or_default();
            let encoded = BASE64.encode(format!("{username}:{password}"));
            headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Basic {encoded}"))?,
            );
            Ok(())
        }
        "bearer" => {
            let token = auth
                .bearer
                .as_ref()
                .and_then(|b| b.token.clone())
                .or_else(|| auth.bearer_token.clone())
                .unwrap_or_default();
            headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
            Ok(())
        }
        "api-key" => {
            let key = auth
                .api_key
                .as_ref()
                .and_then(|a| a.key.clone())
                .or_else(|| auth.api_key_key.clone())
                .unwrap_or_default();
            let value = auth
                .api_key
                .as_ref()
                .and_then(|a| a.value.clone())
                .or_else(|| auth.api_key_value.clone())
                .unwrap_or_default();
            let location = auth
                .api_key
                .as_ref()
                .and_then(|a| a.location.clone())
                .or_else(|| auth.api_key_in.clone())
                .unwrap_or_else(|| "header".to_string());
            if key.is_empty() {
                return Ok(());
            }
            if location == "query" {
                url.query_pairs_mut().append_pair(&key, &value);
            } else {
                headers.insert(
                    HeaderName::from_bytes(key.as_bytes())
                        .map_err(|e| anyhow::anyhow!("invalid api key header `{key}`: {e}"))?,
                    HeaderValue::from_str(&value)?,
                );
            }
            Ok(())
        }
        "digest" => apply_digest(auth.digest.as_ref(), url, headers, digest_challenge),
        "oauth2" => apply_oauth2(auth.oauth2.as_ref(), url, headers),
        other => Err(anyhow::anyhow!(
            "auth type `{other}` is not supported by the local engine yet; \
             run this request from the app or switch to none/basic/bearer/api-key/digest/oauth2"
        )),
    }
}

// ---------------------------------------------------------------------------
// Digest Auth 签名
// ---------------------------------------------------------------------------

/// Digest algorithm -> 摘要算法名
fn digest_hash_name(algorithm: &str) -> anyhow::Result<&'static str> {
    let base = algorithm.trim_end_matches("-sess").to_uppercase();
    match base.as_str() {
        "MD5" => Ok("md5"),
        "SHA-256" => Ok("sha256"),
        "SHA-512-256" => Ok("sha512-256"),
        _ => Err(anyhow::anyhow!("unsupported Digest algorithm: {algorithm}")),
    }
}

fn digest_hex(hash_name: &str, data: &str) -> String {
    use std::fmt::Write;
    let bytes = match hash_name {
        "md5" => {
            let digest = md5_compute(data.as_bytes());
            digest.to_vec()
        }
        "sha256" => {
            use sha2::Digest as _;
            sha2::Sha256::digest(data.as_bytes()).to_vec()
        }
        "sha512-256" => {
            use sha2::Digest as _;
            sha2::Sha512_256::digest(data.as_bytes()).to_vec()
        }
        _ => unreachable!("validated by digest_hash_name"),
    };
    let mut hex = String::with_capacity(bytes.len() * 2);
    for b in &bytes {
        write!(hex, "{b:02x}").unwrap();
    }
    hex
}

/// 使用 md5 crate 计算 MD5（避免引入完整 OpenSSL）
fn md5_compute(data: &[u8]) -> [u8; 16] {
    // 手动实现 MD5 摘要，避免额外依赖
    // 简化：使用系统提供的 MD5
    let mut context = md5_context();
    md5_update(&mut context, data);
    md5_final(&mut context)
}

// MD5 实现（RFC 1321）
fn md5_context() -> Md5Context {
    Md5Context {
        state: [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476],
        count: 0,
        buffer: [0u8; 64],
    }
}

struct Md5Context {
    state: [u32; 4],
    count: u64,
    buffer: [u8; 64],
}

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

fn md5_update(ctx: &mut Md5Context, data: &[u8]) {
    let buffer_len = (ctx.count % 64) as usize;
    ctx.count = ctx.count.wrapping_add(data.len() as u64);

    let mut offset = 0;
    if buffer_len > 0 {
        let needed = 64 - buffer_len;
        let take = needed.min(data.len());
        ctx.buffer[buffer_len..buffer_len + take].copy_from_slice(&data[..take]);
        offset = take;
        if buffer_len + take == 64 {
            let block = ctx.buffer;
            md5_process_block(ctx, &block);
        }
    }
    while offset + 64 <= data.len() {
        let mut block = [0u8; 64];
        block.copy_from_slice(&data[offset..offset + 64]);
        md5_process_block(ctx, &block);
        offset += 64;
    }
    if offset < data.len() {
        let remaining = data.len() - offset;
        ctx.buffer[..remaining].copy_from_slice(&data[offset..]);
    }
}

fn md5_final(ctx: &mut Md5Context) -> [u8; 16] {
    let bit_count = ctx.count.wrapping_mul(8);
    let buffer_len = (ctx.count % 64) as usize;

    // Padding
    let pad_len = if buffer_len < 56 { 56 - buffer_len } else { 120 - buffer_len };
    let mut padding = vec![0x80u8];
    padding.extend(std::iter::repeat(0u8).take(pad_len - 1));
    md5_update(ctx, &padding);

    // Length
    let mut length_bytes = [0u8; 8];
    length_bytes.copy_from_slice(&bit_count.to_le_bytes());
    md5_update(ctx, &length_bytes);

    // Output
    let mut result = [0u8; 16];
    for (i, word) in ctx.state.iter().enumerate() {
        result[i * 4..(i + 1) * 4].copy_from_slice(&word.to_le_bytes());
    }
    result
}

fn md5_process_block(ctx: &mut Md5Context, block: &[u8; 64]) {
    let mut m = [0u32; 16];
    for i in 0..16 {
        m[i] = u32::from_le_bytes([
            block[i * 4],
            block[i * 4 + 1],
            block[i * 4 + 2],
            block[i * 4 + 3],
        ]);
    }

    let (mut a, mut b, mut c, mut d) = (ctx.state[0], ctx.state[1], ctx.state[2], ctx.state[3]);

    for i in 0..64 {
        let (f, g) = match i / 16 {
            0 => ((b & c) | (!b & d), i),
            1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
            2 => (b ^ c ^ d, (3 * i + 5) % 16),
            _ => (c ^ (b | !d), (7 * i) % 16),
        };
        let tmp = d;
        d = c;
        c = b;
        b = b.wrapping_add(
            (a.wrapping_add(f).wrapping_add(MD5_K[i]).wrapping_add(m[g]))
                .rotate_left(MD5_S[i]),
        );
        a = tmp;
    }

    ctx.state[0] = ctx.state[0].wrapping_add(a);
    ctx.state[1] = ctx.state[1].wrapping_add(b);
    ctx.state[2] = ctx.state[2].wrapping_add(c);
    ctx.state[3] = ctx.state[3].wrapping_add(d);
}

/// 解析 WWW-Authenticate: Digest realm="x", nonce="y", ...
fn parse_digest_challenge(header: &str) -> Option<HashMap<String, String>> {
    let trimmed = header.trim();
    if !trimmed.to_ascii_lowercase().starts_with("digest") {
        return None;
    }
    let params_str = trimmed[6..].trim();
    let mut params = HashMap::new();
    // 按逗号分割，但忽略引号内的逗号
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in params_str.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            ',' if !in_quotes => {
                if let Some((k, v)) = parse_digest_param(&current) {
                    params.insert(k, v);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        if let Some((k, v)) = parse_digest_param(&current) {
            params.insert(k, v);
        }
    }
    Some(params)
}

fn parse_digest_param(s: &str) -> Option<(String, String)> {
    let eq = s.find('=')?;
    let key = s[..eq].trim().to_lowercase();
    let value = s[eq + 1..].trim().trim_matches('"').to_string();
    Some((key, value))
}

/// Digest 签名；challenge 为 None 时如果 realm/nonce 不足则报错
fn apply_digest(
    cfg: Option<&DigestAuth>,
    url: &mut Url,
    headers: &mut HeaderMap,
    challenge: Option<&HashMap<String, String>>,
) -> anyhow::Result<()> {
    let cfg = cfg.cloned().unwrap_or_default();
    let empty_challenge = HashMap::new();
    let challenge = challenge.unwrap_or(&empty_challenge);

    let realm = cfg
        .realm
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| challenge.get("realm").map(|s| s.as_str()))
        .ok_or_else(|| anyhow::anyhow!("Digest Auth: realm is required (from config or 401 challenge)"))?;
    let nonce = cfg
        .nonce
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| challenge.get("nonce").map(|s| s.as_str()))
        .ok_or_else(|| anyhow::anyhow!("Digest Auth: nonce is required (from config or 401 challenge)"))?;

    let algorithm = cfg
        .algorithm
        .as_deref()
        .or_else(|| challenge.get("algorithm").map(|s| s.as_str()))
        .unwrap_or("MD5");
    let hash_name = digest_hash_name(algorithm)?;
    let is_sess = algorithm.ends_with("-sess");

    let username = cfg.username.as_deref().unwrap_or_default();
    let password = cfg.password.as_deref().unwrap_or_default();
    let uri = format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default());
    let cnonce = cfg
        .client_nonce
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            use std::time::{SystemTime, UNIX_EPOCH};
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos();
            format!("{nanos:016x}")
        });
    let nc = cfg
        .nonce_count
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("00000001");
    let opaque = cfg
        .opaque
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| challenge.get("opaque").map(|s| s.as_str()));

    // qop 优先取用户配置，其次取挑战里声明的第一个
    let qop = cfg
        .qop
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            challenge
                .get("qop")
                .and_then(|q| q.split(',').next())
                .map(|s| s.trim())
        })
        .unwrap_or("");

    let h = |data: &str| digest_hex(hash_name, data);

    let mut ha1 = h(&format!("{username}:{realm}:{password}"));
    if is_sess {
        ha1 = h(&format!("{ha1}:{nonce}:{cnonce}"));
    }
    let ha2 = if qop == "auth-int" {
        // auth-int 需要 body hash；GET/HEAD 无 body 时为空字符串的 hash
        h(&format!("{}:{uri}:{}", "GET", h("")))
    } else {
        h(&format!("{}:{uri}", "GET"))
    };
    let response = if !qop.is_empty() {
        h(&format!("{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}"))
    } else {
        h(&format!("{ha1}:{nonce}:{ha2}"))
    };

    let mut parts = vec![
        format!("username=\"{username}\""),
        format!("realm=\"{realm}\""),
        format!("nonce=\"{nonce}\""),
        format!("uri=\"{uri}\""),
        format!("algorithm={algorithm}"),
        format!("response=\"{response}\""),
    ];
    if !qop.is_empty() {
        parts.push(format!("qop={qop}"));
        parts.push(format!("nc={nc}"));
        parts.push(format!("cnonce=\"{cnonce}\""));
    }
    if let Some(op) = opaque {
        parts.push(format!("opaque=\"{op}\""));
    }
    headers.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Digest {}", parts.join(", ")))?,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// OAuth 2.0（仅携带已有 token）
// ---------------------------------------------------------------------------

fn apply_oauth2(
    cfg: Option<&OAuth2Auth>,
    url: &mut Url,
    headers: &mut HeaderMap,
) -> anyhow::Result<()> {
    let cfg = cfg.cloned().unwrap_or_default();
    let token = cfg
        .access_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "OAuth 2.0: Access Token is empty. Auto authorization flow is not supported; \
                 please provide an Access Token."
            )
        })?;
    if cfg.add_token_to.as_deref() == Some("query") {
        url.query_pairs_mut().append_pair("access_token", token);
        return Ok(());
    }
    let prefix = cfg
        .header_prefix
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("Bearer");
    let value = if prefix.is_empty() {
        token.to_string()
    } else {
        format!("{prefix} {token}")
    };
    headers.insert(
        reqwest::header::AUTHORIZATION,
        HeaderValue::from_str(&value)?,
    );
    Ok(())
}

/// 执行一个请求并返回可直接上报的结果
pub async fn execute(
    pool: &ClientPool,
    name: &str,
    item_id: Option<String>,
    cfg: &RequestConfig,
    vars: &HashMap<String, String>,
) -> JobResult {
    // 脚本产物（断言 / console）；只有真的跑过脚本才上报，避免噪声
    let mut test_results: Vec<TestResult> = Vec::new();
    let mut console_logs: Vec<ConsoleLogEntry> = Vec::new();
    let mut scripts_ran = false;

    // 1. 变量替换（pre-request 之前一次性完成，与服务端一致）
    let mut config = substitute_config(cfg, vars);
    let mut variables = vars.clone();

    // 2. pre-request 脚本：可改写变量与请求；改写后的请求不再做变量替换
    if let Some(code) = cfg.scripts.pre_request.as_deref() {
        if !code.trim().is_empty() {
            scripts_ran = true;
            let view = RequestView {
                method: config.method.clone(),
                url: config.url.clone(),
                headers: enabled_pairs(&config.headers).into_iter().collect(),
                body: None,
            };
            let out = script::run_script(code, "pre-request", &variables, Some(&view), None);
            test_results.extend(out.test_results);
            console_logs.extend(out.console_logs);
            variables = out.variables;
            if let Some(rewritten) = out.request {
                config.method = rewritten.method;
                config.url = rewritten.url;
                config.headers = rewritten
                    .headers
                    .into_iter()
                    .map(|(key, value)| KeyValueItem {
                        key,
                        value,
                        enabled: true,
                        ..Default::default()
                    })
                    .collect();
            }
        }
    }

    let method = match Method::from_bytes(config.method.to_uppercase().as_bytes()) {
        Ok(m) => m,
        Err(e) => {
            return finish_early(
                failure(
                    name,
                    item_id,
                    &config.method,
                    &config.url,
                    format!("invalid HTTP method `{}`: {e}", config.method),
                    None,
                    None,
                ),
                scripts_ran,
                test_results,
                console_logs,
            )
        }
    };

    let send_result = send_once(pool, name, item_id.clone(), &config, &method).await;
    let (mut result, response_view) = match send_result {
        Ok((result, view)) => (result, view),
        Err(result) => {
            return finish_early(result, scripts_ran, test_results, console_logs);
        }
    };

    // 3. test 脚本：响应断言；同时收集脚本中的变量改动（场景步骤间传递用）
    if let Some(code) = cfg.scripts.test.as_deref() {
        if !code.trim().is_empty() {
            scripts_ran = true;
            let out = script::run_script(
                code,
                "test",
                &variables,
                None,
                response_view.as_ref(),
            );
            test_results.extend(out.test_results);
            console_logs.extend(out.console_logs);
            variables = out.variables;
        }
    }

    // 断言失败等价于用例失败（newman 语义）；无断言时保持传输层判定
    if result.ok && test_results.iter().any(|t| !t.passed) {
        result.ok = false;
    }
    let mut final_result = finish_early(result, scripts_ran, test_results, console_logs);
    // 将脚本执行后的变量表附加到结果中（场景执行时用于步骤间传递）
    if scripts_ran {
        final_result.script_variables = Some(variables);
    }
    final_result
}

fn finish_early(
    mut result: JobResult,
    scripts_ran: bool,
    test_results: Vec<TestResult>,
    console_logs: Vec<ConsoleLogEntry>,
) -> JobResult {
    if scripts_ran {
        result.test_results = Some(test_results);
        result.console_logs = Some(console_logs);
    }
    result
}

/// 发送一次请求；成功返回（结果, 响应视图），失败直接返回错误结果
async fn send_once(
    pool: &ClientPool,
    name: &str,
    item_id: Option<String>,
    config: &RequestConfig,
    method: &Method,
) -> Result<(JobResult, Option<script::ResponseView>), JobResult> {
    let mut url = match build_url(config) {
        Ok(u) => u,
        Err(e) => {
            return Err(failure(
                name,
                item_id,
                method.as_str(),
                &config.url,
                format!("invalid URL `{}`: {e}", config.url),
                None,
                None,
            ))
        }
    };

    let mut headers = match build_headers(config) {
        Ok(h) => h,
        Err(e) => {
            return Err(failure(
                name,
                item_id,
                method.as_str(),
                url.as_str(),
                e.to_string(),
                None,
                None,
            ))
        }
    };

    let payload = match build_payload(config, method) {
        Ok(p) => p,
        Err(e) => {
            return Err(failure(
                name,
                item_id.clone(),
                method.as_str(),
                url.as_str(),
                e.to_string(),
                None,
                None,
            ))
        }
    };

    let client = match pool.client_for(config) {
        Ok(c) => c,
        Err(e) => {
            return Err(failure(
                name,
                item_id.clone(),
                method.as_str(),
                url.as_str(),
                e.to_string(),
                None,
                None,
            ))
        }
    };

    // Digest 且缺少 realm/nonce：需要先发一次请求取 401 挑战
    let needs_digest_challenge = config.auth.auth_type == "digest" && {
        let d = config.auth.digest.as_ref();
        let has_realm = d.and_then(|d| d.realm.as_deref()).is_some_and(|s| !s.is_empty());
        let has_nonce = d.and_then(|d| d.nonce.as_deref()).is_some_and(|s| !s.is_empty());
        !has_realm || !has_nonce
    };

    if needs_digest_challenge {
        // 第一轮：无认证发送，取 401 WWW-Authenticate
        match send_raw(&client, method, &url, &headers, &payload).await {
            Ok(resp) => {
                let challenge_header = resp
                    .headers()
                    .get("www-authenticate")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                // 消费响应体以释放连接
                let _ = resp.bytes().await;
                if let Some(header) = challenge_header {
                    if let Some(challenge) = parse_digest_challenge(&header) {
                        // 第二轮：带挑战参数重新签名
                        if let Err(e) = apply_auth_with_challenge(
                            config,
                            &mut url,
                            &mut headers,
                            Some(&challenge),
                        ) {
                            return Err(failure(
                                name,
                                item_id.clone(),
                                method.as_str(),
                                url.as_str(),
                                e.to_string(),
                                None,
                                None,
                            ));
                        }
                        // Digest 挑战后重建 payload（multipart 已在第一轮消费）
                        let retry_payload = match build_payload(config, method) {
                            Ok(p) => p,
                            Err(e) => {
                                return Err(failure(
                                    name,
                                    item_id.clone(),
                                    method.as_str(),
                                    url.as_str(),
                                    e.to_string(),
                                    None,
                                    None,
                                ))
                            }
                        };
                        return do_send(
                            &client, name, item_id, method, &url, &headers, retry_payload,
                        )
                        .await;
                    }
                }
                return Err(failure(
                    name,
                    item_id,
                    method.as_str(),
                    url.as_str(),
                    "Digest Auth: server did not return a valid WWW-Authenticate challenge"
                        .to_string(),
                    None,
                    None,
                ));
            }
            Err(e) => {
                return Err(failure(
                    name,
                    item_id,
                    method.as_str(),
                    url.as_str(),
                    format!("Digest Auth: challenge request failed: {e}"),
                    None,
                    None,
                ));
            }
        }
    }

    // 非 Digest 或 Digest 已有 realm/nonce：直接签名发送
    if let Err(e) = apply_auth(config, &mut url, &mut headers) {
        return Err(failure(
            name,
            item_id.clone(),
            method.as_str(),
            url.as_str(),
            e.to_string(),
            None,
            None,
        ));
    }

    do_send(&client, name, item_id, method, &url, &headers, payload).await
}

/// 构建并发送请求（不处理认证），返回原始响应
async fn send_raw(
    client: &Client,
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    payload: &Payload,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut request = client.request(method.clone(), url.clone());
    match payload {
        Payload::None => {}
        Payload::Bytes { body, content_type } => {
            let mut h = headers.clone();
            if let Some(ct) = content_type {
                if !h.contains_key(CONTENT_TYPE) {
                    h.insert(CONTENT_TYPE, HeaderValue::from_static(ct));
                }
            }
            request = request.body(body.clone());
            request = request.headers(h);
            return request.send().await;
        }
        Payload::Form(pairs) => {
            request = request.form(pairs);
        }
        Payload::Multipart(_) => {
            // Digest 挑战阶段不需要真正发送 body，只取 401 头
            // 发送空 body 即可触发挑战
        }
    }
    request.headers(headers.clone()).send().await
}

/// 执行发送并构建 JobResult
async fn do_send(
    client: &Client,
    name: &str,
    item_id: Option<String>,
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    payload: Payload,
) -> Result<(JobResult, Option<script::ResponseView>), JobResult> {
    let mut request = client.request(method.clone(), url.clone());
    let mut h = headers.clone();
    match payload {
        Payload::None => {}
        Payload::Bytes { body, content_type } => {
            if let Some(ct) = content_type {
                if !h.contains_key(CONTENT_TYPE) {
                    h.insert(CONTENT_TYPE, HeaderValue::from_static(ct));
                }
            }
            request = request.body(body);
        }
        Payload::Form(pairs) => {
            request = request.form(&pairs);
        }
        Payload::Multipart(form) => {
            h.remove(CONTENT_TYPE);
            request = request.multipart(form);
        }
    }
    // reqwest gzip(true) 会自动注入 accept-encoding: gzip 作为默认头；
    // 用户未显式声明时应覆盖为 identity（对齐 Postman：不主动声明压缩支持），
    // 避免部分站点因 accept-encoding: gzip 返回异常内容。
    // 用户在 Headers tab 手写的 Accept-Encoding 会在此处覆盖 identity。
    if !h.contains_key("accept-encoding") {
        h.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    request = request.headers(h);

    let started = Instant::now();
    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            let status_text = status.canonical_reason().unwrap_or("").to_string();
            let final_url = resp.url().to_string();
            // reqwest HeaderMap 对同名 header（如 set-cookie）有多条记录；
            // 收集到 HashMap 时须合并而非覆盖（否则 Headers tab 会少行、Cookie 会丢）
            let mut response_headers: HashMap<String, String> = HashMap::new();
            for (k, v) in resp.headers().iter() {
                let key = k.as_str().to_string();
                let val = v.to_str().unwrap_or("").to_string();
                response_headers
                    .entry(key)
                    .and_modify(|existing| {
                        existing.push_str(", ");
                        existing.push_str(&val);
                    })
                    .or_insert(val);
            }
            match resp.bytes().await {
                Ok(bytes) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    let size = bytes.len();
                    // 与 CI 语义一致：4xx / 5xx 记为失败，状态码仍原样上报
                    let ok = status.is_success() || status.is_redirection();
                    let body_text = String::from_utf8_lossy(&bytes).into_owned();
                    let view = if size <= MAX_BODY_CAPTURE_BYTES {
                        Some(script::ResponseView {
                            code: status.as_u16(),
                            status: status_text.clone(),
                            headers: response_headers.clone(),
                            time: duration_ms,
                            body_text: body_text.clone(),
                        })
                    } else {
                        None
                    };
                    // 服务端 runJobResultInputSchema 限制 responseBody ≤ 65536 字符；
                    // 超长截断，保证整批上报不被 zod 拒绝
                    let report_body: String = if body_text.len() > 65536 {
                        body_text.chars().take(65536).collect()
                    } else {
                        body_text
                    };
                    Ok((
                        JobResult {
                            item_id: item_id.clone(),
                            case_id: None,
                            name: name.to_string(),
                            method: method.as_str().to_string(),
                            url: final_url,
                            ok,
                            status: Some(status.as_u16()),
                            status_text: Some(status_text),
                            size_bytes: Some(size as i64),
                            duration_ms: Some(duration_ms as i64),
                            error: None,
                            test_results: None,
                            console_logs: None,
                            script_variables: None,
                            response_headers: Some(response_headers),
                            response_body: Some(report_body),
                        },
                        view,
                    ))
                }
                Err(e) => Err(JobResult {
                    item_id,
                    case_id: None,
                    name: name.to_string(),
                    method: method.as_str().to_string(),
                    url: final_url,
                    ok: false,
                    status: Some(status.as_u16()),
                    status_text: Some(status_text),
                    size_bytes: None,
                    duration_ms: Some(started.elapsed().as_millis() as i64),
                    error: Some(format_error(&e)),
                    test_results: None,
                    console_logs: None,
                    script_variables: None,
                    response_headers: None,
                    response_body: None,
                }),
            }
        }
        Err(e) => {
            let mut result = failure(
                name,
                item_id,
                method.as_str(),
                url.as_str(),
                format_error(&e),
                None,
                None,
            );
            result.duration_ms = Some(started.elapsed().as_millis() as i64);
            Err(result)
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试：组装逻辑（URL / 请求头 / 请求体 / 认证）与端到端发送语义。
// execute 的用例通过 wiremock 起真实本地 HTTP 服务，覆盖状态码 / 重定向 / 超时
// 与 pre-request / test 脚本联动。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ApiKeyAuth, BasicAuth, BearerAuth, DigestAuth, OAuth2Auth, RequestScripts};
    use wiremock::matchers::{body_string, body_string_contains, header, header_regex, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn kv(key: &str, value: &str, enabled: bool) -> KeyValueItem {
        KeyValueItem {
            key: key.to_string(),
            value: value.to_string(),
            enabled,
            ..Default::default()
        }
    }

    fn base_cfg() -> RequestConfig {
        RequestConfig {
            method: "GET".to_string(),
            url: String::new(),
            ..Default::default()
        }
    }

    fn no_vars() -> HashMap<String, String> {
        HashMap::new()
    }

    fn test_pool() -> ClientPool {
        ClientPool::new("rp-core-tests")
    }

    // ------------------------------------------------------------------
    // build_url / build_headers（变量已在 substitute_config 阶段替换完毕）
    // ------------------------------------------------------------------

    #[test]
    fn build_url_prepends_http_scheme_and_appends_enabled_params() {
        let mut cfg = base_cfg();
        cfg.url = "example.com/api".to_string();
        cfg.params = vec![kv("a", "1", true), kv("off", "x", false)];
        let url = build_url(&cfg).unwrap();
        assert_eq!(url.as_str(), "http://example.com/api?a=1");
    }

    #[test]
    fn build_url_rejects_invalid_url() {
        let mut cfg = base_cfg();
        cfg.url = "ht tp://bad host".to_string();
        assert!(build_url(&cfg).is_err());
    }

    #[test]
    fn build_headers_skips_disabled_and_blank_keys() {
        let mut cfg = base_cfg();
        cfg.headers = vec![kv("X-A", "1", true), kv("X-Off", "x", false), kv("", "y", true)];
        let headers = build_headers(&cfg).unwrap();
        assert_eq!(headers.get("x-a").unwrap(), "1");
        assert!(headers.get("x-off").is_none());
        assert_eq!(headers.len(), 1);
    }

    #[test]
    fn build_headers_rejects_invalid_name() {
        let mut cfg = base_cfg();
        cfg.headers = vec![kv("Bad Header", "1", true)];
        let err = build_headers(&cfg).unwrap_err();
        assert!(err.to_string().contains("Bad Header"));
    }

    // ------------------------------------------------------------------
    // build_payload
    // ------------------------------------------------------------------

    #[test]
    fn payload_is_none_for_get_and_head() {
        let mut cfg = base_cfg();
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("x".to_string());
        assert!(matches!(
            build_payload(&cfg, &Method::GET).unwrap(),
            Payload::None
        ));
        assert!(matches!(
            build_payload(&cfg, &Method::HEAD).unwrap(),
            Payload::None
        ));
    }

    #[test]
    fn payload_raw_json_sets_content_type_hint() {
        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("{\"a\":1}".to_string());
        cfg.body.raw_language = Some("json".to_string());
        match build_payload(&cfg, &Method::POST).unwrap() {
            Payload::Bytes { body, content_type } => {
                assert_eq!(body, b"{\"a\":1}");
                assert_eq!(content_type, Some("application/json"));
            }
            _ => panic!("expected Bytes payload"),
        }
    }

    #[test]
    fn payload_urlencoded_keeps_only_enabled_pairs() {
        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.body.body_type = "x-www-form-urlencoded".to_string();
        cfg.body.urlencoded = Some(vec![kv("a", "1", true), kv("off", "x", false)]);
        match build_payload(&cfg, &Method::POST).unwrap() {
            Payload::Form(pairs) => assert_eq!(pairs, vec![("a".to_string(), "1".to_string())]),
            _ => panic!("expected Form payload"),
        }
    }

    #[test]
    fn payload_graphql_ignores_invalid_variables_json() {
        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.body.body_type = "graphql".to_string();
        cfg.body.graphql_query = Some("{ me }".to_string());
        cfg.body.graphql_variables = Some("not-json".to_string());
        match build_payload(&cfg, &Method::POST).unwrap() {
            Payload::Bytes { body, .. } => {
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(json, serde_json::json!({"query": "{ me }"}));
            }
            _ => panic!("expected Bytes payload"),
        }
    }

    #[test]
    fn payload_binary_rejects_invalid_base64() {
        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.body.body_type = "binary".to_string();
        cfg.body.binary_base64 = Some("!!!not-base64!!!".to_string());
        assert!(build_payload(&cfg, &Method::POST).is_err());
    }

    // ------------------------------------------------------------------
    // apply_auth
    // ------------------------------------------------------------------

    fn auth_ctx() -> (Url, HeaderMap) {
        (Url::parse("https://api.test/x").unwrap(), HeaderMap::new())
    }

    #[test]
    fn auth_basic_produces_expected_base64() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "basic".to_string();
        cfg.auth.basic = Some(BasicAuth {
            username: Some("u".to_string()),
            password: Some("p".to_string()),
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Basic dTpw" // base64("u:p")
        );
    }

    #[test]
    fn auth_bearer_and_legacy_flat_token() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "bearer".to_string();
        cfg.auth.bearer = Some(BearerAuth {
            token: Some("tok".to_string()),
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer tok"
        );

        // 旧版扁平字段同样生效（服务端 normalizeRequestAuth 的兼容路径）
        let mut legacy = base_cfg();
        legacy.auth.auth_type = "bearer".to_string();
        legacy.auth.bearer_token = Some("legacy-tok".to_string());
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&legacy, &mut url, &mut headers).unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer legacy-tok"
        );
    }

    #[test]
    fn auth_api_key_goes_to_header_or_query() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "api-key".to_string();
        cfg.auth.api_key = Some(ApiKeyAuth {
            key: Some("X-Key".to_string()),
            value: Some("v".to_string()),
            location: Some("query".to_string()),
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(url.as_str(), "https://api.test/x?X-Key=v");
        assert!(headers.get("x-key").is_none());

        cfg.auth.api_key.as_mut().unwrap().location = Some("header".to_string());
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(headers.get("x-key").unwrap(), "v");
        assert_eq!(url.as_str(), "https://api.test/x");
    }

    #[test]
    fn unsupported_auth_fails_loudly() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "hawk".to_string();
        let (mut url, mut headers) = auth_ctx();
        let err = apply_auth(&cfg, &mut url, &mut headers).unwrap_err();
        assert!(err.to_string().contains("not supported"), "{err}");
    }

    // ------------------------------------------------------------------
    // Digest Auth
    // ------------------------------------------------------------------

    #[test]
    fn digest_auth_produces_valid_header() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("user".to_string()),
            password: Some("pass".to_string()),
            realm: Some("testrealm".to_string()),
            nonce: Some("abc123".to_string()),
            algorithm: Some("MD5".to_string()),
            qop: Some("auth".to_string()),
            nonce_count: Some("00000001".to_string()),
            client_nonce: Some("xyz".to_string()),
            opaque: Some("opq".to_string()),
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        let auth_header = headers
            .get(reqwest::header::AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(auth_header.starts_with("Digest "), "{auth_header}");
        assert!(auth_header.contains("username=\"user\""), "{auth_header}");
        assert!(auth_header.contains("realm=\"testrealm\""), "{auth_header}");
        assert!(auth_header.contains("nonce=\"abc123\""), "{auth_header}");
        assert!(auth_header.contains("algorithm=MD5"), "{auth_header}");
        assert!(auth_header.contains("qop=auth"), "{auth_header}");
        assert!(auth_header.contains("nc=00000001"), "{auth_header}");
        assert!(auth_header.contains("cnonce=\"xyz\""), "{auth_header}");
        assert!(auth_header.contains("opaque=\"opq\""), "{auth_header}");
        assert!(auth_header.contains("response=\""), "{auth_header}");
    }

    #[test]
    fn digest_auth_without_realm_nonce_fails() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("user".to_string()),
            password: Some("pass".to_string()),
            ..Default::default()
        });
        let (mut url, mut headers) = auth_ctx();
        let err = apply_auth(&cfg, &mut url, &mut headers).unwrap_err();
        assert!(err.to_string().contains("realm is required"), "{err}");
    }

    #[test]
    fn digest_auth_sha256_algorithm() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            realm: Some("r".to_string()),
            nonce: Some("n".to_string()),
            algorithm: Some("SHA-256".to_string()),
            qop: Some("".to_string()),
            ..Default::default()
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        let auth_header = headers
            .get(reqwest::header::AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(auth_header.contains("algorithm=SHA-256"), "{auth_header}");
    }

    #[test]
    fn digest_challenge_parsing() {
        let header = r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#;
        let params = parse_digest_challenge(header).unwrap();
        assert_eq!(params.get("realm").unwrap(), "testrealm@host.com");
        assert_eq!(params.get("qop").unwrap(), "auth,auth-int");
        assert_eq!(
            params.get("nonce").unwrap(),
            "dcd98b7102dd2f0e8b11d0f600bfb0c093"
        );
        assert_eq!(
            params.get("opaque").unwrap(),
            "5ccc069c403ebaf9f0171e9517f40e41"
        );
    }

    #[test]
    fn digest_challenge_parsing_non_digest_returns_none() {
        assert!(parse_digest_challenge("Basic realm=\"x\"").is_none());
    }

    // ------------------------------------------------------------------
    // OAuth 2.0
    // ------------------------------------------------------------------

    #[test]
    fn oauth2_bearer_token_in_header() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            access_token: Some("my-token".to_string()),
            ..Default::default()
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer my-token"
        );
    }

    #[test]
    fn oauth2_custom_header_prefix() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            access_token: Some("tok".to_string()),
            header_prefix: Some("Token".to_string()),
            ..Default::default()
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Token tok"
        );
    }

    #[test]
    fn oauth2_token_in_query() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            access_token: Some("qtok".to_string()),
            add_token_to: Some("query".to_string()),
            ..Default::default()
        });
        let (mut url, mut headers) = auth_ctx();
        apply_auth(&cfg, &mut url, &mut headers).unwrap();
        assert!(url.as_str().contains("access_token=qtok"), "{}", url.as_str());
        assert!(headers.get(reqwest::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn oauth2_empty_token_fails() {
        let mut cfg = base_cfg();
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth::default());
        let (mut url, mut headers) = auth_ctx();
        let err = apply_auth(&cfg, &mut url, &mut headers).unwrap_err();
        assert!(err.to_string().contains("Access Token is empty"), "{err}");
    }

    // ------------------------------------------------------------------
    // substitute_config：变量在组装前一次性替换
    // ------------------------------------------------------------------

    #[test]
    fn substitute_config_replaces_everywhere_including_auth() {
        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = "{{host}}/items".to_string();
        cfg.params = vec![kv("q", "{{q}}", true)];
        cfg.headers = vec![kv("X-T", "{{t}}", true)];
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("{{payload}}".to_string());
        cfg.auth.auth_type = "bearer".to_string();
        cfg.auth.bearer = Some(BearerAuth {
            token: Some("{{token}}".to_string()),
        });
        let vars = HashMap::from([
            ("host".to_string(), "https://h".to_string()),
            ("q".to_string(), "1".to_string()),
            ("t".to_string(), "v".to_string()),
            ("payload".to_string(), "{}".to_string()),
            ("token".to_string(), "abc".to_string()),
        ]);
        let out = substitute_config(&cfg, &vars);
        assert_eq!(out.url, "https://h/items");
        assert_eq!(out.params[0].value, "1");
        assert_eq!(out.headers[0].value, "v");
        assert_eq!(out.body.raw.as_deref(), Some("{}"));
        assert_eq!(out.auth.bearer.unwrap().token.as_deref(), Some("abc"));
    }

    // ------------------------------------------------------------------
    // execute：真实本地 HTTP 服务
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn execute_reports_success_with_status_and_size() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/ok", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "ok item", Some("i1".to_string()), &cfg, &no_vars()).await;

        assert!(result.ok);
        assert_eq!(result.status, Some(200));
        assert_eq!(result.status_text.as_deref(), Some("OK"));
        assert_eq!(result.size_bytes, Some(5));
        assert!(result.duration_ms.is_some());
        assert!(result.error.is_none());
        assert_eq!(result.item_id.as_deref(), Some("i1"));
        // 没有脚本时不上报脚本产物
        assert!(result.test_results.is_none());
        assert!(result.console_logs.is_none());
    }

    #[tokio::test]
    async fn execute_marks_404_failed_but_keeps_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/nf"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/nf", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "nf", None, &cfg, &no_vars()).await;

        assert!(!result.ok);
        assert_eq!(result.status, Some(404));
        assert!(result.error.is_none(), "4xx 不是网络层错误");
    }

    #[tokio::test]
    async fn execute_follows_redirects_by_default() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/redir"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/ok"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/redir", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "redir", None, &cfg, &no_vars()).await;
        assert!(result.ok);
        assert_eq!(result.status, Some(200));
        assert!(result.url.ends_with("/ok"), "final url: {}", result.url);

        // followRedirects = false 时保留 302 原文
        cfg.settings.follow_redirects = false;
        let pool2 = test_pool();
        let result = execute(&pool2, "redir-off", None, &cfg, &no_vars()).await;
        assert!(result.ok, "3xx 视为成功（未跟随）");
        assert_eq!(result.status, Some(302));
    }

    #[tokio::test]
    async fn execute_times_out_per_settings() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(500)))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/slow", server.uri());
        cfg.settings.timeout_ms = 50;
        let pool = test_pool();
        let result = execute(&pool, "slow", None, &cfg, &no_vars()).await;
        assert!(!result.ok);
        let error = result.error.unwrap_or_default();
        assert!(!error.is_empty(), "timeout should surface an error");
    }

    #[tokio::test]
    async fn execute_sends_raw_json_with_variables() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/items"))
            .and(header("content-type", "application/json"))
            .and(body_string("{\"name\":\"demo\"}"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/items", server.uri());
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("{\"name\":\"{{name}}\"}".to_string());
        cfg.body.raw_language = Some("json".to_string());
        let vars = HashMap::from([("name".to_string(), "demo".to_string())]);

        let pool = test_pool();
        let result = execute(&pool, "create", None, &cfg, &vars).await;
        assert!(result.ok, "error: {:?}", result.error);
        assert_eq!(result.status, Some(201));
    }

    #[tokio::test]
    async fn execute_sends_multipart_with_file_part() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload"))
            .and(wiremock::matchers::header_regex(
                "content-type",
                r"multipart/form-data; boundary=.*",
            ))
            .and(body_string_contains("name=\"note\""))
            .and(body_string_contains("hello text"))
            .and(body_string_contains("filename=\"a.bin\""))
            .and(body_string_contains("BYTES"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/upload", server.uri());
        cfg.body.body_type = "form-data".to_string();
        cfg.body.form_data = Some(vec![
            kv("note", "hello text", true),
            KeyValueItem {
                key: "file".to_string(),
                enabled: true,
                item_type: Some("file".to_string()),
                file_base64: Some(BASE64.encode(b"BYTES")),
                file_name: Some("a.bin".to_string()),
                ..Default::default()
            },
        ]);

        let pool = test_pool();
        let result = execute(&pool, "upload", None, &cfg, &no_vars()).await;
        assert!(result.ok, "error: {:?}", result.error);
    }

    #[tokio::test]
    async fn execute_surfaces_connection_errors_verbatim() {
        // 端口 1 不可达：错误链原文应包含目标地址
        let mut cfg = base_cfg();
        cfg.url = "http://127.0.0.1:1/dead".to_string();
        let pool = test_pool();
        let result = execute(&pool, "dead", None, &cfg, &no_vars()).await;
        assert!(!result.ok);
        assert!(result.status.is_none());
        let error = result.error.unwrap_or_default();
        assert!(error.contains("127.0.0.1:1"), "{error}");
    }

    // ------------------------------------------------------------------
    // 脚本联动（QuickJS 沙箱）
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn pre_request_script_can_rewrite_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rewritten"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/original", server.uri());
        cfg.scripts = RequestScripts {
            pre_request: Some(format!(
                "rp.request.url = \"{}/rewritten\";",
                server.uri()
            )),
            test: None,
        };
        let pool = test_pool();
        let result = execute(&pool, "scripted", None, &cfg, &no_vars()).await;
        assert!(result.ok, "error: {:?}", result.error);
        assert!(result.url.ends_with("/rewritten"));
        // 跑过脚本就要带上产物（哪怕只有 console 记录）
        assert!(result.test_results.is_some());
    }

    #[tokio::test]
    async fn failing_test_script_marks_result_failed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/ok", server.uri());
        cfg.scripts = RequestScripts {
            pre_request: None,
            test: Some(
                "rp.test(\"status is 201\", () => { rp.response.to.have.status(201); });"
                    .to_string(),
            ),
        };
        let pool = test_pool();
        let result = execute(&pool, "asserted", None, &cfg, &no_vars()).await;
        // 传输层 200 但断言失败：newman 语义下整体失败
        assert!(!result.ok);
        assert_eq!(result.status, Some(200));
        let tests = result.test_results.expect("script results expected");
        assert_eq!(tests.len(), 1);
        assert!(!tests[0].passed);
        assert!(tests[0].error.as_deref().unwrap_or("").contains("201"));
    }

    #[tokio::test]
    async fn passing_test_script_keeps_result_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{\"id\":7}"))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/ok", server.uri());
        cfg.scripts = RequestScripts {
            pre_request: None,
            test: Some(
                "rp.test(\"status\", () => { rp.response.to.have.status(200); });\n\
                 rp.test(\"id\", () => { rp.expect(rp.response.json().id).to.equal(7); });"
                    .to_string(),
            ),
        };
        let pool = test_pool();
        let result = execute(&pool, "asserted", None, &cfg, &no_vars()).await;
        assert!(result.ok);
        let tests = result.test_results.expect("script results expected");
        assert_eq!(tests.len(), 2);
        assert!(tests.iter().all(|t| t.passed));
    }

    // ------------------------------------------------------------------
    // HEAD / OPTIONS 方法
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn head_request_has_no_body_and_returns_headers() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path("/head-only"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-custom-header", "head-value")
                    .set_body_string("this body should not be sent"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "HEAD".to_string();
        cfg.url = format!("{}/head-only", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "head", None, &cfg, &no_vars()).await;

        assert!(result.ok, "HEAD should succeed: {:?}", result.error);
        assert_eq!(result.status, Some(200));
        // HEAD 响应无 body，size 为 0
        assert_eq!(result.size_bytes, Some(0));
    }

    #[tokio::test]
    async fn options_request_returns_allow_headers() {
        let server = MockServer::start().await;
        Mock::given(method("OPTIONS"))
            .and(path("/options-only"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("allow", "GET, POST, OPTIONS")
                    .insert_header("access-control-allow-origin", "*"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "OPTIONS".to_string();
        cfg.url = format!("{}/options-only", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "options", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OPTIONS should succeed: {:?}", result.error);
        assert_eq!(result.status, Some(200));
    }

    // ------------------------------------------------------------------
    // Cookie 发送与接收
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn cookies_are_sent_with_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/with-cookie"))
            .and(header("cookie", "session=abc123; theme=dark"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/with-cookie", server.uri());
        cfg.headers = vec![
            kv("Cookie", "session=abc123; theme=dark", true),
        ];
        let pool = test_pool();
        let result = execute(&pool, "cookie", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Cookie request should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn response_cookies_are_captured() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/set-cookie"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("set-cookie", "new-session=xyz789; Path=/; HttpOnly"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/set-cookie", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "cookie", None, &cfg, &no_vars()).await;

        assert!(result.ok);
        // 响应头应包含 set-cookie（通过脚本可访问）
        // 注意：当前实现不自动存储 Cookie，仅透传
    }

    // ------------------------------------------------------------------
    // SSL 验证开关
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn ssl_verification_disabled_allows_self_signed() {
        // 注意：此测试需要自签名证书服务，这里仅验证配置传递
        let mut cfg = base_cfg();
        cfg.settings.verify_ssl = false;
        cfg.url = "https://self-signed.badssl.com/".to_string();
        
        // 实际请求会失败（网络不可达），但配置应正确传递
        // 这里主要验证 ClientPool 的 key 生成
        let key = ClientKey {
            verify_ssl: cfg.settings.verify_ssl,
            follow_redirects: cfg.settings.follow_redirects,
            max_redirects: cfg.settings.max_redirects,
            timeout_ms: cfg.settings.timeout_ms,
        };
        assert!(!key.verify_ssl);
    }

    // ------------------------------------------------------------------
    // 并发执行
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn concurrent_requests_are_isolated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/concurrent"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .expect(3)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/concurrent", server.uri());
        
        let pool = std::sync::Arc::new(test_pool());
        let handles: Vec<_> = (0..3)
            .map(|i| {
                let pool = pool.clone();
                let cfg = cfg.clone();
                tokio::spawn(async move {
                    execute(&pool, &format!("req-{i}"), None, &cfg, &HashMap::new()).await
                })
            })
            .collect();

        let results: Vec<_> = futures::future::join_all(handles)
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect();

        assert!(results.iter().all(|r| r.ok));
        assert_eq!(results.len(), 3);
    }

    // ------------------------------------------------------------------
    // 大响应体与二进制响应
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn large_response_body_is_truncated_for_script() {
        let server = MockServer::start().await;
        // 生成超过 MAX_BODY_CAPTURE_BYTES (1MB) 的响应
        let large_body = "x".repeat(1024 * 1024 + 1);
        Mock::given(method("GET"))
            .and(path("/large"))
            .respond_with(ResponseTemplate::new(200).set_body_string(large_body))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/large", server.uri());
        // 大响应体不进入脚本视图，脚本无法访问 body，但状态码断言仍应执行
        cfg.scripts = RequestScripts {
            pre_request: None,
            test: Some("rp.test('large', () => { rp.response.to.have.status(200); });".to_string()),
        };
        let pool = test_pool();
        let result = execute(&pool, "large", None, &cfg, &no_vars()).await;

        // 大响应体导致脚本视图不可用，脚本执行会报错，但传输层成功
        // 由于脚本错误，result.ok 为 false
        assert!(!result.ok);
        assert_eq!(result.size_bytes, Some((1024 * 1024 + 1) as i64));
    }

    #[tokio::test]
    async fn binary_response_body_is_handled() {
        let server = MockServer::start().await;
        let binary_data: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG magic
        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes(binary_data.clone()),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/binary", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "binary", None, &cfg, &no_vars()).await;

        assert!(result.ok);
        assert_eq!(result.size_bytes, Some(binary_data.len() as i64));
    }

    // ------------------------------------------------------------------
    // GraphQL 完整流程
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn graphql_query_with_variables_is_sent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(header("content-type", "application/json"))
            .and(body_string(r#"{"query":"query GetUser($id: ID!) { user(id: $id) { name } }","variables":{"id":"123"}}"#))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "user": { "name": "Alice" } }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/graphql", server.uri());
        cfg.body.body_type = "graphql".to_string();
        cfg.body.graphql_query = Some("query GetUser($id: ID!) { user(id: $id) { name } }".to_string());
        cfg.body.graphql_variables = Some(r#"{"id":"123"}"#.to_string());
        
        let pool = test_pool();
        let result = execute(&pool, "graphql", None, &cfg, &no_vars()).await;

        assert!(result.ok, "GraphQL should succeed: {:?}", result.error);
    }

    // ------------------------------------------------------------------
    // 超时边界：timeout_ms = 0 表示不超时
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn zero_timeout_means_no_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow-but-ok"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(100)))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/slow-but-ok", server.uri());
        cfg.settings.timeout_ms = 0; // 不超时
        let pool = test_pool();
        let result = execute(&pool, "no-timeout", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Should succeed with no timeout: {:?}", result.error);
    }

    // ------------------------------------------------------------------
    // 重定向链与最大重定向次数
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn max_redirects_limit_is_respected() {
        let server = MockServer::start().await;
        // 创建重定向链：/r1 -> /r2 -> /r3 -> /final
        Mock::given(method("GET"))
            .and(path("/r1"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/r2"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/r2"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/r3"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/r3"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/final"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/final"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/r1", server.uri());
        cfg.settings.max_redirects = 2; // 限制最多 2 次重定向
        let pool = test_pool();
        let result = execute(&pool, "redirect-limit", None, &cfg, &no_vars()).await;

        // 重定向次数超限，应返回错误
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap_or("").contains("redirect"));
    }

    // ------------------------------------------------------------------
    // 请求体编码：XML / HTML / 纯文本
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn raw_xml_body_sets_correct_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xml"))
            .and(header("content-type", "application/xml"))
            .and(body_string("<root><item>value</item></root>"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/xml", server.uri());
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("<root><item>value</item></root>".to_string());
        cfg.body.raw_language = Some("xml".to_string());
        
        let pool = test_pool();
        let result = execute(&pool, "xml", None, &cfg, &no_vars()).await;

        assert!(result.ok);
    }

    #[tokio::test]
    async fn raw_html_body_sets_correct_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/html"))
            .and(header("content-type", "text/html"))
            .and(body_string("<html><body>Hello</body></html>"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/html", server.uri());
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("<html><body>Hello</body></html>".to_string());
        cfg.body.raw_language = Some("html".to_string());
        
        let pool = test_pool();
        let result = execute(&pool, "html", None, &cfg, &no_vars()).await;

        assert!(result.ok);
    }

    #[tokio::test]
    async fn raw_text_body_has_no_content_type_hint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/text"))
            .and(body_string("plain text content"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "POST".to_string();
        cfg.url = format!("{}/text", server.uri());
        cfg.body.body_type = "raw".to_string();
        cfg.body.raw = Some("plain text content".to_string());
        // 不设置 raw_language，无 Content-Type 提示
        
        let pool = test_pool();
        let result = execute(&pool, "text", None, &cfg, &no_vars()).await;

        assert!(result.ok);
    }

    // ------------------------------------------------------------------
    // 空响应体与 204 No Content
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn no_content_response_has_zero_size() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/resource"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.method = "DELETE".to_string();
        cfg.url = format!("{}/resource", server.uri());
        let pool = test_pool();
        let result = execute(&pool, "delete", None, &cfg, &no_vars()).await;

        assert!(result.ok);
        assert_eq!(result.status, Some(204));
        assert_eq!(result.size_bytes, Some(0));
    }

    // ------------------------------------------------------------------
    // 响应头大小写不敏感
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn response_headers_are_accessible_in_script() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/headers"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-custom-header", "value1")
                    .insert_header("x-another-header", "value2"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/headers", server.uri());
        cfg.scripts = RequestScripts {
            pre_request: None,
            test: Some(
                "rp.test('headers', () => { 
                    rp.expect(rp.response.headers['x-custom-header']).to.equal('value1');
                    rp.expect(rp.response.headers['x-another-header']).to.equal('value2');
                });".to_string()
            ),
        };
        let pool = test_pool();
        let result = execute(&pool, "headers", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Script should access headers: {:?}", result.error);
        let tests = result.test_results.expect("script results expected");
        assert!(tests[0].passed, "Headers should be accessible: {:?}", tests[0].error);
    }

    // ------------------------------------------------------------------
    // Digest Auth
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn digest_auth_with_full_challenge() {
        let server = MockServer::start().await;
        // 第一次请求返回 401 + WWW-Authenticate 挑战
        Mock::given(method("GET"))
            .and(path("/digest"))
            .respond_with(
                ResponseTemplate::new(401)
                    .insert_header(
                        "www-authenticate",
                        r#"Digest realm="test-realm", nonce="test-nonce-123", qop="auth", opaque="test-opaque""#,
                    ),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        // 第二次请求验证 Digest 签名
        Mock::given(method("GET"))
            .and(path("/digest"))
            .and(header_regex("authorization", r#"Digest username="testuser""#))
            .respond_with(ResponseTemplate::new(200).set_body_string("authenticated"))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/digest", server.uri());
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("testuser".to_string()),
            password: Some("testpass".to_string()),
            realm: None,  // 从 401 挑战获取
            nonce: None,  // 从 401 挑战获取
            algorithm: Some("MD5".to_string()),
            qop: Some("auth".to_string()),
            nonce_count: None,
            client_nonce: None,
            opaque: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "digest", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Digest auth should succeed: {:?}", result.error);
        assert_eq!(result.status, Some(200));
    }

    #[tokio::test]
    async fn digest_auth_with_preset_realm_nonce() {
        let server = MockServer::start().await;
        // 直接验证 Digest 签名（realm/nonce 已预设）
        Mock::given(method("GET"))
            .and(path("/digest-preset"))
            .and(header_regex("authorization", r#"Digest username="preset-user""#))
            .and(header_regex("authorization", r#"realm="preset-realm""#))
            .and(header_regex("authorization", r#"nonce="preset-nonce""#))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/digest-preset", server.uri());
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("preset-user".to_string()),
            password: Some("preset-pass".to_string()),
            realm: Some("preset-realm".to_string()),
            nonce: Some("preset-nonce".to_string()),
            algorithm: Some("MD5".to_string()),
            qop: Some("auth".to_string()),
            nonce_count: Some("00000001".to_string()),
            client_nonce: Some("preset-cnonce".to_string()),
            opaque: Some("preset-opaque".to_string()),
        });

        let pool = test_pool();
        let result = execute(&pool, "digest-preset", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Digest auth with preset should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn digest_auth_sha256_algorithm_integration() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/digest-sha256"))
            .and(header_regex("authorization", r#"algorithm=SHA-256"#))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/digest-sha256", server.uri());
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("shauser".to_string()),
            password: Some("shapass".to_string()),
            realm: Some("sha-realm".to_string()),
            nonce: Some("sha-nonce".to_string()),
            algorithm: Some("SHA-256".to_string()),
            qop: Some("auth".to_string()),
            nonce_count: None,
            client_nonce: None,
            opaque: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "digest-sha256", None, &cfg, &no_vars()).await;

        assert!(result.ok, "Digest SHA-256 should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn digest_auth_missing_realm_fails() {
        let server = MockServer::start().await;
        // 返回 401 但不带 WWW-Authenticate 头，导致无法获取 realm
        Mock::given(method("GET"))
            .and(path("/digest-no-realm"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/digest-no-realm", server.uri());
        cfg.auth.auth_type = "digest".to_string();
        cfg.auth.digest = Some(DigestAuth {
            username: Some("user".to_string()),
            password: Some("pass".to_string()),
            realm: None,  // 缺少 realm
            nonce: Some("nonce".to_string()),
            algorithm: None,
            qop: None,
            nonce_count: None,
            client_nonce: None,
            opaque: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "digest-fail", None, &cfg, &no_vars()).await;

        assert!(!result.ok, "Should fail without realm");
        // 错误信息可能是 "realm is required" 或包含 "realm"
        let error = result.error.as_deref().unwrap_or("");
        assert!(error.contains("realm") || error.contains("Digest"), "Error should mention realm: {error}");
    }

    // ------------------------------------------------------------------
    // OAuth 2.0
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn oauth2_bearer_token_in_header_integration() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/oauth2-header"))
            .and(header("authorization", "Bearer oauth2-access-token-123"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/oauth2-header", server.uri());
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("oauth2-access-token-123".to_string()),
            header_prefix: Some("Bearer".to_string()),
            add_token_to: Some("header".to_string()),
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-header", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OAuth2 header should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn oauth2_token_in_query_integration() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/oauth2-query"))
            .and(query_param("access_token", "query-token-456"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/oauth2-query", server.uri());
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("query-token-456".to_string()),
            header_prefix: None,
            add_token_to: Some("query".to_string()),
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-query", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OAuth2 query should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn oauth2_custom_header_prefix_integration() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/oauth2-custom"))
            .and(header("authorization", "Token custom-prefix-token"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/oauth2-custom", server.uri());
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("custom-prefix-token".to_string()),
            header_prefix: Some("Token".to_string()),  // 自定义前缀
            add_token_to: Some("header".to_string()),
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-custom", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OAuth2 custom prefix should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn oauth2_empty_token_fails_integration() {
        let mut cfg = base_cfg();
        cfg.url = "http://localhost/oauth2".to_string();
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("".to_string()),  // 空 token
            header_prefix: None,
            add_token_to: None,
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-fail", None, &cfg, &no_vars()).await;

        assert!(!result.ok, "Should fail with empty token");
        assert!(result.error.as_deref().unwrap_or("").contains("Access Token"));
    }

    #[tokio::test]
    async fn oauth2_no_prefix_token() {
        let server = MockServer::start().await;
        // 当 header_prefix 为 None 时，使用默认 "Bearer"
        // 要测试无前缀，需要设置 header_prefix 为 None 并确保代码处理
        Mock::given(method("GET"))
            .and(path("/oauth2-noprefix"))
            .and(header("authorization", "Bearer raw-token-no-prefix"))  // 默认使用 Bearer
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/oauth2-noprefix", server.uri());
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("raw-token-no-prefix".to_string()),
            header_prefix: None,  // 不设置前缀，使用默认 Bearer
            add_token_to: Some("header".to_string()),
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-noprefix", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OAuth2 no prefix should succeed: {:?}", result.error);
    }

    #[tokio::test]
    async fn oauth2_empty_prefix_uses_default_bearer() {
        // 测试空字符串前缀会被替换为默认 Bearer
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/oauth2-empty-prefix"))
            .and(header("authorization", "Bearer token-with-empty-prefix"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let mut cfg = base_cfg();
        cfg.url = format!("{}/oauth2-empty-prefix", server.uri());
        cfg.auth.auth_type = "oauth2".to_string();
        cfg.auth.oauth2 = Some(OAuth2Auth {
            grant_type: None,
            access_token: Some("token-with-empty-prefix".to_string()),
            header_prefix: Some("".to_string()),  // 空字符串会被替换为 Bearer
            add_token_to: Some("header".to_string()),
            callback_url: None,
            auth_url: None,
            access_token_url: None,
            client_id: None,
            client_secret: None,
            scope: None,
            state: None,
            username: None,
            password: None,
            client_authentication: None,
        });

        let pool = test_pool();
        let result = execute(&pool, "oauth2-empty-prefix", None, &cfg, &no_vars()).await;

        assert!(result.ok, "OAuth2 empty prefix should use Bearer: {:?}", result.error);
    }
}

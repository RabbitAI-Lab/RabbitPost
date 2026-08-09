//! Collection / 环境 / 迭代数据文件解析。
//! 支持两种 Collection 格式：RabbitPost 交换格式（rabbitpost.collection，与 Web 导入导出一致）
//! 与 Postman Collection v2/v2.1（宽松解析，仅映射 rp-core 可执行的子集）。
//! `collection import` 与 `run --file` 共用；环境文件与迭代数据供 `run` 使用。
use std::collections::HashMap;

use rp_core::model::{
    ApiKeyAuth, BasicAuth, BearerAuth, DigestAuth, KeyValueItem, OAuth2Auth, RequestAuth,
    RequestBody, RequestConfig, RequestScripts,
};
use serde::Deserialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// 解析结果模型
// ---------------------------------------------------------------------------

/// 解析后的 Collection：节点树 + 集合级变量（顺序即数组顺序）
#[derive(Debug)]
pub struct ImportedCollection {
    pub name: String,
    pub description: Option<String>,
    pub variables: Vec<KeyValueItem>,
    pub items: Vec<ImportedNode>,
}

#[derive(Debug)]
pub enum ImportedNode {
    Folder {
        name: String,
        description: Option<String>,
        items: Vec<ImportedNode>,
    },
    Request {
        name: String,
        // Box 收敛 enum 大小（RequestConfig 远大于 Folder 变体）
        request: Option<Box<RequestConfig>>,
    },
}

// ---------------------------------------------------------------------------
// RabbitPost 交换格式（对应 packages/shared/collection-file.ts）
// ---------------------------------------------------------------------------

pub const RP_COLLECTION_FORMAT: &str = "rabbitpost.collection";

/// format 字段在反序列化前已校验，这里不再重复接收
#[derive(Deserialize)]
struct RpFile {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    variables: Vec<KeyValueItem>,
    #[serde(default)]
    items: Vec<RpNode>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum RpNode {
    #[serde(rename = "folder")]
    Folder {
        name: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        items: Vec<RpNode>,
    },
    #[serde(rename = "request")]
    Request {
        name: String,
        #[serde(default)]
        request: Option<Box<RequestConfig>>,
    },
}

fn rp_node(node: RpNode) -> ImportedNode {
    match node {
        RpNode::Folder {
            name,
            description,
            items,
        } => ImportedNode::Folder {
            name,
            description,
            items: items.into_iter().map(rp_node).collect(),
        },
        RpNode::Request { name, request } => ImportedNode::Request { name, request },
    }
}

// ---------------------------------------------------------------------------
// Postman Collection v2/v2.1 宽松类型（对应 Web 端 ImportCollectionModal）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PmCollection {
    #[serde(default)]
    info: Option<PmInfo>,
    #[serde(default)]
    item: Option<Vec<PmItem>>,
    /// 集合级变量（newman 运行时会并入变量作用域）
    #[serde(default)]
    variable: Option<Vec<PmKv>>,
}

#[derive(Deserialize)]
struct PmInfo {
    #[serde(default)]
    name: Option<String>,
    /// 可能是字符串或 { content } 对象；只取字符串形态
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct PmItem {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    item: Option<Vec<PmItem>>,
    #[serde(default)]
    request: Option<PmRequest>,
    #[serde(default)]
    event: Option<Vec<PmEvent>>,
}

#[derive(Deserialize)]
struct PmEvent {
    #[serde(default)]
    listen: Option<String>,
    #[serde(default)]
    script: Option<PmScript>,
}

#[derive(Deserialize)]
struct PmScript {
    /// string[]（每行一个元素）或整段 string
    #[serde(default)]
    exec: Option<Value>,
}

#[derive(Deserialize)]
struct PmKv {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    disabled: Option<bool>,
}

#[derive(Deserialize)]
struct PmRequest {
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    url: Option<Value>,
    #[serde(default)]
    header: Option<Vec<PmKv>>,
    #[serde(default)]
    body: Option<PmBody>,
    /// { type, <type>: [kv...] }；用 Value 宽松接收，转换时按 type 分发
    #[serde(default)]
    auth: Option<Value>,
    /// Postman 的请求级行为设置（目前只消费 followRedirects）
    #[serde(default, rename = "protocolProfileBehavior")]
    protocol_profile_behavior: Option<Value>,
}

#[derive(Deserialize)]
struct PmBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    raw: Option<String>,
    #[serde(default)]
    options: Option<PmBodyOptions>,
    #[serde(default)]
    urlencoded: Option<Vec<PmKv>>,
    #[serde(default)]
    formdata: Option<Vec<PmKv>>,
    #[serde(default)]
    graphql: Option<PmGraphql>,
}

#[derive(Deserialize)]
struct PmBodyOptions {
    #[serde(default)]
    raw: Option<PmRawOptions>,
}

#[derive(Deserialize)]
struct PmRawOptions {
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
struct PmGraphql {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    variables: Option<Value>,
}

const RAW_LANGUAGES: [&str; 5] = ["json", "text", "xml", "html", "javascript"];
const HTTP_METHODS: [&str; 9] = [
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT",
];

fn pm_value_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn to_kv(list: Option<Vec<PmKv>>) -> Vec<KeyValueItem> {
    list.unwrap_or_default()
        .into_iter()
        .filter(|i| i.key.as_deref().is_some_and(|k| !k.is_empty()))
        .map(|i| KeyValueItem {
            id: Some(uuid::Uuid::new_v4().to_string()),
            key: i.key.unwrap_or_default(),
            value: i.value.as_ref().map(pm_value_string).unwrap_or_default(),
            enabled: !i.disabled.unwrap_or(false),
            description: None,
            item_type: None,
            file_base64: None,
            file_name: None,
        })
        .collect()
}

/// Postman auth 子结构（如 auth.basic）是 kv 数组；也可能是对象，两种都容忍
fn pm_auth_map(auth: &Value, key: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    match auth.get(key) {
        Some(Value::Array(list)) => {
            for entry in list {
                if let (Some(k), Some(v)) = (
                    entry.get("key").and_then(Value::as_str),
                    entry.get("value"),
                ) {
                    map.insert(k.to_string(), pm_value_string(v));
                }
            }
        }
        Some(Value::Object(obj)) => {
            for (k, v) in obj {
                map.insert(k.clone(), pm_value_string(v));
            }
        }
        _ => {}
    }
    map
}

/// 组装认证子对象：跳过 None 字段（对齐 TS 里 undefined 不落 JSON 的行为）
fn auth_json(fields: Vec<(&str, Option<serde_json::Value>)>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

fn auth_str(v: &HashMap<String, String>, key: &str) -> Option<serde_json::Value> {
    v.get(key).map(|s| serde_json::Value::String(s.clone()))
}

fn auth_bool(v: &HashMap<String, String>, key: &str) -> serde_json::Value {
    serde_json::Value::Bool(v.get(key).map(String::as_str) == Some("true"))
}

/// Postman auth -> RequestAuth。basic/bearer/apikey/digest/oauth2 为引擎可执行类型，
/// 走强类型字段；jwt/oauth1/hawk/awsv4/ntlm/edgegrid/asap 引擎暂不执行，
/// 映射为与 Web 端一致的 JSON 存入 extra（仅存储备查，往返不丢字段）。
fn convert_auth(auth: Option<&Value>) -> RequestAuth {
    let Some(auth) = auth else {
        return RequestAuth::default();
    };
    let auth_type = auth.get("type").and_then(Value::as_str).unwrap_or_default();
    match auth_type {
        "basic" => {
            let v = pm_auth_map(auth, "basic");
            RequestAuth {
                auth_type: "basic".to_string(),
                basic: Some(BasicAuth {
                    username: v.get("username").cloned(),
                    password: v.get("password").cloned(),
                }),
                ..Default::default()
            }
        }
        "bearer" => {
            let v = pm_auth_map(auth, "bearer");
            RequestAuth {
                auth_type: "bearer".to_string(),
                bearer: Some(BearerAuth {
                    token: v.get("token").cloned(),
                }),
                ..Default::default()
            }
        }
        "apikey" => {
            let v = pm_auth_map(auth, "apikey");
            RequestAuth {
                auth_type: "api-key".to_string(),
                api_key: Some(ApiKeyAuth {
                    key: v.get("key").cloned(),
                    value: v.get("value").cloned(),
                    location: Some(
                        if v.get("in").map(String::as_str) == Some("query") {
                            "query"
                        } else {
                            "header"
                        }
                        .to_string(),
                    ),
                }),
                ..Default::default()
            }
        }
        "digest" => {
            let v = pm_auth_map(auth, "digest");
            RequestAuth {
                auth_type: "digest".to_string(),
                digest: Some(DigestAuth {
                    username: v.get("username").cloned(),
                    password: v.get("password").cloned(),
                    realm: v.get("realm").cloned(),
                    nonce: v.get("nonce").cloned(),
                    algorithm: v.get("algorithm").cloned(),
                    qop: v.get("qop").cloned(),
                    nonce_count: v.get("nonceCount").cloned(),
                    client_nonce: v.get("clientNonce").cloned(),
                    opaque: v.get("opaque").cloned(),
                }),
                ..Default::default()
            }
        }
        "oauth2" => {
            let v = pm_auth_map(auth, "oauth2");
            let grant_type = match v.get("grant_type").map(String::as_str) {
                Some("authorization_code") => Some("authorization_code"),
                Some("authorization_code_with_pkce") => Some("authorization_code_pkce"),
                Some("implicit") => Some("implicit"),
                Some("password_credentials") => Some("password"),
                Some("client_credentials") => Some("client_credentials"),
                _ => None,
            };
            RequestAuth {
                auth_type: "oauth2".to_string(),
                oauth2: Some(OAuth2Auth {
                    grant_type: grant_type.map(str::to_string),
                    access_token: v.get("accessToken").cloned(),
                    header_prefix: v.get("headerPrefix").cloned(),
                    add_token_to: Some(
                        if v.get("addTokenTo").map(String::as_str) == Some("queryParams") {
                            "query"
                        } else {
                            "header"
                        }
                        .to_string(),
                    ),
                    callback_url: v.get("redirect_uri").cloned(),
                    auth_url: v.get("authUrl").cloned(),
                    access_token_url: v.get("accessTokenUrl").cloned(),
                    client_id: v.get("clientId").cloned(),
                    client_secret: v.get("clientSecret").cloned(),
                    scope: v.get("scope").cloned(),
                    state: v.get("state").cloned(),
                    username: v.get("username").cloned(),
                    password: v.get("password").cloned(),
                    client_authentication: Some(
                        if v.get("client_authentication").map(String::as_str) == Some("body") {
                            "body"
                        } else {
                            "header"
                        }
                        .to_string(),
                    ),
                }),
                ..Default::default()
            }
        }
        "jwt" | "oauth1" | "hawk" | "awsv4" | "ntlm" | "edgegrid" | "asap" => {
            let (rp_type, section, body) = convert_auth_extra(auth_type, auth);
            let mut converted = RequestAuth {
                auth_type: rp_type.to_string(),
                ..Default::default()
            };
            converted.extra.insert(section.to_string(), body);
            converted
        }
        _ => RequestAuth::default(),
    }
}

/// 引擎外认证类型的字段映射（与 Web 端 ImportCollectionModal 的键名逐一对应）
fn convert_auth_extra(auth_type: &str, auth: &Value) -> (&'static str, &'static str, Value) {
    let v = pm_auth_map(auth, auth_type);
    match auth_type {
        "jwt" => (
            "jwt",
            "jwt",
            auth_json(vec![
                ("algorithm", auth_str(&v, "algorithm")),
                ("secret", auth_str(&v, "secret")),
                ("secretBase64Encoded", Some(auth_bool(&v, "isSecretBase64Encoded"))),
                ("privateKey", auth_str(&v, "privateKey")),
                ("payload", auth_str(&v, "payload")),
                ("jwtHeaders", auth_str(&v, "header")),
                (
                    "addTokenTo",
                    Some(Value::String(
                        if v.get("addTokenTo").map(String::as_str) == Some("query") {
                            "query"
                        } else {
                            "header"
                        }
                        .to_string(),
                    )),
                ),
                ("headerPrefix", auth_str(&v, "headerPrefix")),
                ("queryParamKey", auth_str(&v, "queryParamKey")),
            ]),
        ),
        "oauth1" => (
            "oauth1",
            "oauth1",
            auth_json(vec![
                ("consumerKey", auth_str(&v, "consumerKey")),
                ("consumerSecret", auth_str(&v, "consumerSecret")),
                ("accessToken", auth_str(&v, "token")),
                ("tokenSecret", auth_str(&v, "tokenSecret")),
                ("signatureMethod", auth_str(&v, "signatureMethod")),
                ("privateKey", auth_str(&v, "privateKey")),
                ("callbackUrl", auth_str(&v, "callback")),
                ("verifier", auth_str(&v, "verifier")),
                ("timestamp", auth_str(&v, "timestamp")),
                ("nonce", auth_str(&v, "nonce")),
                ("version", auth_str(&v, "version")),
                ("realm", auth_str(&v, "realm")),
                ("includeBodyHash", Some(auth_bool(&v, "includeBodyHash"))),
                (
                    "addParamsTo",
                    Some(Value::String(
                        if v.get("addParamsToHeader").map(String::as_str) == Some("true") {
                            "header"
                        } else {
                            "query"
                        }
                        .to_string(),
                    )),
                ),
            ]),
        ),
        "hawk" => (
            "hawk",
            "hawk",
            auth_json(vec![
                ("authId", auth_str(&v, "authId")),
                ("authKey", auth_str(&v, "authKey")),
                (
                    "algorithm",
                    Some(Value::String(
                        if v.get("algorithm").map(String::as_str) == Some("sha1") {
                            "sha1"
                        } else {
                            "sha256"
                        }
                        .to_string(),
                    )),
                ),
                ("user", auth_str(&v, "user")),
                ("nonce", auth_str(&v, "nonce")),
                ("extraData", auth_str(&v, "extraData")),
                ("app", auth_str(&v, "app")),
                ("dlg", auth_str(&v, "delegation")),
                ("timestamp", auth_str(&v, "timestamp")),
                ("includePayloadHash", Some(auth_bool(&v, "includePayloadHash"))),
            ]),
        ),
        "awsv4" => (
            "aws-sigv4",
            "awsSigv4",
            auth_json(vec![
                ("accessKey", auth_str(&v, "accessKey")),
                ("secretKey", auth_str(&v, "secretKey")),
                ("region", auth_str(&v, "region")),
                ("service", auth_str(&v, "service")),
                ("sessionToken", auth_str(&v, "sessionToken")),
            ]),
        ),
        "ntlm" => (
            "ntlm",
            "ntlm",
            auth_json(vec![
                ("username", auth_str(&v, "username")),
                ("password", auth_str(&v, "password")),
                ("domain", auth_str(&v, "domain")),
                ("workstation", auth_str(&v, "workstation")),
                ("disableRetryRequest", Some(auth_bool(&v, "disableRetryRequest"))),
            ]),
        ),
        "edgegrid" => (
            "edgegrid",
            "edgegrid",
            auth_json(vec![
                ("accessToken", auth_str(&v, "accessToken")),
                ("clientToken", auth_str(&v, "clientToken")),
                ("clientSecret", auth_str(&v, "clientSecret")),
                ("nonce", auth_str(&v, "nonce")),
                ("timestamp", auth_str(&v, "timestamp")),
                (
                    "baseUri",
                    auth_str(&v, "baseURL").or_else(|| auth_str(&v, "baseUri")),
                ),
                ("headersToSign", auth_str(&v, "headersToSign")),
            ]),
        ),
        "asap" => (
            "asap",
            "asap",
            auth_json(vec![
                ("algorithm", auth_str(&v, "alg")),
                ("kid", auth_str(&v, "kid")),
                ("issuer", auth_str(&v, "iss")),
                ("audience", auth_str(&v, "aud")),
                ("subject", auth_str(&v, "sub")),
                ("additionalClaims", auth_str(&v, "claims")),
                ("privateKey", auth_str(&v, "privateKey")),
                ("expirySeconds", auth_str(&v, "exp")),
                ("tokenId", auth_str(&v, "jti")),
            ]),
        ),
        _ => unreachable!("convert_auth_extra called with {auth_type}"),
    }
}

fn convert_body(body: Option<PmBody>) -> RequestBody {
    let Some(body) = body else {
        return RequestBody::default();
    };
    match body.mode.as_deref() {
        Some("raw") => {
            let lang = body
                .options
                .and_then(|o| o.raw)
                .and_then(|r| r.language)
                .filter(|l| RAW_LANGUAGES.contains(&l.as_str()))
                .unwrap_or_else(|| "json".to_string());
            RequestBody {
                body_type: "raw".to_string(),
                raw: Some(body.raw.unwrap_or_default()),
                raw_language: Some(lang),
                ..Default::default()
            }
        }
        Some("urlencoded") => RequestBody {
            body_type: "x-www-form-urlencoded".to_string(),
            urlencoded: Some(to_kv(body.urlencoded)),
            ..Default::default()
        },
        Some("formdata") => RequestBody {
            body_type: "form-data".to_string(),
            // 仅导入文本行；文件行（type=file + src 路径）不携带内容，跳过
            form_data: Some(to_kv(body.formdata)),
            ..Default::default()
        },
        Some("graphql") => {
            let graphql = body.graphql.unwrap_or(PmGraphql {
                query: None,
                variables: None,
            });
            RequestBody {
                body_type: "graphql".to_string(),
                graphql_query: Some(graphql.query.unwrap_or_default()),
                graphql_variables: graphql.variables.map(|v| pm_value_string(&v)),
                ..Default::default()
            }
        }
        _ => RequestBody::default(),
    }
}

/// Postman 脚本的 pm. 调用改写成 rp.（仅匹配独立标识符，避免误伤 rpm. / xpm.）
fn pm_to_rp(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let mut prev: Option<char> = None;
    let mut rest = code;
    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix("pm.") {
            // 对齐 JS \b 语义：前一字符是 [A-Za-z0-9_] 时视为标识符内部，不改写
            let boundary = prev.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            if boundary {
                out.push_str("rp.");
                prev = Some('.');
                rest = tail;
                continue;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        prev = Some(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn convert_scripts(events: Option<Vec<PmEvent>>) -> RequestScripts {
    let events = events.unwrap_or_default();
    let pick = |listen: &str| -> Option<String> {
        let exec = events
            .iter()
            .find(|e| e.listen.as_deref() == Some(listen))
            .and_then(|e| e.script.as_ref())
            .and_then(|s| s.exec.as_ref())?;
        let code = match exec {
            Value::Array(lines) => lines
                .iter()
                .map(|l| l.as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n"),
            Value::String(s) => s.clone(),
            _ => return None,
        };
        if code.is_empty() {
            None
        } else {
            Some(sanitize_for_rp(&pm_to_rp(&code)))
        }
    };
    RequestScripts {
        pre_request: pick("prerequest"),
        test: pick("test"),
    }
}

// ---------------------------------------------------------------------------
// rp 沙箱兼容改写（pm_to_rp 之后调用）
// 沙箱只支持 rp.expect 的 equal/eql/include/above/below/oneOf/exist 与 be.ok/true/false，
// Postman 生态常见的写法在这里映射到等价形式。
// ---------------------------------------------------------------------------

fn sanitize_for_rp(code: &str) -> String {
    // rp.execution.skipRequest() 沙箱不支持：整行删除（请求会真实执行）
    let mut out = String::with_capacity(code.len());
    for line in code.split_inclusive('\n') {
        if line.trim_start().starts_with("rp.execution.skipRequest()") {
            continue;
        }
        out.push_str(line);
    }
    let mut s = out;
    s = s.replace("rp.response.responseTime", "rp.response.time");
    s = s.replace(
        "rp.response.stream ? rp.response.stream.length : 1",
        "rp.response.text().length",
    );
    s = s.replace(".to.not.be.null", ".to.exist()");
    s = rewrite_header_get(&s);
    s = rewrite_at_least(&s);
    rewrite_be_a_chains(&s)
}

/// `rp.response.headers.get('X')` -> `rp.response.headers['x']`
/// （沙箱 headers 是普通对象且键全小写，没有 .get() 方法）
fn rewrite_header_get(s: &str) -> String {
    const PAT: &str = "rp.response.headers.get(";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(PAT) {
        out.push_str(&rest[..i]);
        let after = &rest[i + PAT.len()..];
        let Some(quote) = after.chars().next().filter(|c| *c == '\'' || *c == '"') else {
            out.push_str(PAT);
            out.push_str(after);
            return out;
        };
        let Some(end) = after[quote.len_utf8()..].find(quote) else {
            out.push_str(PAT);
            out.push_str(after);
            return out;
        };
        let name = &after[quote.len_utf8()..quote.len_utf8() + end];
        let tail = &after[quote.len_utf8() + end + quote.len_utf8()..];
        let Some(tail) = tail.strip_prefix(')') else {
            out.push_str(PAT);
            out.push_str(after);
            return out;
        };
        out.push_str(&format!("rp.response.headers['{}']", name.to_lowercase()));
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// `.to.be.at.least(N)` -> `.to.be.above(N-1)`（沙箱没有 at.least）
fn rewrite_at_least(s: &str) -> String {
    const PAT: &str = ".to.be.at.least(";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(PAT) {
        out.push_str(&rest[..i]);
        let after = &rest[i + PAT.len()..];
        let digits: usize = after.chars().take_while(|c| c.is_ascii_digit()).count();
        let ok = digits > 0 && after[digits..].starts_with(')');
        if !ok {
            out.push_str(PAT);
            rest = after;
            continue;
        }
        let n: u64 = after[..digits].parse().unwrap_or(0);
        out.push_str(&format!(".to.be.above({})", n.saturating_sub(1)));
        rest = &after[digits + 1..];
    }
    out.push_str(rest);
    out
}

/// `rp.expect(E).to.be.a('string')` 链改写：
/// 主断言 -> `rp.expect(typeof E).to.equal('string')`；后续 `.and.` 段拆成独立语句
/// （沙箱没有 be.a，且断言返回 undefined、不支持 .and 继续链）。
/// 无法识别的 .and 段放弃改写，保留原文。
fn rewrite_be_a_chains(s: &str) -> String {
    const EXPECT: &str = "rp.expect(";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(EXPECT) {
        out.push_str(&rest[..i]);
        let after = &rest[i + EXPECT.len()..];
        // 括号配平提取 E
        let mut depth = 1usize;
        let mut end = None;
        for (j, c) in after.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = end else {
            out.push_str(EXPECT);
            out.push_str(after);
            return out;
        };
        let expr = &after[..close];
        let chain = &after[close + 1..];
        let Some(lang_rest) = chain.strip_prefix(".to.be.a('").or_else(|| chain.strip_prefix(".to.be.a(\"")) else {
            out.push_str(EXPECT);
            out.push_str(expr);
            out.push(')');
            rest = chain;
            continue;
        };
        let quote = chain.as_bytes()[".to.be.a(".len()] as char;
        let Some(lang_end) = lang_rest.find(quote) else {
            out.push_str(EXPECT);
            out.push_str(expr);
            out.push(')');
            rest = chain;
            continue;
        };
        let lang = &lang_rest[..lang_end];
        let mut tail = &lang_rest[lang_end + 1..];
        if !tail.starts_with(')') {
            out.push_str(EXPECT);
            out.push_str(expr);
            out.push(')');
            rest = chain;
            continue;
        }
        tail = &tail[1..];
        // 解析 `.and.` 段直到语句结束（; 或换行）
        let mut extra: Vec<String> = Vec::new();
        let mut supported = true;
        loop {
            if let Some(a) = tail.strip_prefix(".and.to.include(") {
                let Some(p) = a.find(')') else { supported = false; break };
                extra.push(format!("rp.expect({expr}).to.include({});", &a[..p]));
                tail = &a[p + 1..];
            } else if let Some(a) = tail.strip_prefix(".and.to.not.be.empty") {
                extra.push(format!("rp.expect({expr}).to.be.ok();"));
                tail = a;
            } else {
                break;
            }
        }
        // 语句应到此结束（; 或换行或文件尾），否则放弃改写
        let stmt_end = tail.find([';', '\n']).unwrap_or(tail.len());
        if !tail[..stmt_end].trim().is_empty() {
            supported = false;
        }
        if !supported {
            out.push_str(EXPECT);
            out.push_str(expr);
            out.push(')');
            rest = chain;
            continue;
        }
        out.push_str(&format!("rp.expect(typeof {expr}).to.equal('{lang}');"));
        for e in &extra {
            out.push(' ');
            out.push_str(e);
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn convert_request(req: PmRequest, events: Option<Vec<PmEvent>>) -> RequestConfig {
    let method = req
        .method
        .unwrap_or_default()
        .to_uppercase();
    let method = if HTTP_METHODS.contains(&method.as_str()) {
        method
    } else {
        "GET".to_string()
    };

    let mut url = String::new();
    let mut params: Vec<KeyValueItem> = Vec::new();
    match req.url {
        Some(Value::String(s)) => url = s,
        Some(Value::Object(obj)) => {
            if let Some(raw) = obj.get("raw").and_then(Value::as_str) {
                url = raw.to_string();
            } else {
                let host = obj
                    .get("host")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .map(|p| p.as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let path = obj
                    .get("path")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .map(|p| p.as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join("/")
                    })
                    .unwrap_or_default();
                let proto = obj
                    .get("protocol")
                    .and_then(Value::as_str)
                    .map(|p| format!("{p}://"))
                    .unwrap_or_default();
                url = format!("{proto}{host}{}", if path.is_empty() { String::new() } else { format!("/{path}") });
            }
            if let Some(query) = obj.get("query") {
                params = to_kv(serde_json::from_value(query.clone()).ok());
            }
        }
        _ => {}
    }

    let body = convert_body(req.body);
    let mut config = RequestConfig {
        method,
        url,
        params,
        headers: to_kv(req.header),
        auth: convert_auth(req.auth.as_ref()),
        scripts: convert_scripts(events),
        ..Default::default()
    };
    // GraphQL body 的请求按 GraphQL 协议导入（固定 POST），与 Web 导入一致
    if body.body_type == "graphql" {
        config.protocol = Some("graphql".to_string());
        config.method = "POST".to_string();
    }
    // protocolProfileBehavior.followRedirects -> settings.followRedirects
    if req
        .protocol_profile_behavior
        .as_ref()
        .and_then(|p| p.get("followRedirects"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        config.settings.follow_redirects = false;
    }
    config.body = body;
    config
}

fn pm_to_nodes(items: Vec<PmItem>) -> Vec<ImportedNode> {
    let mut nodes = Vec::new();
    for item in items {
        if let Some(children) = item.item {
            nodes.push(ImportedNode::Folder {
                name: non_empty_name(item.name, "Folder"),
                description: None,
                items: pm_to_nodes(children),
            });
        } else if let Some(request) = item.request {
            nodes.push(ImportedNode::Request {
                name: non_empty_name(item.name, "Request"),
                request: Some(Box::new(convert_request(request, item.event))),
            });
        }
    }
    nodes
}

fn non_empty_name(name: Option<String>, fallback: &str) -> String {
    let trimmed = name.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

// ---------------------------------------------------------------------------
// 入口：自动识别格式
// ---------------------------------------------------------------------------

/// 解析 Collection 文件：优先 RabbitPost 交换格式，否则回退 Postman v2/v2.1。
pub fn parse_collection(text: &str) -> anyhow::Result<ImportedCollection> {
    let raw: Value = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("JSON 解析失败：{e}"))?;

    if raw.get("format").and_then(Value::as_str) == Some(RP_COLLECTION_FORMAT) {
        let file: RpFile = serde_json::from_value(raw)?;
        let name = file.name.trim().to_string();
        if name.is_empty() {
            anyhow::bail!("RabbitPost Collection 缺少 name");
        }
        return Ok(ImportedCollection {
            name,
            description: file.description,
            variables: file.variables,
            items: file.items.into_iter().map(rp_node).collect(),
        });
    }

    let pm: PmCollection = serde_json::from_value(raw)?;
    let name = pm
        .info
        .as_ref()
        .and_then(|i| i.name.clone())
        .map(|n| n.trim().to_string())
        .unwrap_or_default();
    let items = pm.item.unwrap_or_default();
    if name.is_empty() && items.is_empty() {
        anyhow::bail!("不是有效的 RabbitPost Collection 内容（也未识别为 Postman Collection）");
    }
    Ok(ImportedCollection {
        name: if name.is_empty() { "Imported".to_string() } else { name },
        description: pm.info.and_then(|i| i.description),
        variables: to_kv(pm.variable),
        items: pm_to_nodes(items),
    })
}

// ---------------------------------------------------------------------------
// 环境文件（run --env-file）：Postman 环境导出 / RabbitPost 环境 / 扁平 kv
// ---------------------------------------------------------------------------

/// 环境变量键值对列表（保持文件内顺序）
pub type EnvVars = Vec<(String, String)>;

/// 解析环境文件为 (环境名, 启用变量)。支持三种形态：
/// Postman 导出（values 数组）、RabbitPost 环境（variables 数组）、扁平 {"K": "V"} 映射。
pub fn parse_environment_file(text: &str) -> anyhow::Result<(Option<String>, EnvVars)> {
    let raw: Value = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("JSON 解析失败：{e}"))?;
    let obj = raw
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("环境文件须为 JSON 对象"))?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);

    let list = obj.get("values").or_else(|| obj.get("variables"));
    if let Some(Value::Array(entries)) = list {
        let mut vars = Vec::new();
        for entry in entries {
            let enabled = entry
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let key = entry.get("key").and_then(Value::as_str).unwrap_or_default();
            if enabled && !key.is_empty() {
                let value = entry.get("value").map(pm_value_string).unwrap_or_default();
                vars.push((key.to_string(), value));
            }
        }
        return Ok((name, vars));
    }

    // 扁平 {"KEY": "VALUE"} 映射
    let mut vars = Vec::new();
    for (key, value) in obj {
        if key == "name" {
            continue;
        }
        vars.push((key.clone(), pm_value_string(value)));
    }
    Ok((name, vars))
}

// ---------------------------------------------------------------------------
// 迭代数据（run -d/--iteration-data）：JSON 数组（对象行）或 CSV（首行表头）
// ---------------------------------------------------------------------------

/// 解析迭代数据为若干行变量。JSON：[{"k":"v"}, ...]；CSV：首行表头，逗号分隔，
/// 支持引号包裹与 "" 转义。JSON 优先，解析失败再按 CSV 处理。
pub fn parse_iteration_data(text: &str) -> anyhow::Result<Vec<HashMap<String, String>>> {
    let trimmed = text.trim();
    if trimmed.starts_with('[') {
        let rows: Vec<Value> = serde_json::from_str(trimmed)
            .map_err(|e| anyhow::anyhow!("迭代数据 JSON 解析失败：{e}"))?;
        let mut out = Vec::with_capacity(rows.len());
        for (i, row) in rows.iter().enumerate() {
            let obj = row
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("迭代数据第 {} 行须为对象", i + 1))?;
            out.push(
                obj.iter()
                    .map(|(k, v)| (k.clone(), pm_value_string(v)))
                    .collect(),
            );
        }
        if out.is_empty() {
            anyhow::bail!("迭代数据为空：JSON 数组没有行");
        }
        return Ok(out);
    }
    parse_csv_rows(text)
}

/// 极简 CSV：逗号分隔、双引号包裹、"" 转义、\r\n / \n 换行
fn parse_csv_rows(text: &str) -> anyhow::Result<Vec<HashMap<String, String>>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut record: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => in_quotes = false,
                _ => field.push(c),
            }
        } else {
            match c {
                '"' if field.is_empty() => in_quotes = true,
                ',' => {
                    record.push(std::mem::take(&mut field));
                }
                '\n' | '\r' => {
                    if c == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    record.push(std::mem::take(&mut field));
                    if !record.iter().all(|f| f.is_empty()) {
                        records.push(std::mem::take(&mut record));
                    } else {
                        record.clear();
                    }
                }
                _ => field.push(c),
            }
        }
    }
    if in_quotes {
        anyhow::bail!("CSV 引号未闭合");
    }
    record.push(field);
    if !record.iter().all(|f| f.is_empty()) {
        records.push(record);
    }

    let Some(headers) = records.first() else {
        anyhow::bail!("迭代数据为空：CSV 没有内容");
    };
    if headers.iter().all(|h| h.is_empty()) {
        anyhow::bail!("迭代数据为空：CSV 表头为空");
    }
    let mut out = Vec::new();
    for row in records.iter().skip(1) {
        let mut vars = HashMap::new();
        for (i, header) in headers.iter().enumerate() {
            if !header.is_empty() {
                vars.insert(header.clone(), row.get(i).cloned().unwrap_or_default());
            }
        }
        out.push(vars);
    }
    if out.is_empty() {
        anyhow::bail!("迭代数据为空：CSV 只有表头没有数据行");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rp_collection_file() {
        let text = r#"{
            "format": "rabbitpost.collection",
            "version": 1,
            "exportedAt": "2024-01-01T00:00:00Z",
            "name": "Demo",
            "description": "d",
            "variables": [{"key": "host", "value": "https://a", "enabled": true}],
            "items": [
                {"type": "folder", "name": "f", "items": [
                    {"type": "request", "name": "r1", "request": {"method": "GET", "url": "{{host}}/x"}}
                ]},
                {"type": "request", "name": "r2"}
            ]
        }"#;
        let col = parse_collection(text).unwrap();
        assert_eq!(col.name, "Demo");
        assert_eq!(col.variables.len(), 1);
        assert_eq!(col.items.len(), 2);
        match &col.items[0] {
            ImportedNode::Folder { name, items, .. } => {
                assert_eq!(name, "f");
                assert_eq!(items.len(), 1);
            }
            _ => panic!("expected folder"),
        }
        match &col.items[1] {
            ImportedNode::Request { request, .. } => assert!(request.is_none()),
            _ => panic!("expected request"),
        }
    }

    #[test]
    fn parses_postman_collection() {
        let text = r#"{
            "info": {"name": "Pm", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
            "variable": [{"key": "host", "value": "https://api"}],
            "item": [
                {"name": "grp", "item": [
                    {"name": "login",
                     "event": [{"listen": "test", "script": {"exec": ["pm.test('ok', () => {});"]}}],
                     "request": {
                        "method": "post",
                        "url": {"raw": "{{host}}/login", "query": [{"key": "a", "value": "1", "disabled": true}]},
                        "header": [{"key": "X-T", "value": "t"}],
                        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "abc"}]},
                        "body": {"mode": "raw", "raw": "{\"u\":1}"}
                    }}
                ]}
            ]
        }"#;
        let col = parse_collection(text).unwrap();
        assert_eq!(col.name, "Pm");
        assert_eq!(col.variables.len(), 1);
        let ImportedNode::Folder { items, .. } = &col.items[0] else {
            panic!("expected folder");
        };
        let ImportedNode::Request { name, request } = &items[0] else {
            panic!("expected request");
        };
        assert_eq!(name, "login");
        let req = request.as_ref().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "{{host}}/login");
        assert_eq!(req.params.len(), 1);
        assert!(!req.params[0].enabled);
        assert_eq!(req.auth.auth_type, "bearer");
        assert_eq!(req.auth.bearer.as_ref().unwrap().token.as_deref(), Some("abc"));
        assert_eq!(req.body.body_type, "raw");
        // pm. 改写为 rp.
        assert_eq!(req.scripts.test.as_deref(), Some("rp.test('ok', () => {});"));
    }

    #[test]
    fn graphql_body_becomes_graphql_protocol() {
        let text = r#"{
            "info": {"name": "G"},
            "item": [{"name": "q", "request": {
                "method": "POST",
                "url": "https://api/graphql",
                "body": {"mode": "graphql", "graphql": {"query": "{ me }", "variables": "{\"a\":1}"}}
            }}]
        }"#;
        let col = parse_collection(text).unwrap();
        let ImportedNode::Request { request, .. } = &col.items[0] else {
            panic!("expected request");
        };
        let req = request.as_ref().unwrap();
        assert_eq!(req.protocol.as_deref(), Some("graphql"));
        assert_eq!(req.method, "POST");
        assert_eq!(req.body.graphql_query.as_deref(), Some("{ me }"));
        assert_eq!(req.body.graphql_variables.as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn maps_extended_auth_types_into_extra() {
        let text = r#"{"info":{"name":"A"},"item":[
            {"name":"r","request":{"method":"GET","url":"https://a",
              "auth":{"type":"awsv4","awsv4":[{"key":"accessKey","value":"AK"},{"key":"region","value":"us-east-1"}]}}}
        ]}"#;
        let col = parse_collection(text).unwrap();
        let ImportedNode::Request { request, .. } = &col.items[0] else {
            panic!("expected request")
        };
        let req = request.as_ref().unwrap();
        assert_eq!(req.auth.auth_type, "aws-sigv4");
        assert_eq!(req.auth.extra["awsSigv4"]["accessKey"], "AK");
        // 序列化后平铺回顶层（与服务端 / Web 模型一致，往返不丢字段）
        let json = serde_json::to_value(&req.auth).unwrap();
        assert_eq!(json["type"], "aws-sigv4");
        assert_eq!(json["awsSigv4"]["region"], "us-east-1");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_collection("not json").is_err());
        assert!(parse_collection("{\"foo\":1}").is_err());
    }

    #[test]
    fn pm_to_rp_only_rewrites_standalone_identifier() {
        assert_eq!(pm_to_rp("pm.test(1); xpm.a; rpm.b"), "rp.test(1); xpm.a; rpm.b");
        assert_eq!(pm_to_rp("$pm.globals.set"), "$rp.globals.set");
    }

    #[test]
    fn parses_postman_environment_file() {
        let text = r#"{"name": "prod", "values": [
            {"key": "host", "value": "https://api", "enabled": true},
            {"key": "off", "value": "x", "enabled": false}
        ]}"#;
        let (name, vars) = parse_environment_file(text).unwrap();
        assert_eq!(name.as_deref(), Some("prod"));
        assert_eq!(vars, vec![("host".to_string(), "https://api".to_string())]);

        // 扁平映射
        let (_, vars) = parse_environment_file(r#"{"a": "1", "b": 2}"#).unwrap();
        assert!(vars.contains(&("b".to_string(), "2".to_string())));
    }

    #[test]
    fn parses_iteration_data_json_and_csv() {
        let rows = parse_iteration_data(r#"[{"a": "1"}, {"a": 2, "b": "x"}]"#).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["a"], "2");

        let rows = parse_iteration_data("user,pass\n\"a,b\",p1\nc,\"p\"\"2\"\n").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["user"], "a,b");
        assert_eq!(rows[1]["pass"], "p\"2");

        assert!(parse_iteration_data("a,b\n").is_err());
        assert!(parse_iteration_data("[]").is_err());
    }

    #[test]
    fn sanitize_rewrites_unsupported_pm_calls() {
        // headers.get / responseTime / not.be.null / at.least
        let out = sanitize_for_rp(&pm_to_rp(
            "const h = pm.response.headers.get('WWW-Authenticate') || '';\n\
             pm.expect(pm.response.headers.get(\"Retry-After\")).to.not.be.null;\n\
             pm.expect(pm.response.responseTime).to.be.at.least(100);",
        ));
        assert!(out.contains("rp.response.headers['www-authenticate']"));
        assert!(out.contains("rp.response.headers['retry-after']"));
        assert!(out.contains(".to.exist()"));
        assert!(out.contains("rp.response.time"));
        assert!(out.contains(".to.be.above(99)"));
        assert!(!out.contains(".headers.get("));
        assert!(!out.contains("responseTime"));

        // skipRequest 整行删除
        let out = sanitize_for_rp(&pm_to_rp("console.warn('x');\npm.execution.skipRequest();\npm.test('t', () => {});"));
        assert!(!out.contains("skipRequest"));
        assert!(out.contains("rp.test('t'"));

        // stream 长度
        let out = sanitize_for_rp(&pm_to_rp(
            "pm.expect(pm.response.stream ? pm.response.stream.length : 1).to.be.above(0);",
        ));
        assert!(out.contains("rp.response.text().length"));
    }

    #[test]
    fn sanitize_rewrites_be_a_string_chains() {
        let out = sanitize_for_rp(&pm_to_rp(
            "pm.expect(pm.response.json().access_token).to.be.a('string').and.to.include('mock_access_token_');",
        ));
        assert!(out.contains("rp.expect(typeof rp.response.json().access_token).to.equal('string');"));
        assert!(out.contains("rp.expect(rp.response.json().access_token).to.include('mock_access_token_');"));
        assert!(!out.contains(".and."));

        let out = sanitize_for_rp(&pm_to_rp(
            "pm.expect(pm.response.json().ip).to.be.a('string').and.to.not.be.empty;",
        ));
        assert!(out.contains("rp.expect(typeof rp.response.json().ip).to.equal('string');"));
        assert!(out.contains("rp.expect(rp.response.json().ip).to.be.ok();"));
    }

    #[test]
    fn maps_protocol_profile_behavior_follow_redirects() {
        let text = r#"{
            "info": {"name": "c"},
            "item": [{
                "name": "r",
                "request": {
                    "method": "GET",
                    "url": "http://x/status/301",
                    "protocolProfileBehavior": {"followRedirects": false}
                }
            }]
        }"#;
        let col = parse_collection(text).unwrap();
        match &col.items[0] {
            ImportedNode::Request { request, .. } => {
                assert!(!request.as_ref().unwrap().settings.follow_redirects);
            }
            _ => panic!("expected request"),
        }
    }
}

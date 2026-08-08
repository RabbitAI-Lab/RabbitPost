//! local-agent：桌面客户端内嵌的本地执行代理。
//!
//! 不注册、不连接 RabbitPost 服务器：在 127.0.0.1 上起一个 HTTP 服务，
//! 端点契约镜像服务端 API（信封 { ok, data } / SSE 帧格式），前端"执行"类
//! 请求在桌面模式下改道这里：
//! - POST /execute           一次性 HTTP 执行（rp-core 执行引擎 + QuickJS 脚本）
//! - POST /rt/sessions       建长连接协议 session（WS/MQTT/gRPC/MCP/SSE 等）
//! - GET  /rt/sessions/:id/events  事件下行（SSE，先回放 backlog 再推实时）
//! - POST /rt/sessions/:id/send    上行消息
//! - DELETE /rt/sessions/:id       关闭 session
//!
//! 安全：只绑 127.0.0.1；CORS Origin 白名单（localhost/127.0.0.1/tauri + 可配），
//! 挡住浏览器中其他网站蹭用本代理。

use std::collections::HashMap;
use std::convert::Infallible;
use std::io::ErrorKind;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rp_core::exec::{self, ClientPool};
use rp_core::model::{JobResult, RequestConfig};
use rp_core::runner_api::RtCommand;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::rt::RtSessionManager;

/// 端口占用时的递增探测上限（base..=base+RANGE）
const PORT_RANGE: u16 = 10;
/// SSE 保活间隔（与服务端一致：15s）
const KEEP_ALIVE_SECS: u64 = 15;
/// 事件积压上限（与服务端 rt.ts 一致：满则丢最旧）
const BACKLOG_CAP: usize = 500;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 单个 rt session 的事件出口：backlog（SSE 订阅前的事件）+ 实时广播
struct SessionEvents {
    backlog: Vec<Value>,
    tx: broadcast::Sender<Value>,
}

type SessionRegistry = Arc<Mutex<HashMap<String, SessionEvents>>>;

#[derive(Clone)]
struct AppState {
    pool: Arc<ClientPool>,
    manager: Arc<Mutex<RtSessionManager>>,
    sessions: SessionRegistry,
}

fn push_event(sessions: &SessionRegistry, id: &str, event: Value) {
    let mut map = sessions.lock().unwrap();
    if let Some(s) = map.get_mut(id) {
        s.backlog.push(event.clone());
        if s.backlog.len() > BACKLOG_CAP {
            s.backlog.remove(0);
        }
        // 无订阅者时 send 返回 Err，属正常（事件已入 backlog），忽略
        let _ = s.tx.send(event);
    }
}

type ApiErr = (StatusCode, Json<Value>);

fn api_err(status: StatusCode, code: &str, message: &str) -> ApiErr {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
}

fn not_found() -> ApiErr {
    api_err(StatusCode::NOT_FOUND, "NOT_FOUND", "Realtime session not found")
}

// ---------------------------------------------------------------------------
// /health 与 /execute
// ---------------------------------------------------------------------------

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "data": { "mode": "local-agent", "version": crate::VERSION }
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteInput {
    request: RequestConfig,
    /// 前端已解析好的明文变量表（环境变量 + Collection 变量），agent 不查库
    #[serde(default)]
    variables: HashMap<String, String>,
    name: Option<String>,
    item_id: Option<String>,
}

async fn execute(State(state): State<AppState>, Json(input): Json<ExecuteInput>) -> Json<Value> {
    let name = input.name.unwrap_or_else(|| "Untitled Request".to_string());
    let result = exec::execute(
        &state.pool,
        &name,
        input.item_id,
        &input.request,
        &input.variables,
    )
    .await;
    Json(json!({ "ok": true, "data": to_execute_result(&result) }))
}

/// JobResult → ExecuteResult（镜像服务端 runner-dispatch.ts 的 convertToExecuteResult）
fn to_execute_result(r: &JobResult) -> Value {
    let test_results = r.test_results.clone().unwrap_or_default();
    let console_logs = r.console_logs.clone().unwrap_or_default();
    if let Some(error) = &r.error {
        return json!({
            "ok": false,
            "error": error,
            "durationMs": r.duration_ms.unwrap_or(0),
            "testResults": test_results,
            "consoleLogs": console_logs,
        });
    }
    let headers = r.response_headers.clone().unwrap_or_default();
    let cookies = parse_response_cookies(headers.get("set-cookie").map(String::as_str));
    json!({
        "ok": r.ok,
        "status": r.status,
        "statusText": r.status_text,
        "headers": headers,
        "bodyText": r.response_body,
        "sizeBytes": r.size_bytes,
        "durationMs": r.duration_ms.unwrap_or(0),
        "testResults": test_results,
        "consoleLogs": console_logs,
        "cookies": cookies,
    })
}

// ---------------------------------------------------------------------------
// Set-Cookie 解析（移植自 runner-dispatch.ts，保持展示行为一致）
// ---------------------------------------------------------------------------

/// 合并后的 Set-Cookie 拆分：仅在 ", " 后片段形似 "name=value"（= 在 ; 前）时才断开
fn split_joined_set_cookies(joined: &str) -> Vec<String> {
    let mut cookies: Vec<String> = Vec::new();
    let mut current = String::new();
    for part in joined.split(", ") {
        let eq = part.find('=').map(|i| i as isize).unwrap_or(-1);
        let semi = part.find(';').map(|i| i as isize).unwrap_or(-1);
        let looks_like_new = eq > 0 && (semi == -1 || eq < semi);
        if looks_like_new && !current.is_empty() {
            cookies.push(current.trim().to_string());
            current = part.to_string();
        } else if current.is_empty() {
            current = part.to_string();
        } else {
            current = format!("{current}, {part}");
        }
    }
    if !current.trim().is_empty() {
        cookies.push(current.trim().to_string());
    }
    cookies
}

fn parse_response_cookies(set_cookie: Option<&str>) -> Vec<Value> {
    let Some(header) = set_cookie else { return Vec::new() };
    let mut out = Vec::new();
    for raw in split_joined_set_cookies(header) {
        let mut segments = raw.split(';').map(str::trim);
        let Some(first) = segments.next() else { continue };
        let Some(eq) = first.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        let mut cookie = Map::new();
        cookie.insert("name".into(), json!(first[..eq].trim()));
        cookie.insert("value".into(), json!(first[eq + 1..].trim()));
        for seg in segments {
            let (attr, val) = match seg.find('=') {
                Some(i) => (seg[..i].trim().to_lowercase(), seg[i + 1..].trim().to_string()),
                None => (seg.trim().to_lowercase(), String::new()),
            };
            match attr.as_str() {
                "domain" => cookie.insert("domain".into(), json!(val)),
                "path" => cookie.insert("path".into(), json!(val)),
                "expires" => cookie.insert("expires".into(), json!(val)),
                "max-age" => {
                    if let Ok(n) = val.parse::<i64>() {
                        cookie.insert("maxAge".into(), json!(n))
                    } else {
                        continue;
                    }
                }
                "httponly" => cookie.insert("httpOnly".into(), json!(true)),
                "secure" => cookie.insert("secure".into(), json!(true)),
                "samesite" => cookie.insert("sameSite".into(), json!(val)),
                _ => continue,
            };
        }
        out.push(Value::Object(cookie));
    }
    out
}

// ---------------------------------------------------------------------------
// rt session 端点
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionInput {
    protocol: String,
    url: String,
    config: Option<Value>,
    // 服务器侧契约里的 workspaceId 等字段本地不需要，serde 默认忽略
}

async fn create_session(
    State(state): State<AppState>,
    Json(input): Json<CreateSessionInput>,
) -> Json<Value> {
    let session_id = uuid::Uuid::new_v4().to_string();
    // 先注册事件表：connecting/open 等早期事件（本地回环尤其快）进入 backlog
    {
        let (tx, _rx) = broadcast::channel(256);
        state
            .sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), SessionEvents { backlog: Vec::new(), tx });
    }
    state.manager.lock().unwrap().handle(RtCommand::Start {
        session_id: session_id.clone(),
        protocol: input.protocol,
        url: input.url,
        config: input.config,
    });
    Json(json!({ "ok": true, "data": { "sessionId": session_id } }))
}

fn to_sse(event: Value) -> Result<Event, Infallible> {
    Ok(Event::default().data(event.to_string()))
}

async fn session_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiErr> {
    let (backlog, rx) = {
        let map = state.sessions.lock().unwrap();
        match map.get(&id) {
            Some(s) => (s.backlog.clone(), s.tx.subscribe()),
            None => return Err(not_found()),
        }
    };
    // 先回放积压事件，再接实时广播（lag 时丢弃该条，保持流推进）
    let initial = tokio_stream::iter(backlog.into_iter().map(to_sse));
    let live = BroadcastStream::new(rx).filter_map(|item| item.ok().map(to_sse));
    Ok(Sse::new(initial.chain(live)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(KEEP_ALIVE_SECS))
            .text("ping"),
    ))
}

#[derive(Deserialize)]
struct SendInput {
    data: String,
    encoding: Option<String>,
}

async fn send_to_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<SendInput>,
) -> Result<Json<Value>, ApiErr> {
    if !state.sessions.lock().unwrap().contains_key(&id) {
        return Err(not_found());
    }
    state.manager.lock().unwrap().handle(RtCommand::Send {
        session_id: id,
        data: input.data,
        encoding: input.encoding,
    });
    Ok(Json(json!({ "ok": true, "data": null })))
}

async fn close_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    if !state.sessions.lock().unwrap().contains_key(&id) {
        return Err(not_found());
    }
    state.manager.lock().unwrap().handle(RtCommand::Close {
        session_id: id.clone(),
    });
    // 通知 SSE 端关闭（与服务端 closeRtSession 行为一致），随后移除注册项，
    // 广播通道随之销毁，各 SSE 流自然结束
    push_event(
        &state.sessions,
        &id,
        json!({ "t": "status", "id": id, "state": "closed", "reason": "closed by client" }),
    );
    state.sessions.lock().unwrap().remove(&id);
    Ok(Json(json!({ "ok": true, "data": null })))
}

// ---------------------------------------------------------------------------
// CORS 与服务启动
// ---------------------------------------------------------------------------

/// 默认放行：localhost / 127.0.0.1（任意端口、http/https）与 Tauri WebView 源
fn is_allowed_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    for scheme in ["http://", "https://"] {
        if let Some(rest) = origin.strip_prefix(scheme) {
            let host = rest.split(':').next().unwrap_or("");
            return host == "localhost" || host == "127.0.0.1";
        }
    }
    false
}

/// 启动 local-agent HTTP 服务（阻塞运行直到进程结束）
pub async fn serve(base_port: u16, extra_origins: Vec<String>) -> anyhow::Result<()> {
    let pool = Arc::new(ClientPool::new(&format!(
        "RabbitPostAgent/{}",
        crate::VERSION
    )));

    // rt 事件出口：manager 统一补 id 后经此通道推入本地 session 事件表
    let (sink, mut sink_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let sessions: SessionRegistry = Arc::new(Mutex::new(HashMap::new()));
    tokio::spawn({
        let sessions = sessions.clone();
        async move {
            while let Some((id, event)) = sink_rx.recv().await {
                push_event(&sessions, &id, event);
            }
        }
    });

    let state = AppState {
        pool,
        manager: Arc::new(Mutex::new(RtSessionManager::new(sink))),
        sessions,
    };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            let o = origin.to_str().unwrap_or("");
            is_allowed_origin(o) || extra_origins.iter().any(|x| x == o)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/health", get(health))
        // 与服务端 API 同路径的别名：前端桌面模式下仅需替换 base URL，路径不变
        .route("/execute", post(execute))
        .route("/api/v1/execute", post(execute))
        .route("/rt/sessions", post(create_session))
        .route("/api/v1/rt/sessions", post(create_session))
        .route("/rt/sessions/{id}/events", get(session_events))
        .route("/api/v1/rt/sessions/{id}/events", get(session_events))
        .route("/rt/sessions/{id}/send", post(send_to_session))
        .route("/api/v1/rt/sessions/{id}/send", post(send_to_session))
        .route("/rt/sessions/{id}", delete(close_session))
        .route("/api/v1/rt/sessions/{id}", delete(close_session))
        .layer(cors)
        .with_state(state);

    // 端口被占（残留进程 / 多开）时递增探测，前端按同一端口段探测
    let mut port = base_port;
    let listener = loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => break l,
            Err(e) if e.kind() == ErrorKind::AddrInUse && port < base_port + PORT_RANGE => {
                port += 1;
            }
            Err(e) => return Err(e.into()),
        }
    };
    logln!("local-agent listening on http://127.0.0.1:{port}");
    // 机器可读行：供桌面壳等父进程解析实际监听端口
    println!("{{\"type\":\"listening\",\"port\":{port}}}");
    axum::serve(listener, app).await?;
    Ok(())
}

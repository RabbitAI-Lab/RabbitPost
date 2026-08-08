//! Socket.IO 协议 session：手写 engine.io v4 / socket.io v5(v4 服务器) 客户端，
//! 基于 tokio-tungstenite 的 websocket transport。
//! 不引入 rust_socketio 的原因：其依赖链 rust_engineio 会以 default features 拉入
//! reqwest 的 system-proxy，feature unification 会污染全 workspace 的 reqwest 0.12
//! （在设了系统代理的机器上 localhost 请求会被代理劫持/挂起）。
//!
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致：
//! - connect → status open；disconnect → status closed；connect_error → error 事件
//! - 收到任意事件 → in {"event","args"}（args 为 JSON 数组）
//! - send：{"event","args"[]} → emit + ack 回推 in {"event":"[ack] <ev>","args":[...]}，out 回执
//! - namespace 写在 URL 路径里（如 http://host:3000/admin）
//!
//! 限制：仅 websocket transport（socket.io 服务端默认允许）；二进制附件暂不支持。

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::SessionCtl;

/// 握手（engine.io open + socket.io connect）超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Socket.IO session 连接参数（从 downlink start 指令的 config 解析）
pub struct SioSessionConfig {
    /// ws(s)://host[:port]（namespace 已剥离）
    pub origin: String,
    /// namespace（取自 URL 路径，默认 "/"）
    pub namespace: String,
    /// engine.io 端点路径（config.path，默认 /socket.io）
    pub path: String,
    /// 握手 auth 负载
    pub auth: Option<Value>,
    /// 协议版本：仅支持 v4
    pub version: String,
}

impl SioSessionConfig {
    /// config 形状：`{ path?: string, auth?: object, version?: "v2" | "v3" | "v4" }`
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        // namespace 写在 URL 路径里；剥离后换成 engine.io 端点
        let (origin, namespace) = match url::Url::parse(&url) {
            Ok(mut u) => {
                let ns = u.path().to_string();
                let ns = if ns == "/" || ns.is_empty() { "/".to_string() } else { ns };
                u.set_path("/");
                u.set_query(None);
                (u.to_string().trim_end_matches('/').to_string(), ns)
            }
            Err(_) => (url, "/".to_string()),
        };
        let path = config
            .as_ref()
            .and_then(|c| c.get("path"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("/socket.io")
            .to_string();
        let auth = config.as_ref().and_then(|c| c.get("auth")).cloned();
        let version = config
            .as_ref()
            .and_then(|c| c.get("version"))
            .and_then(Value::as_str)
            .unwrap_or("v4")
            .to_string();
        Self {
            origin,
            namespace,
            path,
            auth,
            version,
        }
    }

    /// engine.io websocket 握手 URL
    fn handshake_url(&self) -> String {
        let origin = self
            .origin
            .replace("http://", "ws://")
            .replace("https://", "wss://");
        let path = self.path.trim_end_matches('/');
        format!("{origin}{path}/?EIO=4&transport=websocket")
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// in 方向的事件消息：{"event","args"}
fn reply_event(events: &mpsc::UnboundedSender<Value>, event: &str, args: Value) {
    let data = json!({"event": event, "args": args}).to_string();
    send(
        events,
        json!({
            "t": "message", "dir": "in", "data": data,
            "encoding": "text", "ts": now_ms(),
        }),
    );
}

/// 解析 socket.io 数据包体：`/admin,3["ev",...]` → (namespace, ack id, JSON 负载)
fn parse_packet_body(body: &str) -> (Option<&str>, Option<u64>, &str) {
    // namespace 前缀：以 / 开头、到逗号为止
    let (nsp, rest) = if let Some(stripped) = body.strip_prefix('/') {
        match stripped.find(',') {
            Some(idx) => (Some(&body[..idx + 1]), &stripped[idx + 1..]),
            None => (Some(body), ""),
        }
    } else {
        (None, body)
    };
    // ack id：JSON 起始符之前的数字
    let json_start = rest.find(['[', '{', '"']).unwrap_or(rest.len());
    let ack = rest[..json_start].parse::<u64>().ok();
    (nsp, ack, &rest[json_start..])
}

/// 运行一个 Socket.IO session 直到关闭；事件（不带 id）逐条送入 events。
pub async fn run_sio_session(
    cfg: SioSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    if cfg.version != "v4" {
        send(&events, json!({"t": "status", "state": "error",
            "reason": format!("runner 的 Socket.IO 客户端只支持 v4 协议（收到 {}）", cfg.version)}));
        return;
    }

    let mut ws = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_async(cfg.handshake_url()),
    )
    .await
    {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            send(&events, json!({"t": "error", "message": format!("connect_error: {e}")}));
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
        Err(_) => {
            send(&events, json!({"t": "error", "message": "connect_error: 连接超时"}));
            send(&events, json!({"t": "status", "state": "error", "reason": "连接超时"}));
            return;
        }
    };

    // engine.io open 包（"0{...}"）→ 发送 socket.io connect 包（"40[/nsp,][auth]"）
    match tokio::time::timeout(CONNECT_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) if text.starts_with('0') => {}
        Ok(Some(Ok(_))) => {
            send(&events, json!({"t": "status", "state": "error",
                "reason": "connect_error: 非 engine.io v4 端点"}));
            return;
        }
        Ok(Some(Err(e))) => {
            send(&events, json!({"t": "error", "message": format!("connect_error: {e}")}));
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
        Ok(None) => {
            send(&events, json!({"t": "error", "message": "connect_error: 连接被对端关闭"}));
            send(&events, json!({"t": "status", "state": "error", "reason": "连接被对端关闭"}));
            return;
        }
        Err(_) => {
            send(&events, json!({"t": "error", "message": "connect_error: engine.io 握手超时"}));
            send(&events, json!({"t": "status", "state": "error", "reason": "握手超时"}));
            return;
        }
    }
    let mut connect_packet = String::from("40");
    if cfg.namespace != "/" {
        connect_packet.push_str(&cfg.namespace);
        connect_packet.push(',');
    }
    if let Some(auth) = &cfg.auth {
        connect_packet.push_str(&auth.to_string());
    }
    if let Err(e) = ws.send(Message::Text(connect_packet.into())).await {
        send(&events, json!({"t": "error", "message": format!("connect_error: {e}")}));
        send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
        return;
    }

    // 等待本 namespace 的 connect 应答（40 → open，44 → connect_error）
    let opened = loop {
        let next = tokio::time::timeout(CONNECT_TIMEOUT, ws.next()).await;
        match next {
            Ok(Some(Ok(Message::Text(text)))) => {
                let text = text.as_str();
                if text == "2" {
                    // engine.io ping → pong
                    let _ = ws.send(Message::Text("3".into())).await;
                    continue;
                }
                if let Some(body) = text.strip_prefix("40") {
                    let (nsp, _, _) = parse_packet_body(body);
                    let ours = nsp.map(|n| n == cfg.namespace).unwrap_or(cfg.namespace == "/");
                    if ours {
                        break true;
                    }
                    continue;
                }
                if let Some(body) = text.strip_prefix("44") {
                    let (nsp, _, payload) = parse_packet_body(body);
                    let ours = nsp.map(|n| n == cfg.namespace).unwrap_or(cfg.namespace == "/");
                    if ours {
                        let detail = connect_error_detail(payload);
                        send(&events, json!({"t": "error", "message": format!("connect_error: {detail}")}));
                        send(&events, json!({"t": "status", "state": "error", "reason": detail}));
                        break false;
                    }
                    continue;
                }
                // 其他包（如 41）忽略，继续等
            }
            Ok(Some(Err(e))) => {
                send(&events, json!({"t": "error", "message": format!("connect_error: {e}")}));
                send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
                break false;
            }
            Ok(Some(Ok(_))) => {}
            Ok(None) => {
                send(&events, json!({"t": "error", "message": "connect_error: 连接被对端关闭"}));
                send(&events, json!({"t": "status", "state": "error", "reason": "连接被对端关闭"}));
                break false;
            }
            Err(_) => {
                send(&events, json!({"t": "error", "message": "connect_error: socket.io 握手超时"}));
                send(&events, json!({"t": "status", "state": "error", "reason": "握手超时"}));
                break false;
            }
        }
    };
    if !opened {
        return;
    }
    send(&events, json!({"t": "status", "state": "open"}));

    // 进行中的 ack：ackId → 原事件名
    let mut pending_acks: HashMap<u64, String> = HashMap::new();
    let mut next_ack_id: u64 = 0;

    loop {
        tokio::select! {
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_packet(text.as_str(), &cfg, &events, &mut pending_acks, &mut ws).await;
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // 二进制附件（45/46 序列）暂不支持
                        send(&events, json!({"t": "error", "message": "暂不支持二进制附件事件"}));
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        send(&events, json!({"t": "status", "state": "closed"}));
                        return;
                    }
                    Some(Err(e)) => {
                        send(&events, json!({"t": "error", "message": e.to_string()}));
                        send(&events, json!({"t": "status", "state": "closed", "reason": e.to_string()}));
                        return;
                    }
                    // ping/pong 由 tungstenite 自动应答
                    Some(Ok(_)) => {}
                }
            }
            command = ctl.recv() => {
                match command {
                    Some(SessionCtl::Send { data, .. }) => {
                        handle_send(&data, &cfg, &events, &mut pending_acks, &mut next_ack_id, &mut ws).await;
                    }
                    Some(SessionCtl::Close) | None => {
                        // socket.io disconnect 包后礼貌关闭 ws
                        let mut packet = String::from("41");
                        if cfg.namespace != "/" {
                            packet.push_str(&cfg.namespace);
                            packet.push(',');
                        }
                        let _ = ws.send(Message::Text(packet.into())).await;
                        let _ = ws.close(None).await;
                        send(&events, json!({"t": "status", "state": "closed"}));
                        return;
                    }
                }
            }
        }
    }
}

/// connect_error 负载提取可读信息："msg" 或 {"message":"..."}
fn connect_error_detail(payload: &str) -> String {
    match serde_json::from_str::<Value>(payload) {
        Ok(Value::String(s)) => s,
        Ok(v) => v
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| v.to_string()),
        Err(_) => payload.to_string(),
    }
}

/// 处理一条 ws 文本包（已连接状态）
async fn handle_packet<S>(
    text: &str,
    cfg: &SioSessionConfig,
    events: &mpsc::UnboundedSender<Value>,
    pending_acks: &mut HashMap<u64, String>,
    ws: &mut S,
) where
    S: Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    if text == "2" {
        // engine.io ping → pong
        let _ = ws.send(Message::Text("3".into())).await;
        return;
    }
    if let Some(body) = text.strip_prefix("42") {
        // 事件：42[/nsp,][ackId]["ev", ...args]
        let (nsp, _ack, payload) = parse_packet_body(body);
        let ours = nsp.map(|n| n == cfg.namespace).unwrap_or(cfg.namespace == "/");
        if !ours {
            return;
        }
        match serde_json::from_str::<Vec<Value>>(payload) {
            Ok(mut arr) if !arr.is_empty() => {
                let event = arr.remove(0);
                match event.as_str() {
                    Some(name) => reply_event(events, name, Value::Array(arr)),
                    None => send(events, json!({"t": "error", "message": "收到非字符串事件名"})),
                }
            }
            _ => send(events, json!({"t": "error", "message": format!("无法解析事件包: {text}")})),
        }
        return;
    }
    if let Some(body) = text.strip_prefix("43") {
        // ack：43[/nsp,]<ackId>[...args]
        let (nsp, ack, payload) = parse_packet_body(body);
        let ours = nsp.map(|n| n == cfg.namespace).unwrap_or(cfg.namespace == "/");
        if !ours {
            return;
        }
        if let Some(id) = ack {
            if let Some(event) = pending_acks.remove(&id) {
                let args = serde_json::from_str::<Vec<Value>>(payload).unwrap_or_default();
                reply_event(events, &format!("[ack] {event}"), Value::Array(args));
            }
        }
        return;
    }
    if text.strip_prefix("44").is_some() {
        // 已连接后的 connect_error（少见）：按 error 事件回推
        let body = text.strip_prefix("44").unwrap_or_default();
        let (_, _, payload) = parse_packet_body(body);
        send(events, json!({"t": "error", "message": format!("connect_error: {}", connect_error_detail(payload))}));
        return;
    }
    // "41"（namespace disconnect）由外层 ws close/None 兜底；
    // 但服务端主动 41 时 ws 不一定立刻关：显式按 closed 处理
    if let Some(body) = text.strip_prefix("41") {
        let (nsp, _, _) = parse_packet_body(body);
        let ours = nsp.map(|n| n == cfg.namespace).unwrap_or(cfg.namespace == "/");
        if ours {
            send(events, json!({"t": "status", "state": "closed"}));
        }
    }
}

/// 处理 send 帧：{"event": "...", "args": [...]} → emit + ack 回推
async fn handle_send<S>(
    data: &str,
    cfg: &SioSessionConfig,
    events: &mpsc::UnboundedSender<Value>,
    pending_acks: &mut HashMap<u64, String>,
    next_ack_id: &mut u64,
    ws: &mut S,
) where
    S: Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let parsed: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            send(events, json!({"t": "error",
                "message": "发送内容需为 JSON：{\"event\": \"...\", \"args\": [...]}"}));
            return;
        }
    };
    let Some(event) = parsed.get("event").and_then(Value::as_str) else {
        send(events, json!({"t": "error", "message": "缺少 event 字段"}));
        return;
    };
    let args = parsed
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // 组包：42[/nsp,]<ackId>["ev", ...args]
    let ack_id = *next_ack_id;
    *next_ack_id += 1;
    let mut packet = String::from("42");
    if cfg.namespace != "/" {
        packet.push_str(&cfg.namespace);
        packet.push(',');
    }
    packet.push_str(&ack_id.to_string());
    let mut arr = Vec::with_capacity(args.len() + 1);
    arr.push(json!(event));
    arr.extend(args);
    packet.push_str(&Value::Array(arr).to_string());

    match ws.send(Message::Text(packet.into())).await {
        Ok(()) => {
            pending_acks.insert(ack_id, event.to_string());
            // out 回执
            send(events, json!({
                "t": "message", "dir": "out", "data": data,
                "encoding": "text", "ts": now_ms(),
            }));
        }
        Err(e) => send(events, json!({"t": "error", "message": e.to_string()})),
    }
}

// ---------------------------------------------------------------------------
// 测试：node 起 socket.io v4 echo 服务器（apps/runner/tests/node 的 socket.io）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::{Child, Command};

    struct SioTestServer {
        #[allow(dead_code)]
        child: Child,
        url: String,
    }

    /// 启动 node socket.io 测试服务器；node 或 socket.io 不可用时返回 None（跳过测试）
    async fn spawn_sio_server() -> Option<SioTestServer> {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let fixtures = Path::new(manifest).join("tests/node");
        let script = Path::new(manifest).join("tests/fixtures/socketio-server.mjs");
        if !fixtures.join("node_modules/socket.io").exists() {
            eprintln!("skip: socket.io not installed in apps/runner/tests/node");
            return None;
        }
        let mut child = Command::new("node")
            .arg(script)
            .env("NODE_FIXTURES_DIR", &fixtures)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let mut lines = BufReader::new(stdout).lines();
        let line = tokio::time::timeout(Duration::from_secs(15), lines.next_line()).await;
        let port = match line {
            Ok(Ok(Some(l))) => l.strip_prefix("PORT ").map(str::to_string),
            _ => None,
        };
        // node 与依赖都在却起不来 = 真失败，必须炸出来而不是静默跳过
        let Some(port) = port else {
            let mut stderr = String::new();
            if let Some(mut err) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let _ = child.kill().await;
                let _ = err.read_to_string(&mut stderr).await;
            }
            panic!("node 测试服务器未能启动: {stderr}");
        };
        Some(SioTestServer {
            child,
            url: format!("http://127.0.0.1:{port}"),
        })
    }

    type SessionHandle = (
        mpsc::Sender<SessionCtl>,
        mpsc::UnboundedReceiver<Value>,
        tokio::task::JoinHandle<()>,
    );

    async fn start_session(url: String, config: Option<Value>) -> SessionHandle {
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(run_sio_session(
            SioSessionConfig::from_parts(url, config),
            ctl_rx,
            ev_tx,
        ));
        (ctl_tx, ev_rx, handle)
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    async fn next_reply(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        let ev = next_event(rx).await;
        assert_eq!(ev["t"], "message", "unexpected event: {ev}");
        assert_eq!(ev["dir"], "in", "unexpected event: {ev}");
        serde_json::from_str(ev["data"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn socketio_packet_body_parsing() {
        // 无 namespace 无 ack
        assert_eq!(parse_packet_body("[\"ev\",1]"), (None, None, "[\"ev\",1]"));
        // ack id
        assert_eq!(parse_packet_body("3[\"ok\"]"), (None, Some(3), "[\"ok\"]"));
        // namespace + ack id
        assert_eq!(
            parse_packet_body("/admin,12[\"ev\"]"),
            (Some("/admin"), Some(12), "[\"ev\"]")
        );
        // 对象负载（connect / connect_error）
        assert_eq!(
            parse_packet_body("/admin,{\"sid\":\"x\"}"),
            (Some("/admin"), None, "{\"sid\":\"x\"}")
        );
    }

    #[tokio::test]
    async fn socketio_v4_echo_and_ack() {
        let Some(server) = spawn_sio_server().await else { return };
        let (ctl, mut ev_rx, _h) = start_session(server.url, None).await;

        // connecting → open → 服务端 welcome 事件
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "open", "unexpected event: {ev}");
        let welcome = next_reply(&mut ev_rx).await;
        assert_eq!(welcome, json!({"event": "welcome", "args": ["hi"]}));

        // send echo：out 回执 + echoed 事件 + ack 回推
        ctl.send(SessionCtl::Send {
            data: json!({"event": "echo", "args": ["hello"]}).to_string(),
            encoding: "text".to_string(),
        })
        .await
        .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        let echoed = next_reply(&mut ev_rx).await;
        assert_eq!(echoed, json!({"event": "echoed", "args": ["hello"]}));
        let ack = next_reply(&mut ev_rx).await;
        assert_eq!(
            ack,
            json!({"event": "[ack] echo", "args": ["ack:\"hello\""]})
        );

        // 缺 event 字段 → error 事件
        ctl.send(SessionCtl::Send {
            data: json!({"args": []}).to_string(),
            encoding: "text".to_string(),
        })
        .await
        .unwrap();
        let err = next_event(&mut ev_rx).await;
        assert_eq!(err["t"], "error");
        assert!(err["message"].as_str().unwrap().contains("缺少 event"));

        // 主动关闭 → status closed
        ctl.send(SessionCtl::Close).await.unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "status");
        assert_eq!(ev["state"], "closed");
    }

    #[tokio::test]
    async fn socketio_connect_error_reports_error_event() {
        let (_ctl, mut ev_rx, handle) =
            start_session("http://127.0.0.1:1".to_string(), None).await;
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let err = next_event(&mut ev_rx).await;
        assert_eq!(err["t"], "error");
        assert!(err["message"]
            .as_str()
            .unwrap()
            .starts_with("connect_error:"));
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "error");
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn socketio_v2_v3_unsupported() {
        let (_ctl, mut ev_rx, handle) = start_session(
            "http://127.0.0.1:3000".to_string(),
            Some(json!({"version": "v2"})),
        )
        .await;
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "error");
        assert!(ev["reason"].as_str().unwrap().contains("只支持 v4"));
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .unwrap()
            .unwrap();
    }
}

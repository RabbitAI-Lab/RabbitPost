//! GraphQL Subscription 协议 session：graphql-transport-ws 子协议（手写，基于 tokio-tungstenite）。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致。
//! - url 允许 http(s)://（自动转 ws(s)://）；握手子协议 "graphql-transport-ws"
//! - 事件帧（in 的 data 字段，JSON 字符串）：
//!   数据   { "action": "subscribe", "event": "data", "payload": {...} }
//!   错误   { "action": "subscribe", "event": "error", "error": "..." }
//!   完成   { "action": "subscribe", "event": "complete" }
//! - 同一 session 限制一个活跃订阅；subscribe 受理后回推 out 原帧

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::SessionCtl;

/// graphql-transport-ws 子协议标识
const SUBPROTOCOL: &str = "graphql-transport-ws";
/// 活跃订阅固定 id（限一个活跃订阅）
const SUB_ID: &str = "1";

/// GraphQL Subscription session 连接参数（从 downlink start 指令的 config 解析）
pub struct GqlSubSessionConfig {
    pub url: String,
    /// 握手 connection_init 负载
    pub connection_params: Option<Value>,
}

impl GqlSubSessionConfig {
    /// config 形状（与 apps/api/src/lib/rt.ts（帧契约） 一致）：
    /// `{ connectionParams?: object }`；url 允许 http(s):// 自动转 ws(s)://
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        let url = if let Some(rest) = url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if let Some(rest) = url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else {
            url
        };
        let connection_params = config
            .as_ref()
            .and_then(|c| c.get("connectionParams"))
            .filter(|p| p.is_object())
            .cloned();
        Self {
            url,
            connection_params,
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// in 消息：订阅事件（data / error / complete）
fn emit_sub_event(events: &mpsc::UnboundedSender<Value>, data: Value) {
    send(events, json!({
        "t": "message", "dir": "in",
        "data": data.to_string(),
        "encoding": "text", "ts": now_ms(),
    }));
}

/// 运行一个 GraphQL Subscription session 直到连接结束；事件（不带 id）逐条送入 events。
pub async fn run_gql_sub_session(
    cfg: GqlSubSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    let mut request = match cfg.url.clone().into_client_request() {
        Ok(req) => req,
        Err(e) => {
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        SUBPROTOCOL.parse().expect("subprotocol header value is valid"),
    );

    let (mut ws, _response) = match connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            send(&events, json!({"t": "error", "message": e.to_string()}));
            return;
        }
    };

    // connection_init（带 connectionParams），等待 connection_ack
    let mut init = json!({"type": "connection_init"});
    if let Some(params) = &cfg.connection_params {
        init["payload"] = params.clone();
    }
    if let Err(e) = ws.send(Message::Text(init.to_string().into())).await {
        send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
        return;
    }
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => {
                let msg: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match msg.get("type").and_then(Value::as_str) {
                    Some("connection_ack") => {
                        send(&events, json!({"t": "status", "state": "open"}));
                        break;
                    }
                    Some("connection_error") => {
                        send(&events, json!({
                            "t": "error",
                            "message": msg.get("payload").cloned().unwrap_or(Value::Null).to_string(),
                        }));
                        send(&events, json!({"t": "status", "state": "closed"}));
                        return;
                    }
                    // ping/ka 等在 ack 前的帧忽略
                    _ => {}
                }
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
            Some(Ok(_)) => {}
        }
    }

    let mut active = false;
    loop {
        tokio::select! {
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match msg.get("type").and_then(Value::as_str) {
                            Some("next") => emit_sub_event(&events, json!({
                                "action": "subscribe", "event": "data",
                                "payload": msg.get("payload").cloned().unwrap_or(Value::Null),
                            })),
                            Some("error") => {
                                active = false;
                                emit_sub_event(&events, json!({
                                    "action": "subscribe", "event": "error",
                                    "error": msg.get("payload").cloned().unwrap_or(Value::Null).to_string(),
                                }));
                            }
                            Some("complete") => {
                                active = false;
                                emit_sub_event(&events, json!({
                                    "action": "subscribe", "event": "complete",
                                }));
                            }
                            // 协议层 ping：回 pong；pong/ka 忽略
                            Some("ping") => {
                                let _ = ws.send(Message::Text(
                                    json!({"type": "pong"}).to_string().into(),
                                )).await;
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (Some(u16::from(f.code)), f.reason.to_string()))
                            .unwrap_or((None, String::new()));
                        let _ = ws.close(None).await;
                        send(&events, json!({
                            "t": "status", "state": "closed", "code": code, "reason": reason,
                        }));
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        send(&events, json!({"t": "error", "message": e.to_string()}));
                        send(&events, json!({"t": "status", "state": "closed", "reason": e.to_string()}));
                        break;
                    }
                    None => {
                        send(&events, json!({"t": "status", "state": "closed"}));
                        break;
                    }
                }
            }
            command = ctl.recv() => {
                match command {
                    Some(SessionCtl::Send { data, .. }) => {
                        handle_action(&mut ws, &events, &data, &mut active).await;
                    }
                    // 控制通道关闭（downlink 断开）等价于 close：优雅收尾
                    Some(SessionCtl::Close) | None => {
                        if active {
                            let _ = ws.send(Message::Text(
                                json!({"id": SUB_ID, "type": "complete"}).to_string().into(),
                            )).await;
                        }
                        let _ = ws.close(None).await;
                        send(&events, json!({
                            "t": "status", "state": "closed", "reason": "closed by client",
                        }));
                        break;
                    }
                }
            }
        }
    }
}

/// 处理一帧发送动作（JSON 字符串）：subscribe / stop
async fn handle_action(
    ws: &mut (impl futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
              + Unpin),
    events: &mpsc::UnboundedSender<Value>,
    data: &str,
    active: &mut bool,
) {
    let action: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            send(
                events,
                json!({"t": "error", "message": "发送内容需为 JSON 动作帧（subscribe/stop）"}),
            );
            return;
        }
    };
    match action.get("action").and_then(Value::as_str) {
        Some("subscribe") => {
            let Some(query) = action.get("query").and_then(Value::as_str) else {
                send(events, json!({"t": "error", "message": "subscribe 缺少 query"}));
                return;
            };
            if *active {
                send(events, json!({"t": "error", "message": "已有活跃订阅，请先 stop"}));
                return;
            }
            let mut payload = json!({"query": query});
            if let Some(v) = action.get("variables") {
                payload["variables"] = v.clone();
            }
            if let Some(n) = action.get("operationName").and_then(Value::as_str) {
                payload["operationName"] = json!(n);
            }
            let frame = json!({"id": SUB_ID, "type": "subscribe", "payload": payload});
            match ws.send(Message::Text(frame.to_string().into())).await {
                // 受理回执：回推 out 原帧
                Ok(()) => {
                    *active = true;
                    send(events, json!({
                        "t": "message", "dir": "out", "data": data,
                        "encoding": "text", "ts": now_ms(),
                    }));
                }
                Err(e) => send(events, json!({"t": "error", "message": e.to_string()})),
            }
        }
        Some("stop") => {
            if *active {
                *active = false;
                if let Err(e) = ws
                    .send(Message::Text(
                        json!({"id": SUB_ID, "type": "complete"}).to_string().into(),
                    ))
                    .await
                {
                    send(events, json!({"t": "error", "message": e.to_string()}));
                }
            }
        }
        other => send(events, json!({
            "t": "error",
            "message": format!("未知动作：{}", other.unwrap_or("<missing>")),
        })),
    }
}

// ---------------------------------------------------------------------------
// 测试：本地 tungstenite 最小 graphql-transport-ws 服务
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    /// 最小 graphql-transport-ws 服务：回选子协议；connection_init→ack（init 原文经通道上报）；
    /// subscribe→连发两条 next；complete→回 complete
    async fn spawn_gql_ws_server() -> (String, mpsc::UnboundedReceiver<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (init_tx, init_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let init_tx = init_tx.clone();
                tokio::spawn(async move {
                    let callback = |req: &Request, mut resp: Response| {
                        if req
                            .headers()
                            .get("Sec-WebSocket-Protocol")
                            .and_then(|v| v.to_str().ok())
                            .is_some_and(|v| v.split(',').any(|p| p.trim() == SUBPROTOCOL))
                        {
                            resp.headers_mut()
                                .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
                        }
                        Ok(resp)
                    };
                    let mut ws = accept_hdr_async(stream, callback).await.unwrap();
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match msg.get("type").and_then(Value::as_str) {
                            Some("connection_init") => {
                                let _ = init_tx.send(msg.clone());
                                let ack = json!({"type": "connection_ack"});
                                if ws.send(Message::Text(ack.to_string().into())).await.is_err() {
                                    return;
                                }
                            }
                            Some("subscribe") => {
                                for n in 0..2 {
                                    let next = json!({
                                        "id": msg["id"], "type": "next",
                                        "payload": {"data": {"n": n}},
                                    });
                                    if ws
                                        .send(Message::Text(next.to_string().into()))
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                            Some("complete") => {
                                let done = json!({"id": msg["id"], "type": "complete"});
                                if ws.send(Message::Text(done.to_string().into())).await.is_err()
                                {
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        (format!("http://{addr}/graphql"), init_rx)
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    #[test]
    fn gql_sub_url_conversion() {
        let cfg = GqlSubSessionConfig::from_parts("http://h/graphql".to_string(), None);
        assert_eq!(cfg.url, "ws://h/graphql");
        let cfg = GqlSubSessionConfig::from_parts("https://h/graphql".to_string(), None);
        assert_eq!(cfg.url, "wss://h/graphql");
        let cfg = GqlSubSessionConfig::from_parts("ws://h/graphql".to_string(), None);
        assert_eq!(cfg.url, "ws://h/graphql");
        let cfg = GqlSubSessionConfig::from_parts(
            "ws://h".to_string(),
            Some(json!({"connectionParams": {"auth": "t"}})),
        );
        assert_eq!(cfg.connection_params, Some(json!({"auth": "t"})));
    }

    #[tokio::test]
    async fn gql_sub_session_full_roundtrip() {
        let (url, mut init_rx) = spawn_gql_ws_server().await;
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_gql_sub_session(
            GqlSubSessionConfig::from_parts(
                url,
                Some(json!({"connectionParams": {"auth": "t"}})),
            ),
            ctl_rx,
            ev_tx,
        ));

        // connecting → open（connection_ack）
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        assert_eq!(next_event(&mut ev_rx).await["state"], "open");

        // connection_init 带上了 connectionParams
        let init = tokio::time::timeout(Duration::from_secs(5), init_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(init["type"], "connection_init");
        assert_eq!(init["payload"], json!({"auth": "t"}));

        // subscribe：受理回 out 原帧，随后两条 next → in data
        let sub = r#"{"action":"subscribe","query":"subscription { n }"}"#;
        ctl_tx
            .send(SessionCtl::Send {
                data: sub.to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        assert_eq!(out["data"], sub);
        assert_eq!(out["encoding"], "text");
        assert!(out["ts"].as_i64().unwrap() > 0);
        for n in 0..2 {
            let ev = next_event(&mut ev_rx).await;
            assert_eq!(ev["dir"], "in");
            let data: Value = serde_json::from_str(ev["data"].as_str().unwrap()).unwrap();
            assert_eq!(
                data,
                json!({"action": "subscribe", "event": "data",
                       "payload": {"data": {"n": n}}})
            );
        }

        // 重复 subscribe → error
        ctl_tx
            .send(SessionCtl::Send {
                data: sub.to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "error");
        assert_eq!(ev["message"], "已有活跃订阅，请先 stop");

        // stop → 服务端回 complete → in complete
        ctl_tx
            .send(SessionCtl::Send {
                data: r#"{"action":"stop"}"#.to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["dir"], "in");
        let data: Value = serde_json::from_str(ev["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, json!({"action": "subscribe", "event": "complete"}));

        // 错误路径：非 JSON、未知动作、缺 query
        for (bad, expect) in [
            ("nope", "发送内容需为 JSON 动作帧"),
            (r#"{"action":"noop"}"#, "未知动作：noop"),
            (r#"{"action":"subscribe"}"#, "subscribe 缺少 query"),
        ] {
            ctl_tx
                .send(SessionCtl::Send {
                    data: bad.to_string(),
                    encoding: "text".to_string(),
                })
                .await
                .unwrap();
            let ev = next_event(&mut ev_rx).await;
            assert_eq!(ev["t"], "error");
            assert!(
                ev["message"].as_str().unwrap().contains(expect),
                "unexpected error: {ev}"
            );
        }

        // close：回传 closed，任务结束
        ctl_tx.send(SessionCtl::Close).await.unwrap();
        let closed = next_event(&mut ev_rx).await;
        assert_eq!(closed["t"], "status");
        assert_eq!(closed["state"], "closed");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn gql_sub_session_reports_connect_error() {
        let (_ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_gql_sub_session(
            GqlSubSessionConfig::from_parts("ws://127.0.0.1:1/graphql".to_string(), None),
            ctl_rx,
            ev_tx,
        ));
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        assert_eq!(next_event(&mut ev_rx).await["state"], "error");
        assert_eq!(next_event(&mut ev_rx).await["t"], "error");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }
}

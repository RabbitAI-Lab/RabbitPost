//! WebSocket 协议 session：连接目标 ws/wss，双向透传消息，事件经 channel 回传。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致（status/message/error 形状）。

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use super::SessionCtl;

/// WebSocket session 连接参数（从 downlink start 指令的 config 解析）
pub struct WsSessionConfig {
    pub url: String,
    /// 握手时附加的 HTTP 头（已过滤 enabled != false 与空 key）
    pub headers: Vec<(String, String)>,
    /// Sec-WebSocket-Protocol 子协议列表
    pub protocols: Vec<String>,
}

impl WsSessionConfig {
    /// config 形状（与 apps/api/src/lib/rt.ts（帧契约） 一致）：
    /// `{ headers?: [{key, value, enabled?}], protocols?: string[] }`
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        let headers = config
            .as_ref()
            .and_then(|c| c.get("headers"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|h| {
                        let enabled = h.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                        let key = h.get("key")?.as_str()?;
                        let value = h.get("value")?.as_str()?;
                        (enabled && !key.is_empty())
                            .then(|| (key.to_string(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let protocols = config
            .as_ref()
            .and_then(|c| c.get("protocols"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            url,
            headers,
            protocols,
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    // 接收端（事件上行任务）只在本任务结束后才消失，正常不会失败
    let _ = events.send(event);
}

/// 运行一个 WebSocket session 直到连接结束；事件（不带 id）逐条送入 events。
pub async fn run_ws_session(
    cfg: WsSessionConfig,
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
    for (key, value) in &cfg.headers {
        match (key.parse::<HeaderName>(), value.parse::<HeaderValue>()) {
            (Ok(name), Ok(val)) => {
                request.headers_mut().append(name, val);
            }
            _ => send(
                &events,
                json!({"t": "error", "message": format!("invalid header skipped: {key}")}),
            ),
        }
    }
    if !cfg.protocols.is_empty() {
        if let Ok(val) = cfg.protocols.join(", ").parse::<HeaderValue>() {
            request
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", val);
        }
    }

    let (mut ws, _response) = match connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            send(&events, json!({"t": "error", "message": e.to_string()}));
            return;
        }
    };
    send(&events, json!({"t": "status", "state": "open"}));

    loop {
        tokio::select! {
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => send(&events, json!({
                        "t": "message", "dir": "in", "data": text.as_str(),
                        "encoding": "text", "ts": now_ms(),
                    })),
                    Some(Ok(Message::Binary(bytes))) => send(&events, json!({
                        "t": "message", "dir": "in",
                        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
                        "encoding": "base64", "ts": now_ms(),
                    })),
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (Some(u16::from(f.code)), f.reason.to_string()))
                            .unwrap_or((None, String::new()));
                        // 礼貌回敬 close 帧；失败无所谓，连接本就在收尾
                        let _ = ws.close(None).await;
                        send(&events, json!({
                            "t": "status", "state": "closed", "code": code, "reason": reason,
                        }));
                        break;
                    }
                    // ping/pong 由 tungstenite 自动应答，无需上报
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
                    Some(SessionCtl::Send { data, encoding }) => {
                        let frame = if encoding == "base64" {
                            match base64::engine::general_purpose::STANDARD.decode(&data) {
                                Ok(bytes) => Message::Binary(bytes.into()),
                                Err(e) => {
                                    send(&events, json!({
                                        "t": "error",
                                        "message": format!("invalid base64 payload: {e}"),
                                    }));
                                    continue;
                                }
                            }
                        } else {
                            Message::Text(data.clone().into())
                        };
                        match ws.send(frame).await {
                            // 发送成功后回推 out 事件，统一消息时间线
                            Ok(()) => send(&events, json!({
                                "t": "message", "dir": "out", "data": data,
                                "encoding": encoding, "ts": now_ms(),
                            })),
                            Err(e) => send(&events, json!({"t": "error", "message": e.to_string()})),
                        }
                    }
                    // 控制通道关闭（downlink 断开）等价于 close：优雅收尾
                    Some(SessionCtl::Close) | None => {
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

// ---------------------------------------------------------------------------
// 测试：本地 tungstenite echo 服务，验证 session 全链路（不经 api）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    /// 本地 echo 服务：文本/二进制原样回显；握手头与子协议经通道上报供断言
    async fn spawn_echo_server() -> (
        String,
        mpsc::UnboundedReceiver<Vec<(String, String)>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hdr_tx, hdr_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let hdr_tx = hdr_tx.clone();
                tokio::spawn(async move {
                    let callback = |req: &Request, mut resp: Response| {
                        let headers = req
                            .headers()
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                            .collect();
                        let _ = hdr_tx.send(headers);
                        // 回选客户端请求的第一个子协议：tungstenite 客户端要求
                        // 请求了子协议时服务端必须从中选择一个，否则握手失败
                        if let Some(v) = req
                            .headers()
                            .get("Sec-WebSocket-Protocol")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.split(',').next())
                        {
                            if let Ok(v) = v.trim().parse() {
                                resp.headers_mut().insert("Sec-WebSocket-Protocol", v);
                            }
                        }
                        Ok(resp)
                    };
                    let mut ws = accept_hdr_async(stream, callback).await.unwrap();
                    while let Some(Ok(msg)) = ws.next().await {
                        if (msg.is_text() || msg.is_binary()) && ws.send(msg).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (format!("ws://{addr}"), hdr_rx)
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    #[tokio::test]
    async fn websocket_session_full_roundtrip() {
        let (url, mut hdr_rx) = spawn_echo_server().await;
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_ws_session(
            WsSessionConfig::from_parts(
                url,
                Some(json!({
                    "headers": [
                        { "key": "X-Test", "value": "yes", "enabled": true },
                        { "key": "X-Off", "value": "no", "enabled": false },
                    ],
                    "protocols": ["chat"],
                })),
            ),
            ctl_rx,
            ev_tx,
        ));

        // connecting → open
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "open", "unexpected event: {ev}");

        // 握手带上了启用的自定义头与子协议，禁用的头被过滤
        let headers = tokio::time::timeout(Duration::from_secs(5), hdr_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(headers.contains(&("x-test".to_string(), "yes".to_string())));
        assert!(!headers.iter().any(|(k, _)| k == "x-off"));
        assert!(headers.contains(&("sec-websocket-protocol".to_string(), "chat".to_string())));

        // 文本发送：out 回执 + echo 回来的 in
        ctl_tx
            .send(SessionCtl::Send {
                data: "hello".to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        assert_eq!(out["data"], "hello");
        assert_eq!(out["encoding"], "text");
        assert!(out["ts"].as_i64().unwrap() > 0);
        let echoed = next_event(&mut ev_rx).await;
        assert_eq!(echoed["dir"], "in");
        assert_eq!(echoed["data"], "hello");
        assert_eq!(echoed["encoding"], "text");

        // base64 发送：解码为二进制帧，echo 回来仍是 base64
        let b64 = base64::engine::general_purpose::STANDARD.encode([0x01, 0x02, 0xff]);
        ctl_tx
            .send(SessionCtl::Send {
                data: b64.clone(),
                encoding: "base64".to_string(),
            })
            .await
            .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["dir"], "out");
        assert_eq!(out["encoding"], "base64");
        let echoed = next_event(&mut ev_rx).await;
        assert_eq!(echoed["dir"], "in");
        assert_eq!(echoed["data"], b64);
        assert_eq!(echoed["encoding"], "base64");

        // 关闭：回传 closed，任务结束
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
    async fn websocket_session_reports_connect_error() {
        // 连接一个未监听的端口：应收到 status error + error 事件
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        drop(ctl_tx);
        let session = tokio::spawn(run_ws_session(
            WsSessionConfig::from_parts("ws://127.0.0.1:1/unreachable".to_string(), None),
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

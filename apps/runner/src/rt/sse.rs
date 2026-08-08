//! SSE（Server-Sent Events）协议 session：流式 GET 只读事件流，事件经 channel 回传。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致（status/message/error 形状）。
//! - 消息帧（in 的 data 字段，JSON 字符串）：{ "event", "data", "id" }
//! - send 不支持（只读流），回 error

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::SessionCtl;

/// SSE session 连接参数（从 downlink start 指令的 config 解析）
pub struct SseSessionConfig {
    pub url: String,
    /// 请求头（已过滤 enabled != false 与空 key）
    pub headers: Vec<(String, String)>,
}

impl SseSessionConfig {
    /// config 形状（与 apps/api/src/lib/rt.ts（帧契约） 一致）：
    /// `{ headers?: [{key, value, enabled?}] }`
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
        Self { url, headers }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// SSE 流解析器：data 多行拼接、event、id（跨事件保持），空行分发，
/// 忽略 : 注释与 retry 等未知字段。feed 返回本次解析出的事件（{event,data,id}）。
#[derive(Default)]
struct SseParser {
    /// 未完整一行的残留
    buffer: String,
    event: String,
    data_lines: Vec<String>,
    last_id: String,
}

impl SseParser {
    fn feed(&mut self, chunk: &str) -> Vec<Value> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();
        while let Some(line) = self.take_line() {
            if let Some(event) = self.process_line(&line) {
                out.push(event);
            }
        }
        out
    }

    /// 取一行（\r\n / \r / \n 分隔）；buffer 以 \r 结尾时等下一块，避免拆散 \r\n
    fn take_line(&mut self) -> Option<String> {
        let bytes = self.buffer.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'\n' => {
                    let mut line: String = self.buffer.drain(..=i).collect();
                    line.pop(); // \n
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    return Some(line);
                }
                b'\r' => {
                    if i + 1 == bytes.len() {
                        return None; // \r 在末尾，等下一块判断是否为 \r\n
                    }
                    let line: String = self.buffer.drain(..i).collect();
                    self.buffer.drain(..1); // \r
                    return Some(line);
                }
                _ => {}
            }
        }
        None
    }

    /// 处理一行；空行触发分发，有 data 时产出事件
    fn process_line(&mut self, line: &str) -> Option<Value> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None; // 注释行
        }
        let (field, raw_value) = match line.find(':') {
            Some(colon) => (&line[..colon], &line[colon + 1..]),
            None => (line, ""),
        };
        let value = raw_value.strip_prefix(' ').unwrap_or(raw_value);
        match field {
            "data" => self.data_lines.push(value.to_string()),
            "event" => self.event = value.to_string(),
            "id" if !value.contains('\0') => self.last_id = value.to_string(),
            _ => {} // retry 及其它未知字段忽略
        }
        None
    }

    fn dispatch(&mut self) -> Option<Value> {
        if self.data_lines.is_empty() {
            return None;
        }
        let event = json!({
            "event": if self.event.is_empty() { "message" } else { self.event.as_str() },
            "data": self.data_lines.join("\n"),
            "id": self.last_id,
        });
        self.event.clear();
        self.data_lines.clear();
        Some(event)
    }
}

/// 运行一个 SSE session 直到流结束或被关闭；事件（不带 id）逐条送入 events。
pub async fn run_sse_session(
    cfg: SseSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    let client = reqwest::Client::new();
    let mut req = client
        .get(&cfg.url)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    for (key, value) in &cfg.headers {
        match (
            key.parse::<reqwest::header::HeaderName>(),
            value.parse::<reqwest::header::HeaderValue>(),
        ) {
            (Ok(name), Ok(val)) => {
                req = req.header(name, val);
            }
            _ => send(
                &events,
                json!({"t": "error", "message": format!("invalid header skipped: {key}")}),
            ),
        }
    }

    // 流读取在子任务中进行，主循环统一处理 ctl 与事件，close 时 abort 子任务
    let (net_tx, mut net_rx) = mpsc::unbounded_channel::<Value>();
    let reader = tokio::spawn(async move {
        stream_sse(req, net_tx).await;
    });

    loop {
        tokio::select! {
            event = net_rx.recv() => {
                match event {
                    Some(ev) => {
                        let terminal = ev["state"] == "closed" || ev["state"] == "error";
                        send(&events, ev);
                        if terminal {
                            break;
                        }
                    }
                    // 流任务结束但未发 closed（不应发生）：兜底退出
                    None => break,
                }
            }
            command = ctl.recv() => {
                match command {
                    Some(SessionCtl::Send { .. }) => send(
                        &events,
                        json!({"t": "error", "message": "SSE 为只读流，不支持发送"}),
                    ),
                    // 控制通道关闭（downlink 断开）等价于 close：abort 流并收尾
                    Some(SessionCtl::Close) | None => {
                        reader.abort();
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

/// 发起请求并逐块解析 SSE 流，事件直接成形后送入 net_tx
async fn stream_sse(req: reqwest::RequestBuilder, net_tx: mpsc::UnboundedSender<Value>) {
    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(e) => {
            let _ = net_tx.send(json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let reason = format!(
            "HTTP {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        );
        let _ = net_tx.send(json!({"t": "status", "state": "error", "reason": reason.trim()}));
        return;
    }
    let _ = net_tx.send(json!({"t": "status", "state": "open"}));

    let mut parser = SseParser::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                for event in parser.feed(&String::from_utf8_lossy(&bytes)) {
                    let _ = net_tx.send(json!({
                        "t": "message", "dir": "in",
                        "data": event.to_string(),
                        "encoding": "text", "ts": now_ms(),
                    }));
                }
            }
            Err(e) => {
                let _ = net_tx.send(json!({
                    "t": "error", "message": format!("SSE 流读取失败：{e}"),
                }));
                return;
            }
        }
    }
    // 服务端结束流
    let _ = net_tx.send(json!({"t": "status", "state": "closed"}));
}

// ---------------------------------------------------------------------------
// 测试：裸 TcpListener 手写 SSE 响应，验证解析与事件格式
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 读掉 HTTP 请求头后回写给定响应；hold=true 时保持连接不关闭
    async fn spawn_http_server(response: &'static str, hold: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let mut read = 0;
                    // 读到 \r\n\r\n 为止
                    while !buf[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf[read..]).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => read += n,
                        }
                    }
                    if stream.write_all(response.as_bytes()).await.is_err() {
                        return;
                    }
                    if hold {
                        // 保持连接直到对端关闭
                        let mut sink = [0u8; 256];
                        while stream.read(&mut sink).await.unwrap_or(0) > 0 {}
                    }
                });
            }
        });
        format!("http://{addr}/events")
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    use std::time::Duration;

    #[test]
    fn sse_parser_spec_cases() {
        let mut p = SseParser::default();
        // 注释行与 retry 被忽略；空行只在有 data 时分发
        assert!(p.feed(": comment\nretry: 1000\n\n").is_empty());
        // 自定义 event + 多行 data 拼接 + id
        let out = p.feed("event: greeting\ndata: hello\ndata: world\nid: 42\n\n");
        assert_eq!(
            out,
            vec![json!({"event": "greeting", "data": "hello\nworld", "id": "42"})]
        );
        // 缺省 event=message；id 跨事件保持
        let out = p.feed("data: plain\n\n");
        assert_eq!(
            out,
            vec![json!({"event": "message", "data": "plain", "id": "42"})]
        );
        // 跨块拆行（含 \r\n 被拆开）
        assert!(p.feed("data: spl").is_empty());
        assert!(p.feed("it\r").is_empty());
        let out = p.feed("\n\n");
        assert_eq!(
            out,
            vec![json!({"event": "message", "data": "split", "id": "42"})]
        );
    }

    #[tokio::test]
    async fn sse_session_parses_stream() {
        let url = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
             : comment\n\
             event: greeting\ndata: hello\ndata: world\nid: 42\n\n\
             data: plain\n\n\
             retry: 1000\n\n\
             data: second\n\n",
            true,
        )
        .await;
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_sse_session(
            SseSessionConfig::from_parts(url, None),
            ctl_rx,
            ev_tx,
        ));

        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        assert_eq!(next_event(&mut ev_rx).await["state"], "open");

        let first = next_event(&mut ev_rx).await;
        assert_eq!(first["t"], "message");
        assert_eq!(first["dir"], "in");
        let data: Value = serde_json::from_str(first["data"].as_str().unwrap()).unwrap();
        assert_eq!(
            data,
            json!({"event": "greeting", "data": "hello\nworld", "id": "42"})
        );
        assert_eq!(first["encoding"], "text");
        assert!(first["ts"].as_i64().unwrap() > 0);

        let second = next_event(&mut ev_rx).await;
        let data: Value = serde_json::from_str(second["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, json!({"event": "message", "data": "plain", "id": "42"}));

        // retry 块不产生事件，直接到下一条
        let third = next_event(&mut ev_rx).await;
        let data: Value = serde_json::from_str(third["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, json!({"event": "message", "data": "second", "id": "42"}));

        // send → 只读流报错
        ctl_tx
            .send(SessionCtl::Send {
                data: "x".to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "error");
        assert_eq!(ev["message"], "SSE 为只读流，不支持发送");

        // close → closed，任务结束
        ctl_tx.send(SessionCtl::Close).await.unwrap();
        assert_eq!(next_event(&mut ev_rx).await["state"], "closed");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn sse_session_reports_http_error() {
        let url = spawn_http_server(
            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n",
            false,
        )
        .await;
        let (_ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_sse_session(
            SseSessionConfig::from_parts(url, None),
            ctl_rx,
            ev_tx,
        ));
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "error");
        assert_eq!(ev["reason"], "HTTP 404 Not Found");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn sse_session_closed_when_server_ends_stream() {
        let url = spawn_http_server(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: one\n\n",
            false,
        )
        .await;
        let (_ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_sse_session(
            SseSessionConfig::from_parts(url, None),
            ctl_rx,
            ev_tx,
        ));
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        assert_eq!(next_event(&mut ev_rx).await["state"], "open");
        assert_eq!(next_event(&mut ev_rx).await["t"], "message");
        // 服务端结束流 → closed
        assert_eq!(next_event(&mut ev_rx).await["state"], "closed");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }
}

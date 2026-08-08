//! MCP 协议 session：rmcp（MCP 官方 Rust SDK）streamable-http 客户端。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致：
//! - 连接成功 → status open + in {"action":"serverInfo","result":{"server","capabilities","instructions"}}
//! - send 动作帧（JSON 字符串）：tools/list、tools/call、resources/list、resources/read、
//!   prompts/list、prompts/get；out 回执先行，结果以同 action 的 in 消息回推 {action,result} 或 {action,error}

use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, GetPromptRequestParams, ReadResourceRequestParams,
};
use rmcp::transport::common::client_side_sse::NeverRetry;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::SessionCtl;

/// initialize 握手超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// MCP session 连接参数（从 downlink start 指令的 config 解析）
pub struct McpSessionConfig {
    pub url: String,
    /// config.transport：streamable-http（默认/ auto）；sse 暂不支持
    pub transport: String,
}

impl McpSessionConfig {
    /// config 形状：`{ transport?: "streamable-http" | "sse" | "auto" }`
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        let transport = config
            .as_ref()
            .and_then(|c| c.get("transport"))
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string();
        Self { url, transport }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// in 方向的协议消息：{"action": action, "result" | "error"}
fn reply(events: &mpsc::UnboundedSender<Value>, action: &str, payload: Value) {
    let mut obj = serde_json::Map::new();
    obj.insert("action".to_string(), json!(action));
    if let Value::Object(p) = payload {
        obj.extend(p);
    }
    send(
        events,
        json!({
            "t": "message", "dir": "in", "data": Value::Object(obj).to_string(),
            "encoding": "text", "ts": now_ms(),
        }),
    );
}

/// 运行一个 MCP session 直到关闭；事件（不带 id）逐条送入 events。
pub async fn run_mcp_session(
    cfg: McpSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    if cfg.transport == "sse" {
        send(&events, json!({"t": "status", "state": "error",
            "reason": "runner 的 MCP 客户端暂不支持 legacy SSE transport"}));
        return;
    }

    // 关掉 SSE 重试：连接失败要立即报错，而不是无限重连
    let mut config = StreamableHttpClientTransportConfig::with_uri(cfg.url.as_str());
    config.retry_config = std::sync::Arc::new(NeverRetry::default());
    let transport = StreamableHttpClientTransport::from_config(config);
    let client = match tokio::time::timeout(CONNECT_TIMEOUT, ().serve(transport)).await {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => {
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
        Err(_) => {
            send(&events, json!({"t": "status", "state": "error", "reason": "MCP initialize 超时"}));
            return;
        }
    };

    send(&events, json!({"t": "status", "state": "open"}));
    // serverInfo：server / capabilities / instructions
    if let Some(info) = client.peer_info() {
        let mut result = serde_json::Map::new();
        result.insert(
            "server".to_string(),
            serde_json::to_value(&info.server_info).unwrap_or(Value::Null),
        );
        result.insert(
            "capabilities".to_string(),
            serde_json::to_value(&info.capabilities).unwrap_or(Value::Null),
        );
        if let Some(instructions) = &info.instructions {
            result.insert("instructions".to_string(), json!(instructions));
        }
        reply(&events, "serverInfo", json!({ "result": Value::Object(result) }));
    }

    loop {
        match ctl.recv().await {
            Some(SessionCtl::Send { data, .. }) => {
                // out 回执先行，结果异步回推（此处在同任务内顺序处理）
                send(
                    &events,
                    json!({
                        "t": "message", "dir": "out", "data": data,
                        "encoding": "text", "ts": now_ms(),
                    }),
                );
                handle_action(&data, &client, &events).await;
            }
            Some(SessionCtl::Close) | None => {
                let _ = client.cancel().await;
                send(&events, json!({"t": "status", "state": "closed"}));
                return;
            }
        }
    }
}

async fn handle_action(
    data: &str,
    client: &rmcp::service::RunningService<rmcp::service::RoleClient, ()>,
    events: &mpsc::UnboundedSender<Value>,
) {
    let action: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            reply(events, "error", json!({"error": "发送内容需为 JSON 动作帧"}));
            return;
        }
    };
    let name = action.get("action").and_then(Value::as_str).unwrap_or("");
    match name {
        "tools/list" => match client.list_tools(None).await {
            Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
            Err(e) => reply(events, name, json!({"error": e.to_string()})),
        },
        "tools/call" => {
            let Some(tool) = action.get("name").and_then(Value::as_str) else {
                reply(events, name, json!({"error": "缺少 name 字段"}));
                return;
            };
            let arguments = action
                .get("arguments")
                .and_then(Value::as_object)
                .cloned();
            let mut params = CallToolRequestParams::new(tool.to_string());
            params.arguments = arguments;
            match client.call_tool(params).await {
                Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
                Err(e) => reply(events, name, json!({"error": e.to_string()})),
            }
        }
        "resources/list" => match client.list_resources(None).await {
            Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
            Err(e) => reply(events, name, json!({"error": e.to_string()})),
        },
        "resources/read" => {
            let Some(uri) = action.get("uri").and_then(Value::as_str) else {
                reply(events, name, json!({"error": "缺少 uri 字段"}));
                return;
            };
            let params = ReadResourceRequestParams::new(uri.to_string());
            match client.read_resource(params).await {
                Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
                Err(e) => reply(events, name, json!({"error": e.to_string()})),
            }
        }
        "prompts/list" => match client.list_prompts(None).await {
            Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
            Err(e) => reply(events, name, json!({"error": e.to_string()})),
        },
        "prompts/get" => {
            let Some(prompt) = action.get("name").and_then(Value::as_str) else {
                reply(events, name, json!({"error": "缺少 name 字段"}));
                return;
            };
            let arguments = action
                .get("arguments")
                .and_then(Value::as_object)
                .cloned();
            let mut params = GetPromptRequestParams::new(prompt.to_string());
            params.arguments = arguments;
            match client.get_prompt(params).await {
                Ok(r) => reply(events, name, json!({"result": serde_json::to_value(r).unwrap_or(Value::Null)})),
                Err(e) => reply(events, name, json!({"error": e.to_string()})),
            }
        }
        other => reply(events, "error", json!({"error": format!("未知动作：{other}")})),
    }
}

// ---------------------------------------------------------------------------
// 测试：node 起最小 MCP 服务器（apps/runner/tests/node 的 @modelcontextprotocol/sdk，
// stateless Streamable HTTP，写法参考 tests/fixtures/mcp-server.mjs）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::{Child, Command};

    struct McpTestServer {
        // 进程随 drop 杀死（kill_on_drop）
        #[allow(dead_code)]
        child: Child,
        url: String,
    }

    /// 启动 node MCP 测试服务器；node 或 sdk 不可用时返回 None（跳过测试）
    async fn spawn_mcp_server() -> Option<McpTestServer> {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let fixtures = Path::new(manifest).join("tests/node");
        let script = Path::new(manifest).join("tests/fixtures/mcp-server.mjs");
        if !fixtures.join("node_modules/@modelcontextprotocol/sdk").exists() {
            eprintln!("skip: @modelcontextprotocol/sdk not installed in apps/runner/tests/node");
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
        Some(McpTestServer {
            child,
            url: format!("http://127.0.0.1:{port}/mcp"),
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
        let handle = tokio::spawn(run_mcp_session(
            McpSessionConfig::from_parts(url, config),
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

    async fn send_action(ctl: &mpsc::Sender<SessionCtl>, action: Value) {
        ctl.send(SessionCtl::Send {
            data: action.to_string(),
            encoding: "text".to_string(),
        })
        .await
        .unwrap();
    }

    /// 发动作帧：断言 out 回执先行，再返回 in 结果
    async fn roundtrip(ctl: &mpsc::Sender<SessionCtl>, rx: &mut mpsc::UnboundedReceiver<Value>, action: Value) -> Value {
        send_action(ctl, action).await;
        let out = next_event(rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        next_reply(rx).await
    }

    #[tokio::test]
    async fn mcp_streamable_http_full_flow() {
        let Some(server) = spawn_mcp_server().await else { return };
        let (ctl, mut ev_rx, _h) = start_session(server.url, None).await;

        // connecting → open → serverInfo
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "open", "unexpected event: {ev}");
        let info = next_reply(&mut ev_rx).await;
        assert_eq!(info["action"], "serverInfo");
        assert_eq!(info["result"]["server"]["name"], "test-mcp");
        assert!(info["result"]["capabilities"].is_object());

        // tools/list / tools/call
        let r = roundtrip(&ctl, &mut ev_rx, json!({"action": "tools/list"})).await;
        assert_eq!(r["action"], "tools/list");
        assert!(r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "echo"));
        let r = roundtrip(
            &ctl,
            &mut ev_rx,
            json!({"action": "tools/call", "name": "echo", "arguments": {"text": "hi"}}),
        )
        .await;
        assert_eq!(r["result"]["content"][0]["text"], "echo: hi");

        // resources/list / resources/read
        let r = roundtrip(&ctl, &mut ev_rx, json!({"action": "resources/list"})).await;
        assert!(r["result"]["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["uri"] == "memo://hello"));
        let r = roundtrip(
            &ctl,
            &mut ev_rx,
            json!({"action": "resources/read", "uri": "memo://hello"}),
        )
        .await;
        assert_eq!(r["result"]["contents"][0]["text"], "memo content");

        // prompts/list / prompts/get
        let r = roundtrip(&ctl, &mut ev_rx, json!({"action": "prompts/list"})).await;
        assert!(r["result"]["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "greet"));
        let r = roundtrip(
            &ctl,
            &mut ev_rx,
            json!({"action": "prompts/get", "name": "greet", "arguments": {"name": "world"}}),
        )
        .await;
        assert_eq!(
            r["result"]["messages"][0]["content"]["text"],
            "hello world"
        );

        // 未知动作 → error
        let r = roundtrip(&ctl, &mut ev_rx, json!({"action": "bogus"})).await;
        assert_eq!(r["action"], "error");
        assert!(r["error"].as_str().unwrap().contains("未知动作"));

        // 关闭 → status closed
        ctl.send(SessionCtl::Close).await.unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "closed");
    }

    #[tokio::test]
    async fn mcp_unreachable_reports_status_error() {
        let (_ctl, mut ev_rx, handle) =
            start_session("http://127.0.0.1:1/mcp".to_string(), None).await;
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "status");
        assert_eq!(ev["state"], "error");
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .unwrap()
            .unwrap();
    }
}

//! 实时通道（rt）runner 侧：保持到 api 的 downlink 长连接，按指令管理协议 session。
//!
//! - downlink：GET /api/v1/runner/rt/link，chunked NDJSON，每行一条 RtCommand；
//!   心跳为空行，读行时跳过。
//! - 上行：POST /api/v1/runner/rt/event，把 session 事件（ServerMessage 形状）回传 api。
//! - 断线后指数退避重连；api 侧在断链时已把名下 session 置为 error，重连后是全新会话。

mod graphql_subscription;
mod grpc;
mod mcp;
mod mqtt;
mod socketio;
mod sse;
mod websocket;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rp_core::runner_api::{RtCommand, RunnerApi};
use serde_json::Value;
use tokio::sync::mpsc;

use graphql_subscription::GqlSubSessionConfig;
use grpc::GrpcSessionConfig;
use mcp::McpSessionConfig;
use mqtt::MqttSessionConfig;
use socketio::SioSessionConfig;
use sse::SseSessionConfig;
use websocket::WsSessionConfig;

/// 断线重连退避：1s 起步翻倍，封顶 30s
const RECONNECT_MIN_SECS: u64 = 1;
const RECONNECT_MAX_SECS: u64 = 30;

/// 发给单个协议 session 任务的控制消息
pub enum SessionCtl {
    Send { data: String, encoding: String },
    Close,
}

/// 全部 session 事件的统一出口：(sessionId, 事件 JSON)。
/// serve 模式转发给 api（post_rt_event）；local-agent 模式推入本地 SSE 注册表。
pub type RtEventSink = mpsc::UnboundedSender<(String, Value)>;

/// 常驻 rt link 任务：断线自动退避重连，永不返回（随进程退出）
pub async fn rt_link_loop(client: Arc<RunnerApi>) {
    let mut backoff = RECONNECT_MIN_SECS;
    loop {
        match run_rt_link(&client).await {
            Ok(()) => logln!("rt link closed by server, reconnecting"),
            Err(e) => logln!("rt link failed: {e:#}"),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(RECONNECT_MAX_SECS);
    }
}

/// 维持一次 downlink 连接直到断开；连接存活期间的所有 session 由 manager 托管，
/// 断开时 manager 随栈销毁，各 session 任务的控制通道随之关闭而退出。
async fn run_rt_link(client: &Arc<RunnerApi>) -> anyhow::Result<()> {
    let resp = client.open_rt_link().await?;
    logln!("rt link established");
    let mut stream = resp.bytes_stream();
    // 事件出口：统一补 id 后逐条回传 api（顺序送达，避免并发上报乱序）
    let (sink, mut sink_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let uploader = tokio::spawn({
        let client = client.clone();
        async move {
            while let Some((id, event)) = sink_rx.recv().await {
                if let Err(e) = client.post_rt_event(&id, &event).await {
                    logln!("rt session {id}: failed to post event: {e:#}");
                }
            }
        }
    });
    let mut manager = RtSessionManager::new(sink);
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buf.extend_from_slice(&chunk);
        // 逐行切分（NDJSON）；行是完整 JSON，单行内不会出现 UTF-8 切半
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len().saturating_sub(1)];
            // 心跳空行直接跳过
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            match serde_json::from_slice::<RtCommand>(line) {
                Ok(cmd) => manager.handle(cmd),
                Err(e) => {
                    logln!(
                        "rt link: ignoring malformed command {}: {e}",
                        String::from_utf8_lossy(line)
                    );
                }
            }
        }
    }
    uploader.abort();
    Ok(())
}

/// 一组 rt session 的注册表：sessionId → 会话任务控制通道。
/// 事件去向由构造时注入的 sink 决定（serve 上传 api / local-agent 推本地 SSE）。
pub struct RtSessionManager {
    sink: RtEventSink,
    sessions: HashMap<String, mpsc::Sender<SessionCtl>>,
}

impl RtSessionManager {
    pub fn new(sink: RtEventSink) -> Self {
        Self {
            sink,
            sessions: HashMap::new(),
        }
    }

    pub fn handle(&mut self, cmd: RtCommand) {
        match cmd {
            RtCommand::Start {
                session_id,
                protocol,
                url,
                config,
            } => self.start(session_id, protocol, url, config),
            RtCommand::Send {
                session_id,
                data,
                encoding,
            } => {
                let ctl = SessionCtl::Send {
                    data,
                    encoding: encoding.unwrap_or_else(|| "text".to_string()),
                };
                self.forward(&session_id, ctl);
            }
            RtCommand::Close { session_id } => {
                // 移除注册项并通知会话任务关闭；任务退出时回传 closed
                if let Some(tx) = self.sessions.remove(&session_id) {
                    let _ = tx.try_send(SessionCtl::Close);
                }
            }
        }
    }

    fn forward(&self, session_id: &str, ctl: SessionCtl) {
        match self.sessions.get(session_id) {
            // try_send：通道满（对端消息洪峰）时丢弃并报错，避免阻塞 downlink 读循环
            Some(tx) => {
                if tx.try_send(ctl).is_err() {
                    logln!("rt session {session_id}: control channel congested, dropping command");
                }
            }
            None => logln!("rt session {session_id}: command for unknown session, ignored"),
        }
    }

    fn start(
        &mut self,
        session_id: String,
        protocol: String,
        url: String,
        config: Option<serde_json::Value>,
    ) {
        match protocol.as_str() {
            "websocket" => {
                let cfg = WsSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    websocket::run_ws_session(cfg, ctl_rx, ev_tx)
                });
            }
            "mqtt" => {
                let cfg = MqttSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    mqtt::run_mqtt_session(cfg, ctl_rx, ev_tx)
                });
            }
            "sse" => {
                let cfg = SseSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    sse::run_sse_session(cfg, ctl_rx, ev_tx)
                });
            }
            "graphql-subscription" => {
                let cfg = GqlSubSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    graphql_subscription::run_gql_sub_session(cfg, ctl_rx, ev_tx)
                });
            }
            "grpc" => {
                let cfg = GrpcSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    grpc::run_grpc_session(cfg, ctl_rx, ev_tx)
                });
            }
            "mcp" => {
                let cfg = McpSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    mcp::run_mcp_session(cfg, ctl_rx, ev_tx)
                });
            }
            "socketio" => {
                let cfg = SioSessionConfig::from_parts(url, config);
                self.launch(session_id, |ctl_rx, ev_tx| {
                    socketio::run_sio_session(cfg, ctl_rx, ev_tx)
                });
            }
            // 其余长连接协议的 runner 客户端尚未实现：明确报错，不静默挂起
            other => {
                let other = other.to_string();
                let sink = self.sink.clone();
                tokio::spawn(async move {
                    let event = serde_json::json!({
                        "t": "error",
                        "message": format!("protocol `{other}` is not supported by the runner yet"),
                    });
                    let _ = sink.send((session_id, event));
                });
            }
        }
    }

    /// 注册并启动一个协议 session：建控制通道与事件上行通道（统一补 id 后送入 sink），
    /// spawn 会话任务后放入注册表
    fn launch<F, Fut>(&mut self, session_id: String, make_session: F)
    where
        F: FnOnce(mpsc::Receiver<SessionCtl>, mpsc::UnboundedSender<Value>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (ctl_tx, ctl_rx) = mpsc::channel(64);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Value>();
        let sink = self.sink.clone();
        let id = session_id.clone();
        tokio::spawn(async move {
            while let Some(mut event) = ev_rx.recv().await {
                event["id"] = serde_json::json!(id);
                if sink.send((id.clone(), event)).is_err() {
                    // 出口已关闭（进程退出中）：停止转发
                    break;
                }
            }
        });
        tokio::spawn(make_session(ctl_rx, ev_tx));
        self.sessions.insert(session_id, ctl_tx);
    }
}

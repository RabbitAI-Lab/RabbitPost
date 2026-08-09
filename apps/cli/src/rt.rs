//! rt 子命令：经服务端实时桥（SSE 下行 + POST 上行）驱动 Runner 上的长连接协议会话。
//! 事件以 JSON Lines 输出到 stdout（机器可读），状态切换日志走 stderr。
//! 退出码：0 会话打开并正常结束；1 出现 error 事件；2 操作错误（建会话失败 / 未打开等）。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;
use tokio::sync::{watch, Mutex};

use crate::client::CliApi;
use crate::crud::read_data_arg;
use crate::output::print_json;

pub struct RtOptions {
    pub workspace: String,
    pub protocol: String,
    pub url: String,
    pub config: Option<String>,
    pub sends: Vec<String>,
    pub listen_secs: u64,
}

const RT_PROTOCOLS: [&str; 7] = [
    "websocket",
    "socketio",
    "mqtt",
    "mcp",
    "grpc",
    "sse",
    "graphql-subscription",
];

/// 会话状态（RtServerMessage 的 status.state 子集 + 初始态）
#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionState {
    Connecting,
    Open,
    Closed,
    Failed(String),
}

/// 持续读取 SSE 流：事件 JSON 逐行写 stdout，status 事件推进 watch 状态
async fn read_events(
    resp: reqwest::Response,
    state_tx: watch::Sender<SessionState>,
    saw_error: Arc<Mutex<bool>>,
    opened: Arc<AtomicBool>,
) {
    let mut buffer = String::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                // SSE 事件以 \n\n 分隔；逐行提取 data: 载荷（: ping 保活注释忽略）
                while let Some(pos) = buffer.find("\n\n") {
                    let frame = buffer[..pos].to_string();
                    buffer = buffer[pos + 2..].to_string();
                    for line in frame.lines() {
                        let Some(payload) = line.strip_prefix("data:") else {
                            continue;
                        };
                        let payload = payload.trim();
                        let Ok(event) = serde_json::from_str::<serde_json::Value>(payload) else {
                            continue;
                        };
                        handle_event(&event, &state_tx, &saw_error, &opened);
                        // JSON Lines 输出，供管道消费
                        println!("{payload}");
                    }
                }
            }
            Ok(None) => break, // 流结束（服务端关闭）
            Err(e) => {
                eprintln!("rt events stream error: {e}");
                let _ = state_tx.send(SessionState::Failed(format!("stream error: {e}")));
                break;
            }
        }
    }
}

fn handle_event(
    event: &serde_json::Value,
    state_tx: &watch::Sender<SessionState>,
    saw_error: &Arc<Mutex<bool>>,
    opened: &Arc<AtomicBool>,
) {
    match event.get("t").and_then(|t| t.as_str()) {
        Some("status") => {
            let state = event.get("state").and_then(|s| s.as_str()).unwrap_or_default();
            eprintln!(
                "rt status: {}{}",
                state,
                event
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            );
            let next = match state {
                "open" => {
                    opened.store(true, Ordering::SeqCst);
                    Some(SessionState::Open)
                }
                "closed" => Some(SessionState::Closed),
                "error" => Some(SessionState::Failed(
                    event
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .unwrap_or("error")
                        .to_string(),
                )),
                _ => None,
            };
            if let Some(next) = next {
                let _ = state_tx.send(next);
            }
        }
        Some("error") => {
            let message = event
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            eprintln!("rt error: {message}");
            // 事件回调里不能 await，用 try_lock 尽力标记
            if let Ok(mut flag) = saw_error.try_lock() {
                *flag = true;
            }
        }
        _ => {}
    }
}

/// 等待状态变成 open / closed / failed（带超时）；返回最终状态
async fn wait_open(
    rx: &mut watch::Receiver<SessionState>,
    secs: u64,
) -> SessionState {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        let current = rx.borrow().clone();
        match current {
            SessionState::Open | SessionState::Closed | SessionState::Failed(_) => return current,
            SessionState::Connecting => {}
        }
        if tokio::time::timeout_at(deadline, rx.changed()).await.is_err() {
            return SessionState::Failed("timeout waiting for session to open".to_string());
        }
    }
}

pub async fn rt_run(api: &CliApi, opts: RtOptions) -> anyhow::Result<u8> {
    if !RT_PROTOCOLS.contains(&opts.protocol.as_str()) {
        anyhow::bail!(
            "invalid --protocol `{}`: expect one of {}",
            opts.protocol,
            RT_PROTOCOLS.join(" / ")
        );
    }
    let config = opts.config.as_deref().map(read_data_arg).transpose()?;

    let session = api
        .rt_create_session(&json!({
            "workspaceId": opts.workspace,
            "protocol": opts.protocol,
            "url": opts.url,
            "config": config,
        }))
        .await?;
    let session_id = session
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("create session returned no sessionId"))?
        .to_string();
    eprintln!("rt session: {session_id} ({} {})", opts.protocol, opts.url);

    let resp = api.rt_events(&session_id).await?;
    let (state_tx, mut state_rx) = watch::channel(SessionState::Connecting);
    let saw_error = Arc::new(Mutex::new(false));
    let opened = Arc::new(AtomicBool::new(false));
    let reader = tokio::spawn(read_events(resp, state_tx, saw_error.clone(), opened.clone()));

    // 等待打开（固定 15s 上限；打开是发送的前置条件）
    let open_state = wait_open(&mut state_rx, 15).await;
    // 会话打开后迅速关闭（事件先于主循环到达）也视为已打开，照常发送
    let was_opened =
        matches!(open_state, SessionState::Open) || opened.load(Ordering::SeqCst);
    let exit_code = if was_opened {
        for message in &opts.sends {
            api.rt_send(&session_id, &json!({ "data": message, "encoding": "text" }))
                .await?;
            eprintln!("rt sent: {} char(s)", message.chars().count());
        }
        // 监听：直到 closed / failed 或 --listen 超时
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(opts.listen_secs);
        loop {
            let current = state_rx.borrow().clone();
            if !matches!(current, SessionState::Open | SessionState::Connecting) {
                break;
            }
            if tokio::time::timeout_at(deadline, state_rx.changed()).await.is_err() {
                break;
            }
        }
        if *saw_error.lock().await { 1 } else { 0 }
    } else {
        match open_state {
            SessionState::Closed => {
                eprintln!("rt session closed before open");
                2
            }
            SessionState::Failed(reason) => {
                eprintln!("rt session failed: {reason}");
                2
            }
            SessionState::Open => unreachable!(),
            SessionState::Connecting => unreachable!("wait_open never returns Connecting"),
        }
    };

    // 收尾：关闭会话并等待 reader 退出
    if let Ok(result) = api.rt_close(&session_id).await {
        eprintln!("rt session closed: {session_id}");
        let _ = result;
    }
    reader.abort();

    print_json(&json!({
        "sessionId": session_id,
        "protocol": opts.protocol,
        "url": opts.url,
        "sent": opts.sends.len(),
        "errors": *saw_error.lock().await,
    }));
    Ok(exit_code)
}

//! local-agent 端到端测试：驱动真实编译出的 rabbitpost-runner 二进制
//! （local-agent 子命令），验证健康检查、HTTP 执行（变量替换 / 脚本断言 /
//! Set-Cookie 解析）、CORS 白名单与 rt session 生命周期。
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::cargo::cargo_bin;
use futures_util::StreamExt;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 进程守卫：测试结束（含 panic）自动回收 agent 子进程
struct AgentGuard(Child);

impl Drop for AgentGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// 拉起 local-agent 并等待 /health 就绪，返回 base URL
async fn spawn_agent() -> (AgentGuard, String) {
    let port = free_port();
    let child = std::process::Command::new(cargo_bin("rabbitpost-runner"))
        .args(["local-agent", "--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn local-agent");
    let mut guard = AgentGuard(child);
    let base = format!("http://127.0.0.1:{port}");

    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = client.get(format!("{base}/health")).send().await {
            if resp.status().is_success() {
                break;
            }
        }
        if let Some(status) = guard.0.try_wait().unwrap() {
            panic!("agent exited early: {status}");
        }
        assert!(Instant::now() < deadline, "agent 未在时限内就绪");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (guard, base)
}

#[tokio::test]
async fn health_reports_local_agent_mode() {
    let (_guard, base) = spawn_agent().await;
    let body: Value = reqwest::get(format!("{base}/health"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["data"]["mode"], "local-agent");
}

#[tokio::test]
async fn execute_runs_request_and_parses_cookies() {
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .insert_header("set-cookie", "sid=abc; Path=/; HttpOnly"),
        )
        .mount(&target)
        .await;

    let (_guard, base) = spawn_agent().await;
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/v1/execute"))
        .json(&json!({
            "request": { "method": "GET", "url": format!("{}/ok", target.uri()) },
            "variables": {},
        }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], true);
    let data = &body["data"];
    assert_eq!(data["status"], 200);
    assert_eq!(data["bodyText"], "ok");
    assert_eq!(data["cookies"][0]["name"], "sid");
    assert_eq!(data["cookies"][0]["value"], "abc");
    assert_eq!(data["cookies"][0]["httpOnly"], true);
}

#[tokio::test]
async fn execute_substitutes_variables_and_runs_test_scripts() {
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": 1 })))
        .expect(1)
        .mount(&target)
        .await;

    let (_guard, base) = spawn_agent().await;
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/v1/execute"))
        .json(&json!({
            "request": {
                "method": "GET",
                "url": "{{host}}/hello",
                "scripts": {
                    "test": "pm.test('status is 200', () => { pm.response.to.have.status(200); });"
                }
            },
            "variables": { "host": target.uri() },
        }))
        .send()
        .await
        .unwrap();
    let body: Value = resp.json().await.unwrap();
    let data = &body["data"];
    assert_eq!(data["status"], 200);
    assert_eq!(data["testResults"][0]["name"], "status is 200");
    assert_eq!(data["testResults"][0]["passed"], true);
}

#[tokio::test]
async fn cors_whitelists_local_origins_only() {
    let (_guard, base) = spawn_agent().await;
    let client = reqwest::Client::new();

    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ] {
        let resp = client
            .get(format!("{base}/health"))
            .header("Origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .and_then(|v| v.to_str().ok()),
            Some(origin),
            "origin {origin} 应被放行"
        );
    }

    let resp = client
        .get(format!("{base}/health"))
        .header("Origin", "https://evil.example.com")
        .send()
        .await
        .unwrap();
    assert!(
        !resp.headers().contains_key("access-control-allow-origin"),
        "非白名单 origin 不应返回 CORS 头"
    );
}

#[tokio::test]
async fn rt_unknown_session_returns_404() {
    let (_guard, base) = spawn_agent().await;
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/v1/rt/sessions/nope/send"))
        .json(&json!({ "data": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], "NOT_FOUND");
}

#[tokio::test]
async fn rt_unsupported_protocol_emits_error_event_over_sse() {
    let (_guard, base) = spawn_agent().await;
    let client = reqwest::Client::new();

    let created: Value = client
        .post(format!("{base}/api/v1/rt/sessions"))
        .json(&json!({ "protocol": "telnet", "url": "telnet://example.com:23" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = created["data"]["sessionId"].as_str().unwrap().to_string();

    let resp = client
        .get(format!("{base}/api/v1/rt/sessions/{session_id}/events"))
        .send()
        .await
        .unwrap();
    assert!(
        resp.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("text/event-stream"),
        "events 端点应返回 SSE"
    );

    // 读取 SSE 流直到拿到「协议不支持」的错误事件
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !buf.contains("not supported") {
        assert!(Instant::now() < deadline, "未在时限内收到 error 事件: {buf}");
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("SSE 读超时")
            .expect("SSE 流提前结束")
            .unwrap();
        buf.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(buf.contains("telnet"), "错误事件应指明协议名: {buf}");

    // 关闭 session：正常清理，返回 200
    let resp = client
        .delete(format!("{base}/api/v1/rt/sessions/{session_id}"))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
}

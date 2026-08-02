//! 端到端 CLI 测试：用 wiremock 同时扮演「RabbitPost 服务端」与「目标接口」，
//! 驱动真实编译出的 rabbitpost-runner 二进制走完 run / serve 全流程，
//! 并锁定退出码（0 全成功 / 1 有失败请求 / 2 参数或鉴权错误）。
use std::time::{Duration, Instant};

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// ApiResponse 信封
fn envelope(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
}

fn err_envelope(status: u16, code: &str, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status)
        .set_body_json(json!({ "ok": false, "error": { "code": code, "message": message } }))
}

/// 一个指向 mock 目标接口的请求条目
fn item(name: &str, url: &str) -> Value {
    json!({
        "itemId": null,
        "name": name,
        "request": { "method": "GET", "url": url }
    })
}

/// 在 mock 上挂载目标接口：/ok 200、/nf 404、/redir 302 -> /ok
async fn mount_targets(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/nf"))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/redir"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/ok"))
        .mount(server)
        .await;
}

fn assignment(items: Vec<Value>, variables: Value) -> Value {
    json!({
        "jobId": "job-e2e",
        "workspaceId": "ws-e2e",
        "targetType": "collection",
        "targetName": "E2E Demo",
        "concurrency": 4,
        "variables": variables,
        "items": items,
    })
}

// ---------------------------------------------------------------------------
// run 子命令
// ---------------------------------------------------------------------------

#[tokio::test]
async fn run_subcommand_succeeds_and_exits_zero() {
    let server = MockServer::start().await;
    mount_targets(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .respond_with(envelope(assignment(
            vec![
                item("ok", &format!("{}/ok", server.uri())),
                item("redirect", &format!("{}/redir", server.uri())),
            ],
            json!({}),
        )))
        .expect(1)
        .mount(&server)
        .await;

    Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "run",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--collection",
            "col-1",
        ])
        .assert()
        .code(0)
        .stdout(predicate::str::contains("2 request(s)"))
        .stdout(predicate::str::contains("done: 2 succeeded, 0 failed"));
}

#[tokio::test]
async fn run_subcommand_exit_one_when_any_request_fails() {
    let server = MockServer::start().await;
    mount_targets(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .respond_with(envelope(assignment(
            vec![
                item("ok", &format!("{}/ok", server.uri())),
                item("nf", &format!("{}/nf", server.uri())),
            ],
            json!({}),
        )))
        .mount(&server)
        .await;

    Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "run",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--collection",
            "col-1",
        ])
        .assert()
        .code(1)
        .stdout(predicate::str::contains("FAIL 404 GET nf"))
        .stdout(predicate::str::contains("done: 1 succeeded, 1 failed"));
}

#[tokio::test]
async fn run_subcommand_runs_test_scripts_and_gates_on_assertions() {
    let server = MockServer::start().await;
    mount_targets(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .respond_with(envelope(assignment(
            vec![json!({
                "itemId": null,
                "name": "asserted",
                "request": {
                    "method": "GET",
                    "url": format!("{}/ok", server.uri()),
                    "scripts": {
                        "test": "rp.test(\"status is 201\", () => { rp.response.to.have.status(201); });"
                    }
                }
            })],
            json!({}),
        )))
        .mount(&server)
        .await;

    // 传输层 200 但断言期望 201：断言失败整体应失败
    Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "run",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--collection",
            "col-1",
        ])
        .assert()
        .code(1)
        .stdout(predicate::str::contains("FAIL"));
}

#[tokio::test]
async fn run_subcommand_exit_two_on_unauthorized() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .respond_with(err_envelope(401, "RUNNER_UNAUTHORIZED", "Invalid runner token"))
        .mount(&server)
        .await;

    Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "run",
            "--server",
            &server.uri(),
            "--token",
            "bad",
            "--collection",
            "col-1",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("RUNNER_UNAUTHORIZED"));
}

#[test]
fn run_subcommand_requires_a_target() {
    Command::new(cargo_bin("rabbitpost-runner"))
        .args(["run", "--server", "http://127.0.0.1:1", "--token", "t"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("required"));
}

#[tokio::test]
async fn run_subcommand_substitutes_environment_variables() {
    let server = MockServer::start().await;
    // 目标接口只对带变量替换后的路径与 query 放行
    Mock::given(method("GET"))
        .and(path("/v2/items"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .respond_with(envelope(assignment(
            vec![json!({
                "itemId": null,
                "name": "with-vars",
                "request": {
                    "method": "GET",
                    "url": "{{base}}/v{{version}}/items",
                    "params": [
                        {"key": "q", "value": "{{q}}", "enabled": true}
                    ]
                }
            })],
            json!({ "base": server.uri(), "version": "2", "q": "x" }),
        )))
        .mount(&server)
        .await;

    Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "run",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--collection",
            "col-1",
            "--env",
            "env-1",
        ])
        .assert()
        .code(0)
        .stdout(predicate::str::contains("PASS 200 GET with-vars"));
}

// ---------------------------------------------------------------------------
// serve 子命令：claim -> 并发执行 -> 分批上报 -> complete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn serve_claims_executes_reports_and_completes_job() {
    let server = MockServer::start().await;
    mount_targets(&server).await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/heartbeat"))
        .respond_with(envelope(json!({ "id": "runner-1" })))
        .mount(&server)
        .await;

    // 只挂 job 领取；检测到被领走后再动态挂空队列兜底，避免两个 mock 的匹配顺序问题
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/claim"))
        .respond_with(envelope(json!({
            "job": assignment(
                vec![
                    item("ok", &format!("{}/ok", server.uri())),
                    item("nf", &format!("{}/nf", server.uri())),
                    item("redirect", &format!("{}/redir", server.uri())),
                ],
                json!({}),
            )
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-e2e/results"))
        .respond_with(envelope(json!({ "accepted": 3 })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-e2e/complete"))
        .respond_with(envelope(json!({ "status": "failed" })))
        .mount(&server)
        .await;

    // 常驻进程：spawn 后轮询 mock 直到收到 complete 请求；日志直通测试输出便于 CI 排查
    let mut child = std::process::Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "serve",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--concurrency",
            "4",
            "--poll-interval",
            "1",
        ])
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("failed to spawn runner");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut reported: Vec<Value> = Vec::new();
    let mut completed: Option<Value> = None;
    let mut empty_queue_mounted = false;
    while Instant::now() < deadline {
        if let Some(requests) = server.received_requests().await {
            for req in &requests {
                let req_path = req.url.path();
                if req_path == "/api/v1/runner/jobs/claim" && !empty_queue_mounted {
                    // job 已被领走：挂空队列兜底，runner 转入轮询
                    empty_queue_mounted = true;
                    Mock::given(method("POST"))
                        .and(path("/api/v1/runner/jobs/claim"))
                        .respond_with(envelope(json!({ "job": null })))
                        .mount(&server)
                        .await;
                }
                if req_path == "/api/v1/runner/jobs/job-e2e/results" {
                    if let Ok(body) = serde_json::from_slice::<Value>(&req.body) {
                        if let Some(results) = body["results"].as_array() {
                            for r in results {
                                if !reported.iter().any(|seen| seen == r) {
                                    reported.push(r.clone());
                                }
                            }
                        }
                    }
                }
                if req_path == "/api/v1/runner/jobs/job-e2e/complete" {
                    completed = serde_json::from_slice::<Value>(&req.body).ok();
                }
            }
        }
        if completed.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill();
    let _ = child.wait();

    let completed = completed.expect("runner never completed the job within 30s");
    // 有 404 条目，整体应为 failed
    assert_eq!(completed["status"], "failed");

    // 三个请求的结果都分批上报过，状态码与成败符合预期
    assert_eq!(reported.len(), 3, "reported results: {reported:?}");
    let by_name = |name: &str| {
        reported
            .iter()
            .find(|r| r["name"] == name)
            .unwrap_or_else(|| panic!("missing result for {name}"))
    };
    assert_eq!(by_name("ok")["ok"], true);
    assert_eq!(by_name("ok")["status"], 200);
    assert_eq!(by_name("nf")["ok"], false);
    assert_eq!(by_name("nf")["status"], 404);
    assert_eq!(by_name("redirect")["ok"], true);
    assert_eq!(by_name("redirect")["status"], 200);
    assert!(by_name("ok")["durationMs"].is_number());
}

/// 用例执行项：claim 下发的 item 带 caseId 时，上报结果应原样透传
#[tokio::test]
async fn serve_reports_case_id_for_case_items() {
    let server = MockServer::start().await;
    mount_targets(&server).await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/heartbeat"))
        .respond_with(envelope(json!({ "id": "runner-1" })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/claim"))
        .respond_with(envelope(json!({
            "job": assignment(
                vec![
                    json!({
                        "itemId": "item-1",
                        "name": "Get User",
                        "request": { "method": "GET", "url": format!("{}/ok", server.uri()) }
                    }),
                    json!({
                        "itemId": "item-1",
                        "caseId": "case-1",
                        "name": "Get User / not found",
                        "request": { "method": "GET", "url": format!("{}/nf", server.uri()) }
                    }),
                ],
                json!({}),
            )
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-e2e/results"))
        .respond_with(envelope(json!({ "accepted": 2 })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-e2e/complete"))
        .respond_with(envelope(json!({ "status": "failed" })))
        .mount(&server)
        .await;

    let mut child = std::process::Command::new(cargo_bin("rabbitpost-runner"))
        .args([
            "serve",
            "--server",
            &server.uri(),
            "--token",
            "t",
            "--poll-interval",
            "1",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn runner");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut reported: Vec<Value> = Vec::new();
    let mut completed = false;
    let mut empty_queue_mounted = false;
    while Instant::now() < deadline && !completed {
        if let Some(requests) = server.received_requests().await {
            for req in &requests {
                let req_path = req.url.path();
                if req_path == "/api/v1/runner/jobs/claim" && !empty_queue_mounted {
                    empty_queue_mounted = true;
                    Mock::given(method("POST"))
                        .and(path("/api/v1/runner/jobs/claim"))
                        .respond_with(envelope(json!({ "job": null })))
                        .mount(&server)
                        .await;
                }
                if req_path == "/api/v1/runner/jobs/job-e2e/results" {
                    if let Ok(body) = serde_json::from_slice::<Value>(&req.body) {
                        if let Some(results) = body["results"].as_array() {
                            for r in results {
                                if !reported.iter().any(|seen| seen == r) {
                                    reported.push(r.clone());
                                }
                            }
                        }
                    }
                }
                if req_path == "/api/v1/runner/jobs/job-e2e/complete" {
                    completed = true;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill();
    let _ = child.wait();

    assert!(completed, "runner never completed the job within 30s");
    assert_eq!(reported.len(), 2, "reported results: {reported:?}");
    let by_name = |name: &str| {
        reported
            .iter()
            .find(|r| r["name"] == name)
            .unwrap_or_else(|| panic!("missing result for {name}"))
    };
    // 请求本身：无 caseId 字段；用例：caseId 透传
    assert!(by_name("Get User").get("caseId").is_none());
    assert_eq!(by_name("Get User / not found")["caseId"], "case-1");
    assert_eq!(by_name("Get User / not found")["itemId"], "item-1");
    assert_eq!(by_name("Get User / not found")["status"], 404);
}

#[tokio::test]
async fn serve_fails_fast_on_invalid_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/heartbeat"))
        .respond_with(err_envelope(401, "RUNNER_UNAUTHORIZED", "Invalid runner token"))
        .mount(&server)
        .await;

    Command::new(cargo_bin("rabbitpost-runner"))
        .args(["serve", "--server", &server.uri(), "--token", "bad"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("RUNNER_UNAUTHORIZED"));
}

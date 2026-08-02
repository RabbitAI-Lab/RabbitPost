//! rabbitpost CLI 功能测试：assert_cmd 运行真实二进制，wiremock 模拟 RabbitPost 服务端。
//! 每个用例独立起 mock server 并用临时 HOME 隔离 ~/.rabbitpost/config.json。
use std::path::PathBuf;
use std::process::Output;

use assert_cmd::Command;
use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const API_KEY: &str = "rpk_test-e2e";

fn envelope(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

fn error_envelope(status_code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": status_code, "message": message } })
}

struct Fixture {
    server: MockServer,
    home: TempDir,
}

impl Fixture {
    fn cmd(&self) -> Command {
        let mut cmd = Command::cargo_bin("rabbitpost").unwrap();
        cmd.env("HOME", self.home.path())
            .env("RABBITPOST_SERVER", self.server.uri())
            .env("RABBITPOST_API_KEY", API_KEY);
        cmd
    }
}

async fn start() -> Fixture {
    Fixture {
        server: MockServer::start().await,
        home: tempfile::tempdir().unwrap(),
    }
}

async fn mount_json(server: &MockServer, verb: &str, route: &str, body: Value) {
    // 每个测试专属 server，直接挂全局匹配即可
    Mock::given(method(verb))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn stdout_json(output: &Output) -> Value {
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("stdout is not JSON: {e}\n{text}"))
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn auth_status_prints_current_user() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/auth/me",
        envelope(json!({ "user": { "id": "u1", "name": "Tester", "email": null } })),
    )
    .await;

    let output = fx.cmd().args(["auth", "status"]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(stdout_json(&output)["user"]["name"], "Tester");
}

#[tokio::test]
async fn config_file_supplies_credentials_without_env() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/auth/me",
        envelope(json!({ "user": { "id": "u1", "name": "Tester" } })),
    )
    .await;

    // 手工写 ~/.rabbitpost/config.json（文档化的免参方式）
    let cfg_dir = fx.home.path().join(".rabbitpost");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        serde_json::to_string(&json!({
            "server": fx.server.uri(),
            "apiKey": API_KEY,
        }))
        .unwrap(),
    )
    .unwrap();

    // status：无任何环境变量，凭证必须来自配置文件
    let mut cmd = Command::cargo_bin("rabbitpost").unwrap();
    let output = cmd
        .env("HOME", fx.home.path())
        .env_remove("RABBITPOST_SERVER")
        .env_remove("RABBITPOST_API_KEY")
        .args(["auth", "status"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["user"]["name"], "Tester");

    // logout：删除配置文件，之后 status 因缺凭证失败（退出码 2）
    let mut cmd = Command::cargo_bin("rabbitpost").unwrap();
    let output = cmd
        .env("HOME", fx.home.path())
        .args(["auth", "logout"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!cfg_dir.join("config.json").exists());

    let mut cmd = Command::cargo_bin("rabbitpost").unwrap();
    let output = cmd
        .env("HOME", fx.home.path())
        .env_remove("RABBITPOST_SERVER")
        .env_remove("RABBITPOST_API_KEY")
        .args(["auth", "status"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}

#[tokio::test]
async fn invalid_key_exits_2_with_passthrough_error() {
    let fx = start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/teams"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(error_envelope("UNAUTHORIZED", "Not signed in")),
        )
        .mount(&fx.server)
        .await;

    let output = fx.cmd().args(["team", "list"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("UNAUTHORIZED"), "{stderr}");
    assert!(stderr.contains("Not signed in"), "{stderr}");
}

// ---------------------------------------------------------------------------
// 只读列表
// ---------------------------------------------------------------------------

#[tokio::test]
async fn team_list_supports_json_and_table() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/teams",
        envelope(json!([{ "id": "t1", "name": "Alpha", "slug": "alpha", "role": "owner" }])),
    )
    .await;

    let output = fx.cmd().args(["team", "list"]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(stdout_json(&output)[0]["name"], "Alpha");

    let output = fx.cmd().args(["team", "list", "--table"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("NAME") && stdout.contains("Alpha"), "{stdout}");
}

// ---------------------------------------------------------------------------
// CRUD 回环
// ---------------------------------------------------------------------------

async fn mount_collection_fixture(server: &MockServer) {
    mount_json(
        server,
        "POST",
        "/api/v1/collections/col-1/items",
        envelope(json!({ "id": "item-new", "collectionId": "col-1", "type": "request", "name": "n" })),
    )
    .await;
    mount_json(
        server,
        "GET",
        "/api/v1/items/item-new",
        envelope(json!({
            "id": "item-new",
            "collectionId": "col-1",
            "type": "request",
            "name": "n",
            "request": { "method": "POST", "url": "https://a/old", "params": [], "headers": [] }
        })),
    )
    .await;
    mount_json(
        server,
        "PATCH",
        "/api/v1/items/item-new",
        envelope(json!({ "id": "item-new", "name": "n", "updatedAt": "2026-01-01T00:00:00Z" })),
    )
    .await;
    mount_json(
        server,
        "DELETE",
        "/api/v1/items/item-new",
        envelope(json!({ "deleted": true, "count": 1 })),
    )
    .await;
}

#[tokio::test]
async fn request_create_update_delete_roundtrip() {
    let fx = start().await;
    mount_collection_fixture(&fx.server).await;

    // create：--method/--url 快速创建
    let output = fx
        .cmd()
        .args([
            "request", "create",
            "--collection", "col-1",
            "--name", "n",
            "--method", "POST",
            "--url", "https://a/old",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["id"], "item-new");

    // update --url：先取回配置、改完整体回写
    let output = fx
        .cmd()
        .args(["request", "update", "item-new", "--url", "https://a/new"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    // delete
    let output = fx.cmd().args(["request", "delete", "item-new"]).output().unwrap();
    assert!(output.status.success());
    assert_eq!(stdout_json(&output)["deleted"], true);

    // 校验 PATCH 体确实带着完整 request（method 保留、url 已替换）
    let requests = fx.server.received_requests().await.unwrap();
    let patch = requests
        .iter()
        .find(|r| r.method.as_str() == "PATCH" && r.url.path() == "/api/v1/items/item-new")
        .expect("PATCH should be sent");
    let body: Value = serde_json::from_slice(&patch.body).unwrap();
    assert_eq!(body["request"]["url"], "https://a/new");
    assert_eq!(body["request"]["method"], "POST");
}

#[tokio::test]
async fn env_update_merges_set_and_unset() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/environments/env-1",
        envelope(json!({
            "id": "env-1", "workspaceId": "ws-1", "name": "E",
            "variables": [
                { "id": "v1", "key": "host", "value": "https://old", "enabled": true },
                { "id": "v2", "key": "drop", "value": "x", "enabled": true }
            ]
        })),
    )
    .await;
    mount_json(
        &fx.server,
        "PATCH",
        "/api/v1/environments/env-1",
        envelope(json!({ "id": "env-1", "name": "E" })),
    )
    .await;

    let output = fx
        .cmd()
        .args([
            "env", "update", "env-1",
            "--set", "host=https://new",
            "--set", "region=cn",
            "--unset", "drop",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    let requests = fx.server.received_requests().await.unwrap();
    let patch = requests
        .iter()
        .find(|r| r.method.as_str() == "PATCH")
        .expect("PATCH should be sent");
    let body: Value = serde_json::from_slice(&patch.body).unwrap();
    let vars = body["variables"].as_array().unwrap();
    assert_eq!(vars.len(), 2, "drop 被移除、region 新增: {vars:?}");
    let host = vars.iter().find(|v| v["key"] == "host").unwrap();
    assert_eq!(host["value"], "https://new");
    assert_eq!(host["id"], "v1", "已有变量保留 id");
    let region = vars.iter().find(|v| v["key"] == "region").unwrap();
    assert_eq!(region["enabled"], true);
}

// ---------------------------------------------------------------------------
// run：执行 + 报告 + 上传
// ---------------------------------------------------------------------------

/// 挂一棵两个请求的 Collection 树：一个断言通过、一个断言失败；
/// 请求 URL 指回同一个 mock server 充当目标 API。
async fn mount_run_fixture(server: &MockServer) {
    mount_json(
        server,
        "GET",
        "/api/v1/collections/col-1",
        envelope(json!({ "id": "col-1", "workspaceId": "ws-1", "name": "Demo" })),
    )
    .await;
    mount_json(
        server,
        "GET",
        "/api/v1/environments/env-1",
        envelope(json!({ "id": "env-1", "workspaceId": "ws-1", "name": "E", "variables": [] })),
    )
    .await;
    // 「通过」接口带一个冒烟用例（拼接为「通过 / 冒烟」独立执行项）
    mount_json(
        server,
        "GET",
        "/api/v1/collections/col-1/cases",
        envelope(json!([
            {
                "id": "case-1", "itemId": "i-pass", "name": "冒烟", "sortOrder": 0,
                "request": {
                    "method": "GET",
                    "url": format!("{}/ok", server.uri()),
                    "scripts": { "test": "rp.test('case ok', () => { rp.response.to.have.status(200); });" }
                }
            }
        ])),
    )
    .await;
    mount_json(
        server,
        "GET",
        "/api/v1/collections/col-1/tree",
        envelope(json!([
            {
                "id": "f1", "collectionId": "col-1", "parentId": null,
                "type": "folder", "name": "子目录", "sortOrder": 0,
                "children": [
                    {
                        "id": "i-pass", "collectionId": "col-1", "parentId": "f1",
                        "type": "request", "name": "通过", "sortOrder": 0,
                        "request": {
                            "method": "GET",
                            "url": format!("{}/ok", server.uri()),
                            "scripts": { "test": "rp.test('200', () => { rp.response.to.have.status(200); });" }
                        }
                    },
                    {
                        "id": "i-fail", "collectionId": "col-1", "parentId": "f1",
                        "type": "request", "name": "失败", "sortOrder": 1,
                        "request": {
                            "method": "GET",
                            "url": format!("{}/also-ok", server.uri()),
                            "scripts": { "test": "rp.test('boom', () => { rp.expect(1).to.equal(2); });" }
                        }
                    }
                ]
            }
        ])),
    )
    .await;
}

async fn mount_target_apis(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/also-ok"))
        .respond_with(ResponseTemplate::new(200))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/collections/col-1/runs"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "job-1",
            "status": "failed"
        }))))
        .mount(server)
        .await;
}

#[tokio::test]
async fn run_collection_with_assertions_reports_uploads_and_exits_1() {
    let fx = start().await;
    mount_run_fixture(&fx.server).await;
    mount_target_apis(&fx.server).await;

    let report_dir = fx.home.path().join("reports");
    let output = fx
        .cmd()
        .args([
            "run",
            "--collection", "col-1",
            "--env", "env-1",
            "--report", "json,html,junit",
            "--report-dir", report_dir.to_str().unwrap(),
            "--upload",
        ])
        .output()
        .unwrap();

    // 有断言失败：退出码 1
    assert_eq!(output.status.code(), Some(1), "{output:?}");

    // stdout 汇总 JSON：2 过（请求+用例） 1 失败；上传返回 jobId
    let summary = stdout_json(&output);
    assert_eq!(summary["summary"]["total"], 3);
    assert_eq!(summary["summary"]["succeeded"], 2);
    assert_eq!(summary["summary"]["failed"], 1);
    assert_eq!(summary["summary"]["testsPassed"], 2);
    assert_eq!(summary["summary"]["testsFailed"], 1);
    assert_eq!(summary["target"]["name"], "Demo");
    assert_eq!(summary["upload"]["jobId"], "job-1");

    // 报告文件：JSON / HTML / JUnit 全部生成
    let files: Vec<String> = std::fs::read_dir(&report_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(files.iter().any(|f| f.ends_with(".json")), "{files:?}");
    assert!(files.iter().any(|f| f.ends_with(".html")), "{files:?}");
    let junit = files.iter().find(|f| f.ends_with(".xml")).expect("junit xml");
    let xml = std::fs::read_to_string(report_dir.join(junit)).unwrap();
    assert!(xml.contains("<testsuite name=\"Demo\" tests=\"3\" failures=\"1\""));
    assert!(xml.contains("子目录 / 失败"), "树路径前缀: {xml}");
    assert!(xml.contains("通过 / 冒烟"), "用例行: {xml}");

    // 上传体：JSON 报告格式标记 + 断言明细
    let requests = fx.server.received_requests().await.unwrap();
    let upload = requests
        .iter()
        .find(|r| r.url.path() == "/api/v1/collections/col-1/runs")
        .expect("report should be uploaded");
    let body: Value = serde_json::from_slice(&upload.body).unwrap();
    assert_eq!(body["format"], "rabbitpost.run-report");
    assert_eq!(body["collectionId"], "col-1");
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 3);
    let failed = results.iter().find(|r| r["ok"] == false).unwrap();
    assert_eq!(failed["testResults"][0]["passed"], false);
    assert!(failed["testResults"][0]["error"]
        .as_str()
        .unwrap_or("")
        .contains("AssertionError"));
    // 用例行回填了 caseId；普通请求不带 caseId 字段
    let case_row = results
        .iter()
        .find(|r| r["name"] == "子目录 / 通过 / 冒烟")
        .expect("case row");
    assert_eq!(case_row["caseId"], "case-1");
    let plain_row = results
        .iter()
        .find(|r| r["name"] == "子目录 / 通过")
        .expect("plain row");
    assert!(plain_row.get("caseId").is_none());
}

#[tokio::test]
async fn run_single_request_all_pass_exits_0() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/items/i-1",
        envelope(json!({
            "id": "i-1", "collectionId": "col-1", "type": "request", "name": "ping",
            "request": {
                "method": "GET",
                "url": format!("{}/ok", fx.server.uri()),
                "scripts": { "test": "rp.test('ok', () => { rp.response.to.have.status(200); });" }
            }
        })),
    )
    .await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/items/i-1/cases",
        envelope(json!([])),
    )
    .await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args(["run", "--request", "i-1", "--concurrency", "1"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let summary = stdout_json(&output);
    assert_eq!(summary["summary"]["failed"], 0);
    assert_eq!(summary["target"]["type"], "request");
}

#[tokio::test]
async fn report_upload_sends_existing_json_report() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/collections/col-9/runs"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "job-9", "status": "succeeded"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;

    let report_path: PathBuf = fx.home.path().join("report.json");
    std::fs::write(
        &report_path,
        serde_json::to_string(&json!({
            "format": "rabbitpost.run-report",
            "version": 1,
            "agent": "rabbitpost-cli/0.1.0 test",
            "collectionId": "col-9",
            "targetType": "collection",
            "targetId": "col-9",
            "targetName": "Demo",
            "environmentId": null,
            "environmentName": null,
            "concurrency": 1,
            "startedAt": "2026-01-01T00:00:00.000Z",
            "finishedAt": "2026-01-01T00:00:01.000Z",
            "summary": { "total": 1, "succeeded": 1, "failed": 0, "testsPassed": 0, "testsFailed": 0, "durationMs": 1000 },
            "results": [{
                "itemId": null, "name": "ping", "method": "GET", "url": "https://a",
                "ok": true, "status": 200, "statusText": "OK", "sizeBytes": 2, "durationMs": 1000, "error": null
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = fx
        .cmd()
        .args(["report", "upload", "--file", report_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["jobId"], "job-9");
}

#[tokio::test]
async fn report_upload_rejects_non_report_file() {
    let fx = start().await;
    let path = fx.home.path().join("not-a-report.json");
    std::fs::write(&path, "{}").unwrap();
    let output = fx
        .cmd()
        .args(["report", "upload", "--file", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a RabbitPost run report"));
}

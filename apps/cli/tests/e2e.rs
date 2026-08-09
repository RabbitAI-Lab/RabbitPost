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

// ---------------------------------------------------------------------------
// run --file：本地 Collection 文件（Postman 格式）+ 变量覆盖 / 迭代 / bail
// ---------------------------------------------------------------------------

/// 写一个 Postman v2.1 Collection 文件：pass（断言通过）与 fail（断言失败）两个请求
fn write_pm_collection(dir: &std::path::Path, server: &str) -> PathBuf {
    let path = dir.join("pm-collection.json");
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "info": { "name": "PmFile", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
            "variable": [{ "key": "host", "value": "http://127.0.0.1:1" }],
            "item": [
                {
                    "name": "组",
                    "item": [{
                        "name": "pass",
                        "request": {
                            "method": "GET",
                            "url": "{{host}}/ok",
                            "event": null
                        },
                        "event": [{ "listen": "test", "script": { "exec": ["pm.test('ok', () => { pm.response.to.have.status(200); });"] } }]
                    }]
                },
                {
                    "name": "fail",
                    "request": { "method": "GET", "url": "{{host}}/also-ok" },
                    "event": [{ "listen": "test", "script": { "exec": ["pm.test('boom', () => { pm.expect(1).to.equal(2); });"] } }]
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let _ = server;
    path
}

#[tokio::test]
async fn run_file_postman_collection_with_env_var_override() {
    let fx = start().await;
    mount_target_apis(&fx.server).await;
    let file = write_pm_collection(fx.home.path(), &fx.server.uri());

    // 集合变量 host 故意指向不可达地址；--env-var 覆盖后应全部请求可达
    let output = fx
        .cmd()
        .args([
            "run",
            "--file",
            file.to_str().unwrap(),
            "--env-var",
            &format!("host={}", fx.server.uri()),
        ])
        .output()
        .unwrap();

    // fail 请求断言失败 -> 退出码 1；host 被覆盖 -> 请求本身都成功发出
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let summary = stdout_json(&output);
    assert_eq!(summary["target"]["type"], "file");
    assert_eq!(summary["target"]["name"], "PmFile");
    assert_eq!(summary["summary"]["total"], 2);
    assert_eq!(summary["summary"]["succeeded"], 1);
    assert_eq!(summary["summary"]["failed"], 1);
    // 离线运行没有服务端 Collection，不上传
    assert!(summary["upload"].is_null());
}

#[tokio::test]
async fn run_file_iterations_and_suppress_exit_code() {
    let fx = start().await;
    mount_target_apis(&fx.server).await;
    let file = write_pm_collection(fx.home.path(), &fx.server.uri());

    let data = fx.home.path().join("data.csv");
    std::fs::write(&data, "round\n1\n2\n").unwrap();

    let output = fx
        .cmd()
        .args([
            "run",
            "--file",
            file.to_str().unwrap(),
            "--env-var",
            &format!("host={}", fx.server.uri()),
            "-d",
            data.to_str().unwrap(),
            "-x",
        ])
        .output()
        .unwrap();

    // -x：断言失败也返回 0；CSV 两行 -> 2 轮迭代 -> 2 请求 x 2 轮
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let summary = stdout_json(&output);
    assert_eq!(summary["iterations"], 2);
    assert_eq!(summary["summary"]["total"], 4);
    assert_eq!(summary["summary"]["failed"], 2);

    // JSON 报告里多轮迭代的结果名带 (iteration N)
    let report_dir = fx.home.path().join("it-reports");
    let output = fx
        .cmd()
        .args([
            "run",
            "--file",
            file.to_str().unwrap(),
            "--env-var",
            &format!("host={}", fx.server.uri()),
            "-n",
            "2",
            "-x",
            "--report",
            "json",
            "--report-dir",
            report_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let report_file = std::fs::read_dir(&report_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .find(|f| f.ends_with(".json"))
        .expect("json report");
    let report: Value =
        serde_json::from_str(&std::fs::read_to_string(report_dir.join(report_file)).unwrap())
            .unwrap();
    let names: Vec<&str> = report["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert!(names.iter().any(|n| n.ends_with("(iteration 1)")), "{names:?}");
    assert!(names.iter().any(|n| n.ends_with("(iteration 2)")), "{names:?}");
    assert!(names.iter().any(|n| n.starts_with("组 / pass")), "{names:?}");
}

#[tokio::test]
async fn run_file_bail_stops_after_first_failure() {
    let fx = start().await;
    mount_target_apis(&fx.server).await;
    // 把 fail 放前面：bail 后 pass 不再执行
    let path = fx.home.path().join("pm-bail.json");
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "info": { "name": "Bail" },
            "item": [
                {
                    "name": "fail",
                    "request": { "method": "GET", "url": format!("{}/also-ok", fx.server.uri()) },
                    "event": [{ "listen": "test", "script": { "exec": ["pm.test('boom', () => { pm.expect(1).to.equal(2); });"] } }]
                },
                { "name": "pass", "request": { "method": "GET", "url": format!("{}/ok", fx.server.uri()) } }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = fx
        .cmd()
        .args(["run", "--file", path.to_str().unwrap(), "--bail"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let summary = stdout_json(&output);
    // 首个失败即停：只执行了 1 个
    assert_eq!(summary["summary"]["total"], 1);
    assert_eq!(summary["summary"]["failed"], 1);
    assert!(String::from_utf8_lossy(&output.stderr).contains("bail: stopped"));
}

#[tokio::test]
async fn run_collection_folder_filter() {
    let fx = start().await;
    mount_run_fixture(&fx.server).await;
    mount_target_apis(&fx.server).await;

    // 文件夹名匹配：子目录下 1 请求 + 1 用例 + 1 失败请求 = 3 项
    let output = fx
        .cmd()
        .args(["run", "--collection", "col-1", "--folder", "子目录"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert_eq!(stdout_json(&output)["summary"]["total"], 3);

    // 不存在的文件夹：没有可执行项 -> 操作错误
    let output = fx
        .cmd()
        .args(["run", "--collection", "col-1", "--folder", "不存在"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("has no request to run"));
}

// ---------------------------------------------------------------------------
// collection export / import
// ---------------------------------------------------------------------------

#[tokio::test]
async fn collection_export_produces_exchange_file() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/collections/col-1",
        envelope(json!({
            "id": "col-1", "workspaceId": "ws-1", "name": "Demo", "description": "d",
            "variables": [{ "key": "host", "value": "https://api", "enabled": true }]
        })),
    )
    .await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/collections/col-1/tree",
        envelope(json!([{
            "id": "f1", "collectionId": "col-1", "parentId": null,
            "type": "folder", "name": "组", "sortOrder": 0,
            "children": [{
                "id": "i1", "collectionId": "col-1", "parentId": "f1",
                "type": "request", "name": "r", "sortOrder": 0,
                "request": { "method": "GET", "url": "{{host}}/x" }
            }]
        }])),
    )
    .await;

    let out = fx.home.path().join("export.json");
    let output = fx
        .cmd()
        .args(["collection", "export", "col-1", "--file", out.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    let file: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(file["format"], "rabbitpost.collection");
    assert_eq!(file["name"], "Demo");
    assert_eq!(file["variables"][0]["key"], "host");
    assert_eq!(file["items"][0]["type"], "folder");
    assert_eq!(file["items"][0]["items"][0]["request"]["url"], "{{host}}/x");
}

#[tokio::test]
async fn collection_import_creates_tree_from_postman_file() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/workspaces/ws-1/collections"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({
            "id": "col-new", "name": "Pm"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/collections/col-new/items"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({ "id": "item-1" }))))
        .expect(2) // 1 文件夹 + 1 请求
        .mount(&fx.server)
        .await;

    let file = fx.home.path().join("pm.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "info": { "name": "Pm" },
            "item": [{ "name": "组", "item": [{ "name": "r", "request": { "method": "GET", "url": "https://a/x" } }] }]
        }))
        .unwrap(),
    )
    .unwrap();

    let output = fx
        .cmd()
        .args([
            "collection",
            "import",
            "--workspace",
            "ws-1",
            "--file",
            file.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let out = stdout_json(&output);
    assert_eq!(out["collectionId"], "col-new");
    assert_eq!(out["requests"], 1);

    // 请求条目创建时携带了转换后的 RequestConfig
    let requests = fx.server.received_requests().await.unwrap();
    let item_creates: Vec<Value> = requests
        .iter()
        .filter(|r| r.url.path() == "/api/v1/collections/col-new/items")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    let request_create = item_creates
        .iter()
        .find(|b| b["type"] == "request")
        .expect("request item");
    assert_eq!(request_create["request"]["url"], "https://a/x");
}

// ---------------------------------------------------------------------------
// runs / history
// ---------------------------------------------------------------------------

#[tokio::test]
async fn runs_list_get_and_report_download() {
    let fx = start().await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/collections/col-1/runs",
        envelope(json!([{ "id": "job-1", "status": "succeeded", "targetName": "Demo" }])),
    )
    .await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/runs/job-1",
        envelope(json!({ "job": { "id": "job-1" }, "results": [] })),
    )
    .await;
    // 报告端点返回原始 HTML（非 JSON 信封）
    Mock::given(method("GET"))
        .and(path("/api/v1/runs/job-1/report"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>report</html>"))
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args(["runs", "list", "--collection", "col-1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)[0]["id"], "job-1");

    let output = fx.cmd().args(["runs", "get", "job-1"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["job"]["id"], "job-1");

    let out = fx.home.path().join("r.html");
    let output = fx
        .cmd()
        .args(["runs", "report", "job-1", "--format", "html", "--file", out.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "<html>report</html>");
}

#[tokio::test]
async fn history_list_and_clear() {
    let fx = start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/workspaces/ws-1/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!([{
            "id": "h1", "name": "ping", "request": { "method": "GET" }, "createdAt": "2026-01-01T00:00:00Z"
        }]))))
        .mount(&fx.server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/workspaces/ws-1/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({ "cleared": true }))))
        .expect(1)
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args(["history", "list", "--workspace", "ws-1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)[0]["name"], "ping");

    let output = fx
        .cmd()
        .args(["history", "clear", "--workspace", "ws-1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["cleared"], true);
}

// ---------------------------------------------------------------------------
// run：globals / 脚本变量回传导出 / Cookie Jar
// ---------------------------------------------------------------------------

#[tokio::test]
async fn run_file_globals_threading_and_exports() {
    let fx = start().await;
    mount_target_apis(&fx.server).await;

    // globals 文件提供 ghost（供 {{ghost}} 替换）
    let globals = fx.home.path().join("globals.json");
    std::fs::write(
        &globals,
        serde_json::to_string(&json!({
            "values": [{ "key": "ghost", "value": fx.server.uri(), "enabled": true }],
            "_postman_variable_scope": "globals"
        }))
        .unwrap(),
    )
    .unwrap();

    // 第一个请求写环境变量与 globals；第二个请求读取（验证跨请求传递）
    let collection = fx.home.path().join("pm-globals.json");
    std::fs::write(
        &collection,
        serde_json::to_string(&json!({
            "info": { "name": "G" },
            "item": [
                {
                    "name": "set",
                    "request": { "method": "GET", "url": "{{ghost}}/ok" },
                    "event": [{ "listen": "test", "script": { "exec": [
                        "pm.environment.set('token', 't1');",
                        "pm.globals.set('g1', 'x');",
                        "pm.test('ok', () => { pm.response.to.have.status(200); });"
                    ] } }]
                },
                {
                    "name": "check",
                    "request": { "method": "GET", "url": "{{ghost}}/also-ok" },
                    "event": [{ "listen": "test", "script": { "exec": [
                        "pm.test('threaded', () => {",
                        "  pm.expect(pm.environment.get('token')).to.equal('t1');",
                        "  pm.expect(pm.globals.get('g1')).to.equal('x');",
                        "});"
                    ] } }]
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let env_out = fx.home.path().join("env-out.json");
    let globals_out = fx.home.path().join("globals-out.json");
    let output = fx
        .cmd()
        .args([
            "run",
            "--file", collection.to_str().unwrap(),
            "--globals", globals.to_str().unwrap(),
            "--concurrency", "1", // 顺序执行保证脚本改动确定传递
            "--export-environment", env_out.to_str().unwrap(),
            "--export-globals", globals_out.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");

    // 环境导出：含脚本写入的 token；不含 globals 键（ghost）
    let env: Value =
        serde_json::from_str(&std::fs::read_to_string(&env_out).unwrap()).unwrap();
    let env_keys: Vec<&str> = env["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["key"].as_str().unwrap())
        .collect();
    assert!(env_keys.contains(&"token"), "{env_keys:?}");
    assert!(!env_keys.contains(&"ghost"), "{env_keys:?}");

    // globals 导出：含初始 ghost 与脚本写入的 g1
    let globals: Value =
        serde_json::from_str(&std::fs::read_to_string(&globals_out).unwrap()).unwrap();
    let entries: Vec<(&str, &str)> = globals["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v["key"].as_str().unwrap(), v["value"].as_str().unwrap()))
        .collect();
    assert!(entries.contains(&("ghost", fx.server.uri().as_str())), "{entries:?}");
    assert!(entries.contains(&("g1", "x")), "{entries:?}");
}

#[tokio::test]
async fn run_file_cookie_jar_roundtrip() {
    let fx = start().await;
    // /login 种下 cookie；/me 校验 Cookie 头
    Mock::given(method("GET"))
        .and(path("/login"))
        .respond_with(
            ResponseTemplate::new(200).insert_header("set-cookie", "sid=abc; Path=/"),
        )
        .mount(&fx.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me"))
        .and(wiremock::matchers::header("cookie", "sid=abc"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&fx.server)
        .await;

    let collection = fx.home.path().join("pm-cookie.json");
    std::fs::write(
        &collection,
        serde_json::to_string(&json!({
            "info": { "name": "C" },
            "item": [
                { "name": "login", "request": { "method": "GET", "url": format!("{}/login", fx.server.uri()) } },
                {
                    "name": "me",
                    "request": { "method": "GET", "url": format!("{}/me", fx.server.uri()) },
                    "event": [{ "listen": "test", "script": { "exec": [
                        "pm.test('cookie sent', () => { pm.response.to.have.status(200); });"
                    ] } }]
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let jar_out = fx.home.path().join("jar.json");
    let output = fx
        .cmd()
        .args([
            "run",
            "--file", collection.to_str().unwrap(),
            "--concurrency", "1",
            "--export-cookie-jar", jar_out.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    // /me 没有匹配到 Cookie 头时 wiremock 返回 404 -> 断言失败 -> 退出码 1
    assert_eq!(output.status.code(), Some(0), "{output:?}");

    let jar: Value = serde_json::from_str(&std::fs::read_to_string(&jar_out).unwrap()).unwrap();
    let cookies = jar.as_array().unwrap();
    assert_eq!(cookies.len(), 1);
    assert_eq!(cookies[0]["name"], "sid");
    assert_eq!(cookies[0]["value"], "abc");
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn collection_lint_file_exit_codes() {
    let fx = start().await;
    // 有 error（无配置请求）-> 退出码 1
    let bad = fx.home.path().join("bad.json");
    std::fs::write(
        &bad,
        serde_json::to_string(&json!({
            "format": "rabbitpost.collection",
            "name": "Bad",
            "items": [{ "type": "request", "name": "r" }]
        }))
        .unwrap(),
    )
    .unwrap();
    let output = fx
        .cmd()
        .args(["collection", "lint", "--file", bad.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let out = stdout_json(&output);
    assert!(out["summary"]["errors"].as_u64().unwrap() >= 1);

    // 干净 collection -> 退出码 0（warning 不影响）
    let good = fx.home.path().join("good.json");
    std::fs::write(
        &good,
        serde_json::to_string(&json!({
            "format": "rabbitpost.collection",
            "name": "Good",
            "items": [{ "type": "request", "name": "r", "request": {
                "method": "GET", "url": "https://a/x",
                "scripts": { "test": "rp.test('ok', () => {});" }
            } }]
        }))
        .unwrap(),
    )
    .unwrap();
    let output = fx
        .cmd()
        .args(["collection", "lint", "--file", good.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(stdout_json(&output)["summary"]["errors"], 0);
}

#[tokio::test]
async fn spec_lint_file_and_server_spec() {
    let fx = start().await;
    // 本地文件：缺 paths -> error -> 退出码 1
    let spec = fx.home.path().join("spec.yaml");
    std::fs::write(&spec, "openapi: 3.0.3\ninfo: {title: t, version: v}\n").unwrap();
    let output = fx
        .cmd()
        .args(["spec", "lint", "--file", spec.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let body = stdout_json(&output);
    let rules: Vec<&str> = body["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["rule"].as_str().unwrap())
        .collect();
    assert!(rules.contains(&"oas3-schema"), "{rules:?}");

    // 服务端 spec：类型与正文取自接口
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/specs/spec-1",
        envelope(json!({
            "id": "spec-1", "name": "Demo", "type": "openapi-3.0",
            "content": "openapi: 3.0.3\ninfo: {title: t, version: v, description: d, contact: {name: s}}\nservers: [{url: https://a}]\ntags: [{name: t, description: d}]\npaths:\n  /x:\n    get:\n      operationId: getX\n      summary: s\n      tags: [t]\n      responses:\n        \"200\": {description: ok}\n"
        })),
    )
    .await;
    let output = fx.cmd().args(["spec", "lint", "spec-1"]).output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(stdout_json(&output)["summary"]["errors"], 0);
}

// ---------------------------------------------------------------------------
// team / workspace 写操作、成员管理
// ---------------------------------------------------------------------------

#[tokio::test]
async fn team_and_workspace_write_operations() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/teams"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "t1", "name": "团队", "slug": "t1", "role": "owner"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/teams/t1/members"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "added": true, "userId": "u9"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/teams/t1/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({ "removed": true }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/workspaces"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "w1", "teamId": "t1", "name": "WS"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args(["team", "create", "--name", "团队"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["id"], "t1");

    let output = fx
        .cmd()
        .args(["team", "member-add", "t1", "--email", "a@b.c", "--role", "viewer"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    // 移除成员：DELETE 带 body（userId）
    let output = fx
        .cmd()
        .args(["team", "member-remove", "t1", "--user", "u9"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let requests = fx.server.received_requests().await.unwrap();
    let remove = requests
        .iter()
        .find(|r| r.url.path() == "/api/v1/teams/t1/members" && r.method.as_str() == "DELETE")
        .expect("member remove request");
    let body: Value = serde_json::from_slice(&remove.body).unwrap();
    assert_eq!(body["userId"], "u9");

    let output = fx
        .cmd()
        .args(["workspace", "create", "--team", "t1", "--name", "WS"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["id"], "w1");
}

// ---------------------------------------------------------------------------
// runner / doc / spec / scenario
// ---------------------------------------------------------------------------

#[tokio::test]
async fn runner_create_and_rotate_token() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/teams/t1/runners"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "runner": { "id": "r1", "name": "ci" }, "token": "rpr_secret-once"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runners/r1/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({
            "runner": { "id": "r1" }, "token": "rpr_new"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args(["runner", "create", "--team", "t1", "--name", "ci"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["token"], "rpr_secret-once");

    let output = fx
        .cmd()
        .args(["runner", "rotate-token", "r1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["token"], "rpr_new");
}

#[tokio::test]
async fn doc_spec_scenario_commands() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/workspaces/w1/documents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "d1", "name": "说明", "type": "document"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/workspaces/w1/specs"))
        .respond_with(ResponseTemplate::new(201).set_body_json(envelope(json!({
            "id": "s1", "name": "API", "type": "openapi-3.0"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    mount_json(
        &fx.server,
        "GET",
        "/api/v1/scenarios/sc1/steps",
        envelope(json!([{ "id": "st1", "name": "步骤1", "diffStatus": "synced" }])),
    )
    .await;

    let output = fx
        .cmd()
        .args(["doc", "create", "--workspace", "w1", "--name", "说明", "--content", "正文"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["id"], "d1");

    let output = fx
        .cmd()
        .args(["spec", "create", "--workspace", "w1", "--name", "API", "--type", "openapi-3.0"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)["id"], "s1");

    let output = fx.cmd().args(["scenario", "steps", "sc1"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(stdout_json(&output)[0]["diffStatus"], "synced");
}

// ---------------------------------------------------------------------------
// rt 长连接会话
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rt_run_streams_events_and_sends_messages() {
    let fx = start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/rt/sessions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({
            "sessionId": "sess-1"
        }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    // SSE 流：open -> echo message -> closed
    let sse = concat!(
        "data: {\"t\":\"status\",\"id\":\"sess-1\",\"state\":\"open\"}\n\n",
        ": ping\n\n",
        "data: {\"t\":\"message\",\"id\":\"sess-1\",\"dir\":\"in\",\"data\":\"hello\",\"encoding\":\"text\",\"ts\":1}\n\n",
        "data: {\"t\":\"status\",\"id\":\"sess-1\",\"state\":\"closed\",\"code\":1000}\n\n"
    );
    Mock::given(method("GET"))
        .and(path("/api/v1/rt/sessions/sess-1/events"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse),
        )
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/rt/sessions/sess-1/send"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({ "sent": true }))))
        .expect(1)
        .mount(&fx.server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/rt/sessions/sess-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({ "closed": true }))))
        .expect(1)
        .mount(&fx.server)
        .await;

    let output = fx
        .cmd()
        .args([
            "rt",
            "--workspace", "w1",
            "--protocol", "websocket",
            "--url", "ws://localhost:9999/ws",
            "--send", "ping",
            "--listen", "10",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");

    // stdout：事件 JSON Lines + 末尾汇总 JSON
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("\"t\":\"message\""), "{text}");
    assert!(text.contains("\"sessionId\": \"sess-1\""), "{text}");
}

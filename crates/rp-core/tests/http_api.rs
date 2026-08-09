//! HttpClient 信封解析与 RunnerApi 契约的集成测试（wiremock 模拟服务端）。
use rp_core::http::HttpClient;
use rp_core::model::JobResult;
use rp_core::runner_api::RunnerApi;
use serde_json::json;
use wiremock::matchers::{bearer_token, body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn envelope(data: serde_json::Value) -> serde_json::Value {
    json!({ "ok": true, "data": data })
}

#[tokio::test]
async fn get_unwraps_data_envelope() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/teams"))
        .and(bearer_token("tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!([{"id": "t1"}]))))
        .mount(&server)
        .await;

    let client = HttpClient::new(&server.uri(), "tok", "test-agent").unwrap();
    let data: serde_json::Value = client.get("/api/v1/teams").await.unwrap();
    assert_eq!(data[0]["id"], "t1");
}

#[tokio::test]
async fn error_envelope_is_passthrough() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/items/nope"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "ok": false,
            "error": { "code": "NOT_FOUND", "message": "Collection item not found" }
        })))
        .mount(&server)
        .await;

    let client = HttpClient::new(&server.uri(), "tok", "test-agent").unwrap();
    let err = client
        .get::<serde_json::Value>("/api/v1/items/nope")
        .await
        .unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("404"), "status in message: {msg}");
    assert!(msg.contains("NOT_FOUND"), "code passthrough: {msg}");
    assert!(msg.contains("Collection item not found"), "message passthrough: {msg}");
}

#[tokio::test]
async fn non_json_response_reports_raw_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/teams"))
        .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
        .mount(&server)
        .await;

    let client = HttpClient::new(&server.uri(), "tok", "test-agent").unwrap();
    let err = client
        .get::<serde_json::Value>("/api/v1/teams")
        .await
        .unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("non-JSON"), "{msg}");
    assert!(msg.contains("bad gateway"), "{msg}");
}

#[tokio::test]
async fn post_patch_delete_carry_bearer_and_json_body() {
    let server = MockServer::start().await;
    for (verb, route) in [
        ("POST", "/api/v1/post"),
        ("PATCH", "/api/v1/patch"),
        ("DELETE", "/api/v1/delete"),
    ] {
        let template = ResponseTemplate::new(200).set_body_json(envelope(json!({"verb": verb})));
        let mock = Mock::given(method(verb))
            .and(path(route))
            .and(bearer_token("tok"))
            .respond_with(template);
        mock.mount(&server).await;
    }

    let client = HttpClient::new(&server.uri(), "tok", "test-agent").unwrap();
    let posted: serde_json::Value = client.post("/api/v1/post", &json!({"a": 1})).await.unwrap();
    assert_eq!(posted["verb"], "POST");
    let patched: serde_json::Value = client.patch("/api/v1/patch", &json!({"b": 2})).await.unwrap();
    assert_eq!(patched["verb"], "PATCH");
    let deleted: serde_json::Value = client.delete("/api/v1/delete").await.unwrap();
    assert_eq!(deleted["verb"], "DELETE");
}

// ---------------------------------------------------------------------------
// RunnerApi 契约
// ---------------------------------------------------------------------------

fn sample_result() -> JobResult {
    JobResult {
        item_id: Some("item-1".to_string()),
        case_id: None,
        name: "用例1".to_string(),
        method: "GET".to_string(),
        url: "https://example.com".to_string(),
        ok: true,
        status: Some(200),
        status_text: Some("OK".to_string()),
        size_bytes: Some(12),
        duration_ms: Some(34),
        error: None,
        test_results: Some(vec![rp_core::model::TestResult {
            name: "status is 200".to_string(),
            passed: true,
            error: None,
        }]),
        console_logs: None,
        script_variables: None,
        script_globals: None,
        response_headers: None,
        response_body: None,
    }
}

#[tokio::test]
async fn runner_heartbeat_claim_report_complete_flow() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/heartbeat"))
        .and(bearer_token("rpr_test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({}))))
        .expect(1)
        .mount(&server)
        .await;

    // 空队列返回 { job: null }
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/claim"))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({"job": null}))))
        .mount(&server)
        .await;

    // 结果上报：服务端校验 results 数组里带有断言结果
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-1/results"))
        .and(body_json(json!({
            "results": [{
                "itemId": "item-1",
                "name": "用例1",
                "method": "GET",
                "url": "https://example.com",
                "ok": true,
                "status": 200,
                "statusText": "OK",
                "sizeBytes": 12,
                "durationMs": 34,
                "error": null,
                "testResults": [{ "name": "status is 200", "passed": true }]
            }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({"accepted": 1}))))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/v1/runner/jobs/job-1/complete"))
        .and(body_json(json!({ "status": "succeeded", "error": null })))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({"status": "succeeded"}))))
        .expect(1)
        .mount(&server)
        .await;

    let api = RunnerApi::new(&server.uri(), "rpr_test", "0.1.0").unwrap();
    api.heartbeat("0.1.0").await.unwrap();
    assert!(api.claim().await.unwrap().is_none());
    api.report("job-1", &[sample_result()]).await.unwrap();
    api.complete("job-1", true, None).await.unwrap();
}

#[tokio::test]
async fn runner_expand_returns_assignment() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/runner/expand"))
        .and(body_json(json!({
            "targetType": "collection",
            "targetId": "col-1",
            "environmentId": "env-1",
            "concurrency": 4
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(envelope(json!({
            "jobId": "",
            "workspaceId": "ws-1",
            "targetType": "collection",
            "targetName": "Demo",
            "concurrency": 4,
            "variables": { "host": "https://example.com" },
            "items": [{
                "itemId": "item-1",
                "name": "GET 用户",
                "request": { "method": "GET", "url": "{{host}}/users/1" }
            }]
        }))))
        .mount(&server)
        .await;

    let api = RunnerApi::new(&server.uri(), "rpr_test", "0.1.0").unwrap();
    let job = api
        .expand("collection", "col-1", Some("env-1".to_string()), 4)
        .await
        .unwrap();
    assert_eq!(job.target_name, "Demo");
    assert_eq!(job.items.len(), 1);
    assert_eq!(job.variables.get("host").map(String::as_str), Some("https://example.com"));
    assert_eq!(job.items[0].request.method, "GET");
    // 服务端新增字段（workspaceId）被宽容忽略
}

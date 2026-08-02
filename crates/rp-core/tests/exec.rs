//! 执行引擎（exec + script 协同）的集成测试：wiremock 同时扮演目标 HTTP 服务。
use std::collections::HashMap;

use rp_core::exec::{execute, ClientPool};
use rp_core::model::RequestConfig;
use serde_json::json;
use wiremock::matchers::{body_string, header, header_regex, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cfg(value: serde_json::Value) -> RequestConfig {
    serde_json::from_value(value).unwrap()
}

fn no_vars() -> HashMap<String, String> {
    HashMap::new()
}

#[tokio::test]
async fn get_success_captures_metrics() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_string("world"))
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "GET /hello",
        Some("item-1".to_string()),
        &cfg(json!({ "method": "GET", "url": format!("{}/hello", server.uri()) })),
        &no_vars(),
    )
    .await;

    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.status, Some(200));
    assert_eq!(result.size_bytes, Some(5));
    assert!(result.duration_ms.is_some());
    assert!(result.error.is_none());
    assert!(result.test_results.is_none(), "无脚本时不上报断言");
}

#[tokio::test]
async fn variables_are_substituted_in_url_headers_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/echo"))
        .and(header("x-token", "abc123"))
        .and(body_string("{\"id\":42}"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let vars = HashMap::from([
        ("host".to_string(), server.uri()),
        ("token".to_string(), "abc123".to_string()),
        ("id".to_string(), "42".to_string()),
    ]);
    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "substitute",
        None,
        &cfg(json!({
            "method": "POST",
            "url": "{{host}}/v1/echo",
            "headers": [{ "key": "x-token", "value": "{{token}}", "enabled": true }],
            "body": { "type": "raw", "raw": "{\"id\":{{id}}}", "rawLanguage": "json" }
        })),
        &vars,
    )
    .await;
    assert!(result.ok, "{:?}", result.error);
}

#[tokio::test]
async fn basic_bearer_and_api_key_auth_are_applied() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/basic"))
        .and(header("authorization", "Basic dTpw"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/bearer"))
        .and(header("authorization", "Bearer tk"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/apikey"))
        .and(query_param("key", "v"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    for (route, auth) in [
        ("/basic", json!({ "type": "basic", "basic": { "username": "u", "password": "p" } })),
        ("/bearer", json!({ "type": "bearer", "bearer": { "token": "tk" } })),
        ("/apikey", json!({ "type": "api-key", "apiKey": { "key": "key", "value": "v", "in": "query" } })),
    ] {
        let result = execute(
            &pool,
            route,
            None,
            &cfg(json!({ "method": "GET", "url": format!("{}{}", server.uri(), route), "auth": auth })),
            &no_vars(),
        )
        .await;
        assert!(result.ok, "{route}: {:?}", result.error);
    }
}

#[tokio::test]
async fn unsupported_auth_type_fails_loudly() {
    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "hawk",
        None,
        &cfg(json!({
            "method": "GET",
            "url": "http://localhost:1/",
            "auth": { "type": "hawk" }
        })),
        &no_vars(),
    )
    .await;
    assert!(!result.ok);
    assert!(
        result.error.as_deref().unwrap_or("").contains("not supported"),
        "{:?}",
        result.error
    );
}

#[tokio::test]
async fn digest_auth_with_challenge_retry() {
    let server = MockServer::start().await;
    // 带 Digest 头的请求返回 200（先挂载，优先级高）
    Mock::given(method("GET"))
        .and(path("/digest"))
        .and(header_regex("authorization", r##"Digest username="u", realm="test", nonce="abc123""##))
        .respond_with(ResponseTemplate::new(200).set_body_string("authenticated"))
        .expect(1)
        .mount(&server)
        .await;
    // 无认证头的请求返回 401 + WWW-Authenticate
    Mock::given(method("GET"))
        .and(path("/digest"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header(
                    "www-authenticate",
                    r#"Digest realm="test", nonce="abc123", qop="auth", opaque="xyz""#,
                ),
        )
        .expect(1)
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "digest",
        None,
        &cfg(json!({
            "method": "GET",
            "url": format!("{}/digest", server.uri()),
            "auth": {
                "type": "digest",
                "digest": { "username": "u", "password": "p" }
            }
        })),
        &no_vars(),
    )
    .await;
    // 第一次 401 后挑战重试成功
    assert!(result.ok, "{:?}", result.error);
}

#[tokio::test]
async fn oauth2_token_auth_is_applied() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/oauth2"))
        .and(header("authorization", "Bearer my-access-token"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "oauth2",
        None,
        &cfg(json!({
            "method": "GET",
            "url": format!("{}/oauth2", server.uri()),
            "auth": {
                "type": "oauth2",
                "oauth2": { "accessToken": "my-access-token" }
            }
        })),
        &no_vars(),
    )
    .await;
    assert!(result.ok, "{:?}", result.error);
}

#[tokio::test]
async fn pre_request_script_rewrites_url_and_variables_flow_into_test() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rewritten"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"mark": "from-pre"})))
        .expect(1)
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "scripted",
        None,
        &cfg(json!({
            "method": "GET",
            "url": "http://should.be.rewritten/never",
            "scripts": {
                "preRequest": format!(
                    "rp.request.url = '{}'; rp.environment.set('mark', 'from-pre');",
                    format!("{}/rewritten", server.uri())
                ),
                "test": r#"
                    rp.test("status 200", () => { rp.response.to.have.status(200); });
                    rp.test("pre 变量贯穿到 test", () => {
                        rp.expect(rp.environment.get("mark")).to.equal("from-pre");
                        rp.expect(rp.response.json().mark).to.equal("from-pre");
                    });
                "#
            }
        })),
        &no_vars(),
    )
    .await;

    assert!(result.ok, "{result:?}");
    let tests = result.test_results.unwrap();
    assert_eq!(tests.len(), 2);
    assert!(tests.iter().all(|t| t.passed), "{tests:?}");
}

#[tokio::test]
async fn failing_assertion_flips_ok_to_false_with_details() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "assert-fail",
        None,
        &cfg(json!({
            "method": "GET",
            "url": format!("{}/ok", server.uri()),
            "scripts": { "test": "rp.test('boom', () => { rp.expect(1).to.equal(2); });" }
        })),
        &no_vars(),
    )
    .await;

    assert!(!result.ok, "断言失败等价用例失败");
    assert_eq!(result.status, Some(200), "状态码仍原样上报");
    assert!(result.error.is_none());
    let tests = result.test_results.unwrap();
    assert_eq!(tests.len(), 1);
    assert!(!tests[0].passed);
    assert!(tests[0]
        .error
        .as_deref()
        .unwrap_or("")
        .contains("AssertionError"));
}

#[tokio::test]
async fn http_4xx_keeps_status_and_marks_failure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "404",
        None,
        &cfg(json!({ "method": "GET", "url": format!("{}/missing", server.uri()) })),
        &no_vars(),
    )
    .await;
    assert!(!result.ok);
    assert_eq!(result.status, Some(404));
    assert!(result.error.is_none());
}

#[tokio::test]
async fn network_error_is_passthrough_with_cause_chain() {
    // 绑定后立即释放端口，制造 connection refused
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let pool = ClientPool::new("test-agent");
    let result = execute(
        &pool,
        "refused",
        None,
        &cfg(json!({
            "method": "GET",
            "url": format!("http://127.0.0.1:{port}/"),
            "settings": { "timeoutMs": 2000 }
        })),
        &no_vars(),
    )
    .await;
    assert!(!result.ok);
    let error = result.error.unwrap_or_default();
    assert!(!error.is_empty(), "网络错误原文透传");
    assert!(result.status.is_none());
    assert!(result.duration_ms.is_some(), "失败也记录耗时");
}

#[tokio::test]
async fn redirect_follow_policy_is_respected() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/redir"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/final"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/final"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let pool = ClientPool::new("test-agent");
    // 默认跟随重定向
    let followed = execute(
        &pool,
        "follow",
        None,
        &cfg(json!({ "method": "GET", "url": format!("{}/redir", server.uri()) })),
        &no_vars(),
    )
    .await;
    assert!(followed.ok);
    assert_eq!(followed.status, Some(200));

    // 关闭跟随：3xx 原样返回（ok 按 is_redirection 记为 true，与服务端一致）
    let not_followed = execute(
        &pool,
        "nofollow",
        None,
        &cfg(json!({
            "method": "GET",
            "url": format!("{}/redir", server.uri()),
            "settings": { "followRedirects": false }
        })),
        &no_vars(),
    )
    .await;
    assert_eq!(not_followed.status, Some(302));
}

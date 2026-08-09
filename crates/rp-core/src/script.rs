//! Postman 风格脚本沙箱（QuickJS 实现，默认超时 5s，内存上限 64MB）。
//! 提供 rp.environment / rp.variables / rp.request / rp.response / rp.test / rp.expect /
//! rp.db（数据库访问，async 宿主函数）与 console，
//! 行为与服务端 node:vm 沙箱（apps/api/src/lib/pm-sandbox.ts）逐条对齐；
//! rp 为 RabbitPost 命名，pm 作为兼容别名指向同一对象。
//!
//! 用户代码包在 async IIFE 中执行（与服务端一致），顶层可用 await；
//! 同步旧脚本不受影响。5s 中断器仍兜底同步死循环；异步等待由外层
//! wall-clock 超时兜底。需在 tokio runtime 内调用。
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db::DbRegistry;
use crate::model::{ConsoleLogEntry, TestResult};

const SCRIPT_TIMEOUT: Duration = Duration::from_secs(5);
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseView {
    pub code: u16,
    pub status: String,
    pub headers: HashMap<String, String>,
    pub time: u64,
    pub body_text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutput {
    #[serde(default)]
    pub test_results: Vec<TestResult>,
    #[serde(default)]
    pub console_logs: Vec<ConsoleLogEntry>,
    /// 脚本执行期间的变量改动（仅本次请求生命周期内生效）
    #[serde(default)]
    pub variables: HashMap<String, String>,
    /// 脚本执行后的 globals 表（rp.globals 作用域；跨请求/跨迭代持久）
    #[serde(default)]
    pub globals: HashMap<String, String>,
    /// pre-request 脚本可能改写请求
    #[serde(default)]
    pub request: Option<RequestView>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptInput<'a> {
    phase: &'a str,
    variables: &'a HashMap<String, String>,
    globals: &'a HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<&'a RequestView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<&'a ResponseView>,
}

/// JS harness：pm-sandbox.ts 的等价移植（ES2020，无 Node 依赖）。
/// 通过 globalThis.__RP_INPUT__（JSON 字符串）注入输入，
/// 用户代码经 __RP_EXEC__ 间接 eval 在全局作用域执行并捕获异常，
/// 最后 __RP_FINISH__ 汇总结果并 JSON.stringify 返回。
const HARNESS: &str = r#"
(function () {
  var input = JSON.parse(globalThis.__RP_INPUT__);
  var result = {
    testResults: [],
    consoleLogs: [],
    variables: {},
    request: null,
    error: null
  };
  var vars = {};
  var src = input.variables || {};
  for (var k in src) vars[k] = src[k];
  var gvars = {};
  var gsrc = input.globals || {};
  for (var gk in gsrc) gvars[gk] = gsrc[gk];

  function safeStringify(v) {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function fail(msg) { throw new Error("AssertionError: " + msg); }
  function makeExpect(actual) {
    var assertions = {
      equal: function (e) {
        if (actual !== e) fail("expected " + safeStringify(actual) + " to equal " + safeStringify(e));
      },
      eql: function (e) {
        if (safeStringify(actual) !== safeStringify(e))
          fail("expected " + safeStringify(actual) + " to deeply equal " + safeStringify(e));
      },
      include: function (p) {
        var ok =
          (typeof actual === "string" && actual.indexOf(String(p)) !== -1) ||
          (Array.isArray(actual) && actual.indexOf(p) !== -1);
        if (!ok) fail("expected " + safeStringify(actual) + " to include " + safeStringify(p));
      },
      above: function (n) {
        if (!(typeof actual === "number" && actual > n))
          fail("expected " + safeStringify(actual) + " to be above " + n);
      },
      below: function (n) {
        if (!(typeof actual === "number" && actual < n))
          fail("expected " + safeStringify(actual) + " to be below " + n);
      },
      oneOf: function (l) {
        if (l.indexOf(actual) === -1)
          fail("expected " + safeStringify(actual) + " to be one of " + safeStringify(l));
      },
      exist: function () {
        if (actual === null || actual === undefined) fail("expected value to exist");
      }
    };
    var to = {};
    for (var a in assertions) to[a] = assertions[a];
    to.be = {
      ok: function () { if (!actual) fail("expected " + safeStringify(actual) + " to be ok"); },
      true: function () { if (actual !== true) fail("expected " + safeStringify(actual) + " to be true"); },
      false: function () { if (actual !== false) fail("expected " + safeStringify(actual) + " to be false"); }
    };
    for (var b in assertions) to.be[b] = assertions[b];
    return { to: to };
  }

  var consoleObj = {};
  ["log", "info", "warn", "error"].forEach(function (level) {
    consoleObj[level] = function () {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(safeStringify(arguments[i]));
      result.consoleLogs.push({ level: level, args: args });
    };
  });

  var rp = {
    environment: {
      get: function (k) { return vars[k]; },
      set: function (k, v) { vars[k] = safeStringify(v); },
      unset: function (k) { delete vars[k]; },
      toObject: function () { var o = {}; for (var k2 in vars) o[k2] = vars[k2]; return o; }
    },
    variables: {
      get: function (k) { return vars[k]; },
      set: function (k, v) { vars[k] = safeStringify(v); }
    },
    globals: {
      get: function (k) { return gvars[k]; },
      set: function (k, v) { gvars[k] = safeStringify(v); },
      unset: function (k) { delete gvars[k]; },
      toObject: function () { var o = {}; for (var gk2 in gvars) o[gk2] = gvars[gk2]; return o; }
    },
    test: function (name, fn) {
      try {
        fn();
        result.testResults.push({ name: name, passed: true });
      } catch (e) {
        result.testResults.push({
          name: name,
          passed: false,
          error: e && e.message ? e.message : String(e)
        });
      }
    },
    expect: function (actual) { return makeExpect(actual); }
  };

  if (input.request) {
    rp.request = {
      method: input.request.method,
      url: input.request.url,
      headers: {},
      body: input.request.body
    };
    for (var hk in input.request.headers) rp.request.headers[hk] = input.request.headers[hk];
  }
  if (input.response) {
    var resp = input.response;
    rp.response = {
      code: resp.code,
      status: resp.status,
      headers: resp.headers,
      time: resp.time,
      json: function () { return JSON.parse(resp.bodyText); },
      text: function () { return resp.bodyText; },
      to: {
        have: {
          status: function (expected) {
            if (resp.code !== expected)
              throw new Error(
                "AssertionError: expected response status " + resp.code + " to be " + expected
              );
          }
        }
      }
    };
  }

  // rp.db：宿主 async 函数（__RP_DB_*__ 由 Rust 注入，返回 JSON 信封
  // {"ok":true,"value":...} / {"ok":false,"error":...}），未配置连接时调用即报错
  function callDb(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return Promise.resolve(fn.apply(null, args)).then(function (res) {
      var r = JSON.parse(res);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
  }
  rp.db = {
    query: function (name, sql, params) {
      return callDb(globalThis.__RP_DB_QUERY__, name, sql, JSON.stringify(params == null ? [] : params));
    },
    exec: function (name, sql, params) {
      return callDb(globalThis.__RP_DB_EXEC__, name, sql, JSON.stringify(params == null ? [] : params));
    },
    redis: function (name, command, args) {
      return callDb(globalThis.__RP_DB_REDIS__, name, command, JSON.stringify(args == null ? [] : args));
    }
  };

  globalThis.rp = rp;
  globalThis.pm = rp;
  globalThis.console = consoleObj;

  // 间接 eval：用户代码包在 async IIFE 中执行（与服务端沙箱一致，顶层可用 await），
  // 异常与 Promise 拒绝统一转成消息返回
  globalThis.__RP_EXEC__ = function (code) {
    var p;
    try {
      p = (0, eval)("(async function () {\n" + code + "\n})()");
    } catch (e) {
      return Promise.resolve(e && e.message ? e.message : String(e));
    }
    return Promise.resolve(p).then(
      function () { return null; },
      function (e) { return e && e.message ? e.message : String(e); }
    );
  };

  globalThis.__RP_FINISH__ = function (errorMessage) {
    if (errorMessage) {
      result.error = errorMessage;
      result.consoleLogs.push({ level: "error", args: ["[" + input.phase + "] " + errorMessage] });
    }
    result.variables = vars;
    result.globals = gvars;
    if (input.request) result.request = rp.request;
    return JSON.stringify(result);
  };
})();
"#;

/// 执行一段用户脚本；任何宿主层错误（引擎创建失败等）也降级为 error 字段返回，
/// 不让脚本问题阻塞主执行流程（与服务端 runUserScript 行为一致）。
/// globals 缺省为空表（Runner / 服务端路径不启用 globals 作用域）。
pub async fn run_script(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
) -> ScriptOutput {
    run_script_with_globals(code, phase, variables, &HashMap::new(), None, request, response).await
}

/// 带 globals 作用域的完整形态：CLI 一次 run 内跨请求共享 globals；
/// timeout_ms 覆盖默认脚本超时（--timeout-script），None 用 SCRIPT_TIMEOUT
pub async fn run_script_with_globals(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    globals: &HashMap<String, String>,
    timeout_ms: Option<u64>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
) -> ScriptOutput {
    run_script_full(code, phase, variables, globals, timeout_ms, request, response, None).await
}

/// 全参数形态：globals 作用域 + rp.db 数据库注册表（None 时 rp.db.* 调用报清晰错误）
#[allow(clippy::too_many_arguments)] // 参数与服务端 runUserScript 入参一一对应，不再封装结构体
pub async fn run_script_full(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    globals: &HashMap<String, String>,
    timeout_ms: Option<u64>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
    db: Option<Arc<DbRegistry>>,
) -> ScriptOutput {
    match run_script_inner(code, phase, variables, globals, timeout_ms, request, response, db).await
    {
        Ok(output) => output,
        Err(e) => ScriptOutput {
            variables: variables.clone(),
            globals: globals.clone(),
            error: Some(format!("script engine error: {e:#}")),
            ..Default::default()
        },
    }
}

/// rp.db 宿主函数的统一出口：结果包装为 JSON 信封字符串，
/// JS 侧 callDb 解包并在 !ok 时 throw Error(error)
fn db_envelope(result: anyhow::Result<serde_json::Value>) -> String {
    match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }).to_string(),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("{e:#}") }).to_string(),
    }
}

fn parse_db_params(params: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    serde_json::from_str(params).map_err(|e| anyhow::anyhow!("invalid db params: {e}"))
}

fn no_db_error() -> anyhow::Error {
    anyhow::anyhow!("rp.db: no database connections configured for this execution")
}

/// 注入 __RP_DB_QUERY__ / __RP_DB_EXEC__ / __RP_DB_REDIS__ 三个 async 宿主函数；
/// 无连接注册表时仍注入（调用即返回"未配置数据库连接"错误信封）
fn inject_db_functions(ctx: &rquickjs::Ctx<'_>, db: Option<Arc<DbRegistry>>) -> rquickjs::Result<()> {
    use rquickjs::function::{Async, Func};

    let registry = db.clone();
    ctx.globals().set(
        "__RP_DB_QUERY__",
        Func::from(Async(move |name: String, sql: String, params: String| {
            let registry = registry.clone();
            async move {
                db_envelope(match (registry, parse_db_params(&params)) {
                    (Some(registry), Ok(params)) => registry
                        .query(&name, &sql, &params)
                        .await
                        .and_then(|r| Ok(serde_json::to_value(r)?)),
                    (None, Ok(_)) => Err(no_db_error()),
                    (_, Err(e)) => Err(e),
                })
            }
        })),
    )?;

    let registry = db.clone();
    ctx.globals().set(
        "__RP_DB_EXEC__",
        Func::from(Async(move |name: String, sql: String, params: String| {
            let registry = registry.clone();
            async move {
                db_envelope(match (registry, parse_db_params(&params)) {
                    (Some(registry), Ok(params)) => registry
                        .exec(&name, &sql, &params)
                        .await
                        .and_then(|r| Ok(serde_json::to_value(r)?)),
                    (None, Ok(_)) => Err(no_db_error()),
                    (_, Err(e)) => Err(e),
                })
            }
        })),
    )?;

    let registry = db;
    ctx.globals().set(
        "__RP_DB_REDIS__",
        Func::from(Async(move |name: String, command: String, args: String| {
            let registry = registry.clone();
            async move {
                db_envelope(match (registry, parse_db_params(&args)) {
                    (Some(registry), Ok(args)) => {
                        let args: Vec<String> = args
                            .iter()
                            .map(|v| match v {
                                serde_json::Value::String(s) => s.clone(),
                                other => other.to_string(),
                            })
                            .collect();
                        registry.redis(&name, &command, &args).await
                    }
                    (None, Ok(_)) => Err(no_db_error()),
                    (_, Err(e)) => Err(e),
                })
            }
        })),
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)] // 同 run_script_full
async fn run_script_inner(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    globals: &HashMap<String, String>,
    timeout_ms: Option<u64>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
    db: Option<Arc<DbRegistry>>,
) -> anyhow::Result<ScriptOutput> {
    use rquickjs::{async_with, AsyncContext, AsyncRuntime, Promise};

    let runtime = AsyncRuntime::new()?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES).await;
    let timeout = timeout_ms
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(SCRIPT_TIMEOUT);
    let deadline = Instant::now() + timeout;
    runtime
        .set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)))
        .await;
    let context = AsyncContext::full(&runtime).await?;

    let input = serde_json::to_string(&ScriptInput {
        phase,
        variables,
        globals,
        request,
        response,
    })?;
    let code = code.to_string();

    let run = async_with!(context => |ctx| {
        inject_db_functions(&ctx, db)?;
        ctx.globals().set("__RP_INPUT__", input)?;
        ctx.eval::<(), _>(HARNESS)?;
        ctx.globals().set("__RP_CODE__", code.as_str())?;
        let promise = ctx.eval::<Promise, _>(
            "(async function () { return __RP_FINISH__(await __RP_EXEC__(__RP_CODE__)); })()",
        )?;
        let json: String = promise.into_future::<String>().await?;
        let output: ScriptOutput = serde_json::from_str(&json)?;
        Ok(output)
    });

    // wall-clock 兜底：中断器只拦同步代码，挂起的异步等待（如 db 调用）由这里限时
    match tokio::time::timeout(timeout + Duration::from_secs(1), run).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "script timed out after {}s",
            timeout.as_secs()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_vars() -> HashMap<String, String> {
        HashMap::new()
    }

    #[tokio::test]
    async fn collects_passing_and_failing_tests() {
        let out = run_script(
            r#"
            rp.test("math works", () => { rp.expect(1 + 1).to.equal(2); });
            rp.test("fails", () => { rp.expect("a").to.equal("b"); });
            "#,
            "test",
            &no_vars(),
            None,
            None,
        ).await;
        assert!(out.error.is_none());
        assert_eq!(out.test_results.len(), 2);
        assert!(out.test_results[0].passed);
        assert!(!out.test_results[1].passed);
        // 与服务端 safeStringify 一致：字符串原样输出（不加引号）
        assert_eq!(
            out.test_results[1].error.as_deref(),
            Some("AssertionError: expected a to equal b")
        );
    }

    #[tokio::test]
    async fn supports_environment_and_console() {
        let mut vars = HashMap::new();
        vars.insert("base".to_string(), "https://x".to_string());
        let out = run_script(
            r#"
            console.log("base is", rp.environment.get("base"));
            rp.environment.set("token", 123);
            rp.variables.set("n", "1");
            "#,
            "pre-request",
            &vars,
            None,
            None,
        ).await;
        assert_eq!(out.variables.get("token").map(String::as_str), Some("123"));
        assert_eq!(out.variables.get("n").map(String::as_str), Some("1"));
        assert_eq!(out.console_logs.len(), 1);
        assert_eq!(out.console_logs[0].args, vec!["base is", "https://x"]);
    }

    #[tokio::test]
    async fn globals_scope_roundtrips_independently() {
        let mut globals = HashMap::new();
        globals.insert("g0".to_string(), "keep".to_string());
        let out = run_script_with_globals(
            r#"
            rp.globals.set("g1", 42);
            rp.globals.unset("g0");
            rp.environment.set("e1", "v");
            rp.test("reads", () => { rp.expect(rp.globals.get("g1")).to.equal("42"); });
            "#,
            "test",
            &HashMap::new(),
            &globals,
            None,
            None,
            None,
        ).await;
        assert!(out.error.is_none());
        assert!(out.test_results[0].passed);
        // globals 与 variables 是两个独立作用域
        assert_eq!(out.globals.get("g1").map(String::as_str), Some("42"));
        assert!(!out.globals.contains_key("g0"));
        assert!(!out.variables.contains_key("g1"));
        assert_eq!(out.variables.get("e1").map(String::as_str), Some("v"));
        // run_script（无 globals）下 rp.globals 也可用，从空表开始
        let out = run_script("rp.globals.set('x', '1');", "test", &HashMap::new(), None, None).await;
        assert_eq!(out.globals.get("x").map(String::as_str), Some("1"));
    }

    #[tokio::test]
    async fn response_status_assertion_and_json() {
        let response = ResponseView {
            code: 200,
            status: "OK".to_string(),
            headers: HashMap::new(),
            time: 12,
            body_text: r#"{"id": 7}"#.to_string(),
        };
        let out = run_script(
            r#"
            rp.test("status is 200", () => { rp.response.to.have.status(200); });
            rp.test("body has id", () => { rp.expect(rp.response.json().id).to.equal(7); });
            "#,
            "test",
            &no_vars(),
            None,
            Some(&response),
        ).await;
        assert!(out.test_results.iter().all(|t| t.passed));
    }

    #[tokio::test]
    async fn syntax_error_is_reported_not_thrown() {
        let out = run_script("this is not js", "test", &no_vars(), None, None).await;
        assert!(out.error.is_some());
        assert_eq!(out.console_logs.len(), 1);
        assert_eq!(out.console_logs[0].level, "error");
    }

    #[tokio::test]
    async fn infinite_loop_is_interrupted() {
        let started = Instant::now();
        let out = run_script("while (true) {}", "test", &no_vars(), None, None).await;
        assert!(started.elapsed() < SCRIPT_TIMEOUT + Duration::from_secs(2));
        assert!(out.error.is_some());
    }

    #[tokio::test]
    async fn expect_assertion_variants_match_server_semantics() {
        let out = run_script(
            r#"
            rp.test("eql deep compare", () => { rp.expect({a:1}).to.eql({a:1}); });
            rp.test("include string", () => { rp.expect("hello world").to.include("world"); });
            rp.test("include array", () => { rp.expect([1,2,3]).to.include(2); });
            rp.test("above/below", () => { rp.expect(5).to.be.above(3); rp.expect(5).to.be.below(9); });
            rp.test("oneOf", () => { rp.expect(2).to.be.oneOf([1,2,3]); });
            rp.test("exist", () => { rp.expect(0).to.exist(); });
            rp.test("be.ok/true/false", () => {
                rp.expect(1).to.be.ok();
                rp.expect(true).to.be.true();
                rp.expect(false).to.be.false();
            });
            rp.test("include 缺失报错", () => { rp.expect("abc").to.include("z"); });
            "#,
            "test",
            &no_vars(),
            None,
            None,
        ).await;
        let passed = out.test_results.iter().filter(|t| t.passed).count();
        assert_eq!(passed, 7, "{:?}", out.test_results);
        let failed = out.test_results.iter().find(|t| !t.passed).unwrap();
        assert_eq!(failed.name, "include 缺失报错");
        assert_eq!(
            failed.error.as_deref(),
            Some("AssertionError: expected abc to include z")
        );
    }

    #[tokio::test]
    async fn pm_is_alias_of_rp_and_environment_unset_works() {
        let mut vars = HashMap::new();
        vars.insert("a".to_string(), "1".to_string());
        vars.insert("b".to_string(), "2".to_string());
        let out = run_script(
            r#"
            pm.environment.unset("a");
            console.log(Object.keys(pm.environment.toObject()).join(","));
            pm.test("alias", () => { pm.expect(pm.variables.get("b")).to.equal("2"); });
            "#,
            "test",
            &vars,
            None,
            None,
        ).await;
        assert!(!out.variables.contains_key("a"));
        assert_eq!(out.variables.get("b").map(String::as_str), Some("2"));
        assert_eq!(out.console_logs[0].args, vec!["b"]);
        assert!(out.test_results[0].passed);
    }

    #[tokio::test]
    async fn response_json_parse_error_fails_only_that_test() {
        let response = ResponseView {
            code: 200,
            status: "OK".to_string(),
            headers: HashMap::new(),
            time: 3,
            body_text: "not-json".to_string(),
        };
        let out = run_script(
            r#"
            rp.test("bad json", () => { rp.response.json(); });
            rp.test("text still works", () => { rp.expect(rp.response.text()).to.equal("not-json"); });
            "#,
            "test",
            &no_vars(),
            None,
            Some(&response),
        ).await;
        assert!(!out.test_results[0].passed);
        assert!(out.test_results[1].passed);
        assert!(out.error.is_none());
    }

    #[tokio::test]
    async fn pre_request_can_rewrite_request() {
        let request = RequestView {
            method: "GET".to_string(),
            url: "https://a".to_string(),
            headers: HashMap::from([("x-a".to_string(), "1".to_string())]),
            body: None,
        };
        let out = run_script(
            r#"rp.request.url = "https://b"; rp.request.headers["x-b"] = "2";"#,
            "pre-request",
            &no_vars(),
            Some(&request),
            None,
        ).await;
        let rewritten = out.request.expect("request should be captured");
        assert_eq!(rewritten.url, "https://b");
        assert_eq!(rewritten.headers.get("x-b").map(String::as_str), Some("2"));
    }

    fn sqlite_registry() -> Arc<DbRegistry> {
        use crate::model::{DbConnectionConfig, ResolvedDbConnection};
        Arc::new(DbRegistry::new(&[ResolvedDbConnection {
            name: "测试库".to_string(),
            config: DbConnectionConfig {
                conn_type: "sqlite".to_string(),
                filepath: Some(":memory:".to_string()),
                ..Default::default()
            },
            password: None,
        }]))
    }

    #[tokio::test]
    async fn top_level_await_and_sync_scripts_both_work() {
        // 顶层 await（新能力）与普通同步脚本（旧行为）都支持
        let out = run_script(
            r#"
            const answer = await Promise.resolve(42);
            rp.test("await works", () => { rp.expect(answer).to.equal(42); });
            rp.environment.set("k", "v");
            "#,
            "test",
            &no_vars(),
            None,
            None,
        )
        .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.test_results[0].passed);
        assert_eq!(out.variables.get("k").map(String::as_str), Some("v"));
    }

    #[tokio::test]
    async fn db_query_and_exec_from_script() {
        let registry = sqlite_registry();
        let out = run_script_full(
            r#"
            await rp.db.exec("测试库", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
            const ins = await rp.db.exec("测试库", "INSERT INTO users (name) VALUES (?)", ["小明"]);
            rp.test("insert affected 1", () => { rp.expect(ins.affectedRows).to.equal(1); });
            const res = await rp.db.query("测试库", "SELECT id, name FROM users WHERE id = ?", [1]);
            rp.test("rowCount is 1", () => { rp.expect(res.rowCount).to.equal(1); });
            rp.test("row content", () => { rp.expect(res.rows[0].name).to.equal("小明"); });
            rp.environment.set("userName", res.rows[0].name);
            "#,
            "test",
            &no_vars(),
            &HashMap::new(),
            None,
            None,
            None,
            Some(registry.clone()),
        )
        .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(
            out.test_results.iter().all(|t| t.passed),
            "{:?}",
            out.test_results
        );
        assert_eq!(out.variables.get("userName").map(String::as_str), Some("小明"));
        registry.close_all().await;
    }

    #[tokio::test]
    async fn db_errors_surface_as_script_errors() {
        // 未配置连接：rp.db.* 报清晰错误（脚本层可 catch）
        let out = run_script(
            r#"
            let message = "";
            try {
                await rp.db.query("db", "SELECT 1");
            } catch (e) {
                message = e.message;
            }
            rp.test("clear error", () => { rp.expect(message).to.include("no database connections"); });
            "#,
            "test",
            &no_vars(),
            None,
            None,
        )
        .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.test_results[0].passed, "{:?}", out.test_results);

        // 未捕获的 db 错误与同步脚本异常一样进入 error 字段（不阻塞宿主）
        let out = run_script(r#"await rp.db.exec("db", "SELECT 1");"#, "test", &no_vars(), None, None).await;
        assert!(out.error.as_deref().is_some_and(|e| e.contains("no database connections")), "{:?}", out.error);

        // 配置了连接但名字不存在：错误里列出可用连接
        let registry = sqlite_registry();
        let out = run_script_full(
            r#"await rp.db.redis("缓存", "GET", ["k"]);"#,
            "test",
            &no_vars(),
            &HashMap::new(),
            None,
            None,
            None,
            Some(registry.clone()),
        )
        .await;
        assert!(
            out.error.as_deref().is_some_and(|e| e.contains("unknown database connection") && e.contains("测试库")),
            "{:?}",
            out.error
        );
        registry.close_all().await;
    }

    #[tokio::test]
    async fn db_readonly_guard_applies_to_scripts() {
        use crate::model::{DbConnectionConfig, ResolvedDbConnection};
        let registry = Arc::new(DbRegistry::new(&[ResolvedDbConnection {
            name: "ro".to_string(),
            config: DbConnectionConfig {
                conn_type: "sqlite".to_string(),
                filepath: Some(":memory:".to_string()),
                read_only: Some(true),
                ..Default::default()
            },
            password: None,
        }]));
        let out = run_script_full(
            r#"
            const ok = await rp.db.query("ro", "SELECT 1 AS v");
            rp.test("select allowed", () => { rp.expect(ok.rows[0].v).to.equal(1); });
            let message = "";
            try {
                await rp.db.exec("ro", "CREATE TABLE t (v TEXT)");
            } catch (e) {
                message = e.message;
            }
            rp.test("write rejected", () => { rp.expect(message).to.include("read-only"); });
            "#,
            "test",
            &no_vars(),
            &HashMap::new(),
            None,
            None,
            None,
            Some(registry.clone()),
        )
        .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(
            out.test_results.iter().all(|t| t.passed),
            "{:?}",
            out.test_results
        );
        registry.close_all().await;
    }
}

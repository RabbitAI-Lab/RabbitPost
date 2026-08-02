//! Postman 风格脚本沙箱（QuickJS 实现，默认超时 5s，内存上限 64MB）。
//! 提供 rp.environment / rp.variables / rp.request / rp.response / rp.test / rp.expect / console，
//! 行为与服务端 node:vm 沙箱（apps/api/src/lib/pm-sandbox.ts）逐条对齐；
//! rp 为 RabbitPost 命名，pm 作为兼容别名指向同一对象。
use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

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

  globalThis.rp = rp;
  globalThis.pm = rp;
  globalThis.console = consoleObj;

  // 间接 eval：用户代码在全局作用域执行（与 vm.Script 语义一致），异常转成消息返回
  globalThis.__RP_EXEC__ = function (code) {
    try {
      (0, eval)(code);
      return null;
    } catch (e) {
      return e && e.message ? e.message : String(e);
    }
  };

  globalThis.__RP_FINISH__ = function (errorMessage) {
    if (errorMessage) {
      result.error = errorMessage;
      result.consoleLogs.push({ level: "error", args: ["[" + input.phase + "] " + errorMessage] });
    }
    result.variables = vars;
    if (input.request) result.request = rp.request;
    return JSON.stringify(result);
  };
})();
"#;

/// 执行一段用户脚本；任何宿主层错误（引擎创建失败等）也降级为 error 字段返回，
/// 不让脚本问题阻塞主执行流程（与服务端 runUserScript 行为一致）。
pub fn run_script(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
) -> ScriptOutput {
    match run_script_inner(code, phase, variables, request, response) {
        Ok(output) => output,
        Err(e) => ScriptOutput {
            variables: variables.clone(),
            error: Some(format!("script engine error: {e:#}")),
            ..Default::default()
        },
    }
}

fn run_script_inner(
    code: &str,
    phase: &str,
    variables: &HashMap<String, String>,
    request: Option<&RequestView>,
    response: Option<&ResponseView>,
) -> anyhow::Result<ScriptOutput> {
    use rquickjs::{Context, Runtime};

    let runtime = Runtime::new()?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime)?;

    let input = serde_json::to_string(&ScriptInput {
        phase,
        variables,
        request,
        response,
    })?;

    context.with(|ctx| -> anyhow::Result<ScriptOutput> {
        ctx.globals().set("__RP_INPUT__", input)?;
        ctx.eval::<(), _>(HARNESS)?;
        ctx.globals().set("__RP_CODE__", code)?;
        let json = ctx.eval::<String, _>("__RP_FINISH__(__RP_EXEC__(__RP_CODE__))")?;
        let output: ScriptOutput = serde_json::from_str(&json)?;
        Ok(output)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_vars() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn collects_passing_and_failing_tests() {
        let out = run_script(
            r#"
            rp.test("math works", () => { rp.expect(1 + 1).to.equal(2); });
            rp.test("fails", () => { rp.expect("a").to.equal("b"); });
            "#,
            "test",
            &no_vars(),
            None,
            None,
        );
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

    #[test]
    fn supports_environment_and_console() {
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
        );
        assert_eq!(out.variables.get("token").map(String::as_str), Some("123"));
        assert_eq!(out.variables.get("n").map(String::as_str), Some("1"));
        assert_eq!(out.console_logs.len(), 1);
        assert_eq!(out.console_logs[0].args, vec!["base is", "https://x"]);
    }

    #[test]
    fn response_status_assertion_and_json() {
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
        );
        assert!(out.test_results.iter().all(|t| t.passed));
    }

    #[test]
    fn syntax_error_is_reported_not_thrown() {
        let out = run_script("this is not js", "test", &no_vars(), None, None);
        assert!(out.error.is_some());
        assert_eq!(out.console_logs.len(), 1);
        assert_eq!(out.console_logs[0].level, "error");
    }

    #[test]
    fn infinite_loop_is_interrupted() {
        let started = Instant::now();
        let out = run_script("while (true) {}", "test", &no_vars(), None, None);
        assert!(started.elapsed() < SCRIPT_TIMEOUT + Duration::from_secs(2));
        assert!(out.error.is_some());
    }

    #[test]
    fn expect_assertion_variants_match_server_semantics() {
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
        );
        let passed = out.test_results.iter().filter(|t| t.passed).count();
        assert_eq!(passed, 7, "{:?}", out.test_results);
        let failed = out.test_results.iter().find(|t| !t.passed).unwrap();
        assert_eq!(failed.name, "include 缺失报错");
        assert_eq!(
            failed.error.as_deref(),
            Some("AssertionError: expected abc to include z")
        );
    }

    #[test]
    fn pm_is_alias_of_rp_and_environment_unset_works() {
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
        );
        assert!(!out.variables.contains_key("a"));
        assert_eq!(out.variables.get("b").map(String::as_str), Some("2"));
        assert_eq!(out.console_logs[0].args, vec!["b"]);
        assert!(out.test_results[0].passed);
    }

    #[test]
    fn response_json_parse_error_fails_only_that_test() {
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
        );
        assert!(!out.test_results[0].passed);
        assert!(out.test_results[1].passed);
        assert!(out.error.is_none());
    }

    #[test]
    fn pre_request_can_rewrite_request() {
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
        );
        let rewritten = out.request.expect("request should be captured");
        assert_eq!(rewritten.url, "https://b");
        assert_eq!(rewritten.headers.get("x-b").map(String::as_str), Some("2"));
    }
}

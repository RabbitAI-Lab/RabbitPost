//! 测试报告生成：JSON（标准结构，上传同源）、HTML（自包含单文件）、JUnit XML（CI 识别）。
use rp_core::model::JobResult;

/// XML/HTML 文本转义
pub fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn cdata(text: &str) -> String {
    // CDATA 内不允许出现 "]]>"，拆开转义
    format!("<![CDATA[{}]]>", text.replace("]]>", "]]>]]&gt;<![CDATA["))
}

pub struct ReportMeta<'a> {
    pub target_name: &'a str,
    pub target_type: &'a str,
    pub environment_name: Option<&'a str>,
    pub agent: &'a str,
    pub started_at: &'a str,
    pub finished_at: &'a str,
}

pub struct Summary {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub tests_passed: usize,
    pub tests_failed: usize,
    pub duration_ms: i64,
}

pub fn summarize(results: &[JobResult], duration_ms: i64) -> Summary {
    let succeeded = results.iter().filter(|r| r.ok).count();
    let tests_passed = results
        .iter()
        .flat_map(|r| r.test_results.iter().flatten())
        .filter(|t| t.passed)
        .count();
    let tests_failed = results
        .iter()
        .flat_map(|r| r.test_results.iter().flatten())
        .filter(|t| !t.passed)
        .count();
    Summary {
        total: results.len(),
        succeeded,
        failed: results.len() - succeeded,
        tests_passed,
        tests_failed,
        duration_ms,
    }
}

/// JUnit XML：每个请求一个 testcase；失败时附错误与失败断言明细
pub fn to_junit(meta: &ReportMeta, results: &[JobResult], summary: &Summary) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<testsuites name=\"rabbitpost\" tests=\"{}\" failures=\"{}\" time=\"{:.3}\">\n",
        summary.total,
        summary.failed,
        summary.duration_ms as f64 / 1000.0
    ));
    out.push_str(&format!(
        "  <testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" time=\"{:.3}\">\n",
        esc(meta.target_name),
        summary.total,
        summary.failed,
        summary.duration_ms as f64 / 1000.0
    ));
    for r in results {
        let case_name = format!("{} {}", r.method, r.name);
        let time = r.duration_ms.unwrap_or_default() as f64 / 1000.0;
        let has_details = !r.ok
            || r.test_results.as_ref().is_some_and(|t| !t.is_empty())
            || r.console_logs.as_ref().is_some_and(|l| !l.is_empty());
        if !has_details {
            out.push_str(&format!(
                "    <testcase classname=\"{}\" name=\"{}\" time=\"{time:.3}\"/>\n",
                esc(meta.target_name),
                esc(&case_name)
            ));
            continue;
        }
        out.push_str(&format!(
            "    <testcase classname=\"{}\" name=\"{}\" time=\"{time:.3}\">\n",
            esc(meta.target_name),
            esc(&case_name)
        ));
        if !r.ok {
            let failed_tests: Vec<String> = r
                .test_results
                .iter()
                .flatten()
                .filter(|t| !t.passed)
                .map(|t| {
                    format!(
                        "✗ {}{}",
                        t.name,
                        t.error
                            .as_deref()
                            .map(|e| format!(" — {e}"))
                            .unwrap_or_default()
                    )
                })
                .collect();
            let message = r.error.clone().unwrap_or_else(|| {
                format!("{} assertion(s) failed", failed_tests.len())
            });
            let mut detail = String::new();
            if let Some(error) = &r.error {
                detail.push_str(error);
                detail.push('\n');
            }
            detail.push_str(&failed_tests.join("\n"));
            out.push_str(&format!(
                "      <failure message=\"{}\">{}</failure>\n",
                esc(&message),
                cdata(&detail)
            ));
        }
        // 全部断言与 console 输出放入 system-out，便于在 CI 里展开查看
        let mut notes = String::new();
        if let Some(tests) = &r.test_results {
            for t in tests {
                notes.push_str(&format!(
                    "{} {}{}\n",
                    if t.passed { "✓" } else { "✗" },
                    t.name,
                    t.error
                        .as_deref()
                        .map(|e| format!(" — {e}"))
                        .unwrap_or_default()
                ));
            }
        }
        if let Some(logs) = &r.console_logs {
            for log in logs {
                notes.push_str(&format!("[{}] {}\n", log.level, log.args.join(" ")));
            }
        }
        if !notes.is_empty() {
            out.push_str(&format!("      <system-out>{}</system-out>\n", cdata(&notes)));
        }
        out.push_str("    </testcase>\n");
    }
    out.push_str("  </testsuite>\n</testsuites>\n");
    out
}

/// 自包含 HTML：头部汇总 + 逐请求 <details>（断言与 console 明细），无外部依赖
pub fn to_html(meta: &ReportMeta, results: &[JobResult], summary: &Summary) -> String {
    let status_text = if summary.failed == 0 { "PASSED" } else { "FAILED" };
    let status_color = if summary.failed == 0 { "#16a34a" } else { "#dc2626" };
    let mut rows = String::new();
    for r in results {
        let badge = if r.ok {
            "<span class=\"badge pass\">PASS</span>"
        } else {
            "<span class=\"badge fail\">FAIL</span>"
        };
        let status = r
            .status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "—".to_string());
        let duration = r
            .duration_ms
            .map(|d| format!("{d} ms"))
            .unwrap_or_else(|| "—".to_string());

        let mut detail = String::new();
        detail.push_str(&format!("<div class=\"url\">{}</div>", esc(&r.url)));
        if let Some(error) = &r.error {
            detail.push_str(&format!("<div class=\"error\">{}</div>", esc(error)));
        }
        if let Some(tests) = &r.test_results {
            if !tests.is_empty() {
                detail.push_str("<table class=\"tests\"><tbody>");
                for t in tests {
                    let cls = if t.passed { "pass-text" } else { "fail-text" };
                    let mark = if t.passed { "✓" } else { "✗" };
                    let err = t
                        .error
                        .as_deref()
                        .map(|e| format!("<div class=\"error small\">{}</div>", esc(e)))
                        .unwrap_or_default();
                    detail.push_str(&format!(
                        "<tr><td class=\"{cls}\">{mark}</td><td>{}{err}</td></tr>",
                        esc(&t.name)
                    ));
                }
                detail.push_str("</tbody></table>");
            }
        }
        if let Some(logs) = &r.console_logs {
            if !logs.is_empty() {
                detail.push_str("<pre class=\"logs\">");
                for log in logs {
                    detail.push_str(&format!(
                        "[{}] {}\n",
                        esc(&log.level),
                        esc(&log.args.join(" "))
                    ));
                }
                detail.push_str("</pre>");
            }
        }

        rows.push_str(&format!(
            "<details class=\"case{}\"><summary>{} <span class=\"method\">{}</span> {} \
             <span class=\"meta\">{} · {}</span></summary>{}</details>\n",
            if r.ok { "" } else { " failed" },
            badge,
            esc(&r.method),
            esc(&r.name),
            status,
            duration,
            detail
        ));
    }

    let environment = meta.environment_name.unwrap_or("—");
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>RabbitPost 测试报告 · {}</title>
<style>
  body {{ font-family: -apple-system, "SF Pro", "PingFang SC", sans-serif; margin: 0; background: #f7f7f8; color: #1f2329; }}
  .wrap {{ max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .sub {{ color: #6b7280; font-size: 13px; margin-bottom: 20px; }}
  .cards {{ display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }}
  .card {{ background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 18px; min-width: 110px; }}
  .card .num {{ font-size: 22px; font-weight: 600; }}
  .card .label {{ color: #6b7280; font-size: 12px; }}
  .status {{ color: #fff; background: {status_color}; border-radius: 6px; padding: 2px 10px; font-size: 13px; font-weight: 600; }}
  .case {{ background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; padding: 10px 14px; }}
  .case.failed {{ border-color: #fecaca; }}
  summary {{ cursor: pointer; font-size: 14px; list-style: none; }}
  summary::-webkit-details-marker {{ display: none; }}
  .method {{ font-weight: 600; color: #ea580c; margin: 0 6px; }}
  .meta {{ color: #6b7280; font-size: 12px; float: right; }}
  .badge {{ border-radius: 4px; padding: 1px 8px; font-size: 12px; font-weight: 600; }}
  .badge.pass {{ background: #dcfce7; color: #16a34a; }}
  .badge.fail {{ background: #fee2e2; color: #dc2626; }}
  .url {{ color: #6b7280; font-size: 12px; word-break: break-all; margin: 8px 0; }}
  .error {{ color: #dc2626; font-size: 13px; margin: 6px 0; white-space: pre-wrap; }}
  .error.small {{ font-size: 12px; }}
  table.tests {{ width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px; }}
  table.tests td {{ padding: 3px 8px; border-top: 1px solid #f3f4f6; }}
  .pass-text {{ color: #16a34a; width: 24px; }}
  .fail-text {{ color: #dc2626; width: 24px; }}
  pre.logs {{ background: #111827; color: #d1d5db; border-radius: 6px; padding: 10px 12px; font-size: 12px; overflow: auto; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>RabbitPost 测试报告 <span class="status">{status_text}</span></h1>
  <div class="sub">{} · 环境 {} · {} · {} 执行 · {} → {}</div>
  <div class="cards">
    <div class="card"><div class="num">{}</div><div class="label">请求总数</div></div>
    <div class="card"><div class="num" style="color:#16a34a">{}</div><div class="label">成功</div></div>
    <div class="card"><div class="num" style="color:#dc2626">{}</div><div class="label">失败</div></div>
    <div class="card"><div class="num">{} / {}</div><div class="label">断言通过 / 失败</div></div>
    <div class="card"><div class="num">{} ms</div><div class="label">总耗时</div></div>
  </div>
  {}
</div>
</body>
</html>
"#,
        esc(meta.target_name),
        esc(meta.target_name),
        esc(environment),
        esc(meta.target_type),
        esc(meta.agent),
        esc(meta.started_at),
        esc(meta.finished_at),
        summary.total,
        summary.succeeded,
        summary.failed,
        summary.tests_passed,
        summary.tests_failed,
        summary.duration_ms,
        rows
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rp_core::model::{ConsoleLogEntry, TestResult};

    fn sample_results() -> Vec<JobResult> {
        vec![
            JobResult {
                item_id: Some("i1".to_string()),
                case_id: None,
                name: "GET <用户>".to_string(),
                method: "GET".to_string(),
                url: "https://a&b".to_string(),
                ok: true,
                status: Some(200),
                status_text: Some("OK".to_string()),
                size_bytes: Some(5),
                duration_ms: Some(100),
                error: None,
                test_results: Some(vec![
                    TestResult { name: "p1".to_string(), passed: true, error: None },
                    TestResult {
                        name: "p2".to_string(),
                        passed: true,
                        error: None,
                    },
                ]),
                console_logs: Some(vec![ConsoleLogEntry {
                    level: "log".to_string(),
                    args: vec!["hi ]]> <x>".to_string()],
                }]),
                script_variables: None,
                script_globals: None,
                response_headers: None,
                response_body: None,
            },
            JobResult {
                item_id: None,
                case_id: None,
                name: "POST 创建".to_string(),
                method: "POST".to_string(),
                url: "https://c".to_string(),
                ok: false,
                status: Some(500),
                status_text: None,
                size_bytes: None,
                duration_ms: Some(50),
                error: Some("boom & <busted>".to_string()),
                test_results: Some(vec![TestResult {
                    name: "f1".to_string(),
                    passed: false,
                    error: Some("AssertionError: nope".to_string()),
                }]),
                console_logs: None,
                script_variables: None,
                script_globals: None,
                response_headers: None,
                response_body: None,
            },
        ]
    }

    fn meta() -> ReportMeta<'static> {
        ReportMeta {
            target_name: "Demo <C>",
            target_type: "collection",
            environment_name: Some("test"),
            agent: "rabbitpost-cli/0.1.0",
            started_at: "2026-01-01T00:00:00Z",
            finished_at: "2026-01-01T00:00:01Z",
        }
    }

    #[test]
    fn summarize_counts_requests_and_assertions() {
        let s = summarize(&sample_results(), 150);
        assert_eq!(s.total, 2);
        assert_eq!(s.succeeded, 1);
        assert_eq!(s.failed, 1);
        assert_eq!(s.tests_passed, 2);
        assert_eq!(s.tests_failed, 1);
        assert_eq!(s.duration_ms, 150);
    }

    #[test]
    fn junit_escapes_and_marks_failures() {
        let results = sample_results();
        let s = summarize(&results, 150);
        let xml = to_junit(&meta(), &results, &s);
        assert!(xml.contains("<testsuite name=\"Demo &lt;C&gt;\" tests=\"2\" failures=\"1\""));
        assert!(xml.contains("GET &lt;用户&gt;"));
        assert!(xml.contains("<failure message=\"boom &amp; &lt;busted&gt;\">"));
        // CDATA 中的 ]]> 必须被拆开
        assert!(!xml.replace("]]&gt;<![CDATA[", "").contains("]]>]]>"));
        assert!(xml.contains("✗ f1 — AssertionError: nope"));
        assert!(xml.ends_with("</testsuites>\n"));
    }

    #[test]
    fn html_escapes_user_content() {
        let results = sample_results();
        let s = summarize(&results, 150);
        let html = to_html(&meta(), &results, &s);
        assert!(html.contains("Demo &lt;C&gt;"));
        assert!(html.contains("boom &amp; &lt;busted&gt;"));
        assert!(!html.contains("<用户>"));
        assert!(html.contains("FAILED"), "有失败时状态为 FAILED");
        assert!(html.contains("✓") && html.contains("✗"));
    }

    #[test]
    fn esc_covers_all_xml_specials() {
        assert_eq!(esc("a<&>\"'"), "a&lt;&amp;&gt;&quot;&apos;");
    }
}

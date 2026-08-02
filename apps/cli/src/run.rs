//! run 子命令：本机执行 Collection / 单请求 -> 生成报告（JSON/HTML/JUnit）-> 可选上传。
//! 执行日志走 stderr，最终汇总 JSON 走 stdout；有用例失败时退出码为 1。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use rp_core::exec::{self, ClientPool};
use rp_core::model::{CollectionItemNode, JobResult, RequestCase, RequestConfig};
use serde_json::json;
use tokio::sync::Semaphore;

use crate::client::{agent_string, CliApi};
use crate::output::print_json;
use crate::report::{self, ReportMeta};

pub struct RunOptions {
    pub collection: Option<String>,
    pub request: Option<String>,
    pub env: Option<String>,
    pub concurrency: usize,
    pub report_formats: Vec<String>,
    pub report_dir: String,
    pub upload: bool,
}

/// 执行项元组：（显示名, itemId, caseId, 请求配置）；用例项 name 形如「接口 / 用例」
type RunItem = (String, Option<String>, Option<String>, RequestConfig);

struct Target {
    collection_id: String,
    target_type: &'static str,
    target_id: String,
    target_name: String,
    items: Vec<RunItem>,
}

/// 树先序展开（与 expandRunTarget 一致：folder 名拼 " / " 前缀）
fn expand_tree(nodes: &[CollectionItemNode]) -> Vec<(String, Option<String>, RequestConfig)> {
    fn walk(
        nodes: &[CollectionItemNode],
        prefix: &str,
        out: &mut Vec<(String, Option<String>, RequestConfig)>,
    ) {
        for node in nodes {
            if node.item_type == "folder" {
                walk(&node.children, &format!("{prefix}{} / ", node.name), out);
            } else if let Some(request) = &node.request {
                out.push((
                    format!("{prefix}{}", node.name),
                    Some(node.id.clone()),
                    request.clone(),
                ));
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, "", &mut out);
    out
}

/// 请求本身 + 其全部用例组装为最终执行计划（用例紧跟所属接口，顺序与服务端一致）
fn assemble_items(
    requests: Vec<(String, Option<String>, RequestConfig)>,
    cases: Vec<RequestCase>,
) -> Vec<RunItem> {
    // 按 itemId 分组（服务端已按 sortOrder 排序，组内保持该顺序）
    let mut by_item: HashMap<String, Vec<RequestCase>> = HashMap::new();
    for case in cases {
        by_item.entry(case.item_id.clone()).or_default().push(case);
    }
    let mut items: Vec<RunItem> = Vec::new();
    for (name, item_id, request) in requests {
        let case_rows = item_id
            .as_ref()
            .and_then(|id| by_item.remove(id))
            .unwrap_or_default();
        items.push((name.clone(), item_id.clone(), None, request));
        for case in case_rows {
            items.push((
                format!("{name} / {}", case.name),
                item_id.clone(),
                Some(case.id),
                case.request,
            ));
        }
    }
    items
}

async fn resolve_target(api: &CliApi, opts: &RunOptions) -> anyhow::Result<Target> {
    if let Some(collection_id) = &opts.collection {
        let collection = api.collection(collection_id).await?;
        let target_name = collection
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string();
        let tree: Vec<CollectionItemNode> =
            serde_json::from_value(api.collection_tree(collection_id).await?)?;
        let cases: Vec<RequestCase> =
            serde_json::from_value(api.collection_cases(collection_id).await?)?;
        let items = assemble_items(expand_tree(&tree), cases);
        if items.is_empty() {
            anyhow::bail!("collection `{target_name}` has no request to run");
        }
        return Ok(Target {
            collection_id: collection_id.clone(),
            target_type: "collection",
            target_id: collection_id.clone(),
            target_name,
            items,
        });
    }
    let request_id = opts
        .request
        .clone()
        .ok_or_else(|| anyhow::anyhow!("either --collection or --request is required"))?;
    let item = api.item(&request_id).await?;
    let collection_id = item
        .get("collectionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("item {request_id} has no collectionId"))?
        .to_string();
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let request: RequestConfig = serde_json::from_value(
        item.get("request")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("item {request_id} has no request config"))?,
    )?;
    let cases: Vec<RequestCase> =
        serde_json::from_value(api.item_cases(&request_id).await?)?;
    let items = assemble_items(
        vec![(name.clone(), Some(request_id.clone()), request)],
        cases,
    );
    Ok(Target {
        collection_id,
        target_type: "request",
        target_id: request_id,
        target_name: name,
        items,
    })
}

fn log_result(result: &JobResult) {
    let failed_tests = result
        .test_results
        .as_ref()
        .map(|tests| tests.iter().filter(|t| !t.passed).count())
        .unwrap_or_default();
    if let Some(error) = &result.error {
        eprintln!("FAIL {} {} — {}", result.method, result.name, error);
    } else if failed_tests > 0 {
        eprintln!(
            "FAIL {} {} {} — {} assertion(s) failed",
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            failed_tests
        );
    } else {
        eprintln!(
            "{} {} {} {} — {} ms",
            if result.ok { "PASS" } else { "FAIL" },
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            result.duration_ms.unwrap_or_default()
        );
    }
}

/// 返回退出码：0 全部通过，1 存在失败（报告与上传均已尽力完成）
pub async fn run(api: &CliApi, opts: &RunOptions) -> anyhow::Result<u8> {
    let target = resolve_target(api, opts).await?;

    // 环境变量（--env 指定时按 enabled 键值替换 {{var}}）
    let mut variables: HashMap<String, String> = HashMap::new();
    let mut environment_name: Option<String> = None;
    if let Some(env_id) = &opts.env {
        let env: rp_core::model::Environment =
            serde_json::from_value(api.environment(env_id).await?)?;
        environment_name = Some(env.name.clone());
        for var in env.variables {
            if var.enabled && !var.key.is_empty() {
                variables.insert(var.key, var.value);
            }
        }
    }

    let concurrency = opts.concurrency.max(1);
    eprintln!(
        "running `{}`: {} request(s), concurrency {}{}",
        target.target_name,
        target.items.len(),
        concurrency,
        environment_name
            .as_deref()
            .map(|n| format!(", env `{n}`"))
            .unwrap_or_default()
    );

    let agent = agent_string();
    let started_at = chrono::Utc::now();
    let pool = Arc::new(ClientPool::new(&agent));
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let variables = Arc::new(variables);

    let mut handles = Vec::with_capacity(target.items.len());
    for (name, item_id, case_id, request) in target.items {
        let semaphore = semaphore.clone();
        let pool = pool.clone();
        let variables = variables.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await.ok();
            let mut result = exec::execute(&pool, &name, item_id, &request, &variables).await;
            // 用例执行项：回填 caseId（报告与上传结果中标识用例行）
            result.case_id = case_id;
            log_result(&result);
            result
        }));
    }
    let mut results: Vec<JobResult> = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.await?);
    }
    let finished_at = chrono::Utc::now();
    let duration_ms = (finished_at - started_at).num_milliseconds();
    let started_iso = started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let finished_iso = finished_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let summary = report::summarize(&results, duration_ms);
    let meta = ReportMeta {
        target_name: &target.target_name,
        target_type: target.target_type,
        environment_name: environment_name.as_deref(),
        agent: &agent,
        started_at: &started_iso,
        finished_at: &finished_iso,
    };

    // 标准 JSON 报告：本地落盘与上传共用同一份结构
    let report_json = json!({
        "format": "rabbitpost.run-report",
        "version": 1,
        "agent": agent,
        "collectionId": target.collection_id,
        "targetType": target.target_type,
        "targetId": target.target_id,
        "targetName": target.target_name,
        "environmentId": opts.env,
        "environmentName": environment_name,
        "concurrency": concurrency,
        "startedAt": started_iso,
        "finishedAt": finished_iso,
        "summary": {
            "total": summary.total,
            "succeeded": summary.succeeded,
            "failed": summary.failed,
            "testsPassed": summary.tests_passed,
            "testsFailed": summary.tests_failed,
            "durationMs": summary.duration_ms,
        },
        "results": results,
    });

    // 写报告文件
    let stamp = started_at.format("%Y%m%d-%H%M%S");
    let mut written: Vec<(String, String)> = Vec::new();
    for format in &opts.report_formats {
        let (ext, content) = match format.as_str() {
            "json" => ("json", serde_json::to_string_pretty(&report_json)?),
            "html" => ("html", report::to_html(&meta, &results, &summary)),
            "junit" => ("xml", report::to_junit(&meta, &results, &summary)),
            other => {
                eprintln!("unknown report format `{other}`, skipped (expect json/html/junit)");
                continue;
            }
        };
        let dir = PathBuf::from(&opts.report_dir);
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join(format!("rabbitpost-run-{stamp}.{ext}"));
        tokio::fs::write(&path, content).await?;
        eprintln!("report written: {}", path.display());
        written.push((format.clone(), path.display().to_string()));
    }

    // 上传执行报告
    let mut upload: Option<serde_json::Value> = None;
    if opts.upload {
        let job = api
            .upload_report(&target.collection_id, &report_json)
            .await?;
        eprintln!("report uploaded: run job {}", job.id);
        upload = Some(json!({
            "jobId": job.id,
            "status": job.status,
        }));
    }

    print_json(&json!({
        "target": {
            "type": target.target_type,
            "id": target.target_id,
            "name": target.target_name,
            "collectionId": target.collection_id,
        },
        "summary": report_json["summary"],
        "reports": written.into_iter().map(|(format, path)| json!({ "format": format, "path": path })).collect::<Vec<_>>(),
        "upload": upload,
    }));

    Ok(if summary.failed > 0 { 1 } else { 0 })
}

/// report upload --file：上传此前落盘的 JSON 报告
pub async fn upload_existing(api: &CliApi, file: &str) -> anyhow::Result<()> {
    let text = tokio::fs::read_to_string(file).await?;
    let report: serde_json::Value = serde_json::from_str(&text)?;
    if report.get("format").and_then(|f| f.as_str()) != Some("rabbitpost.run-report") {
        anyhow::bail!("not a RabbitPost run report: {file} (missing format marker)");
    }
    let collection_id = report
        .get("collectionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("report has no collectionId: {file}"))?
        .to_string();
    let job = api.upload_report(&collection_id, &report).await?;
    print_json(&json!({
        "uploaded": true,
        "jobId": job.id,
        "status": job.status,
        "collectionId": collection_id,
    }));
    Ok(())
}

// ---------------------------------------------------------------------------
// 单元测试：用例组装逻辑（请求 + 用例的执行计划顺序与字段映射）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn case(id: &str, item_id: &str, name: &str, sort_order: i64) -> RequestCase {
        RequestCase {
            id: id.to_string(),
            item_id: item_id.to_string(),
            name: name.to_string(),
            description: None,
            sort_order,
            request: RequestConfig::default(),
        }
    }

    #[test]
    fn assemble_items_appends_cases_after_their_request() {
        let requests = vec![
            (
                "f / r1".to_string(),
                Some("i1".to_string()),
                RequestConfig::default(),
            ),
            (
                "r2".to_string(),
                Some("i2".to_string()),
                RequestConfig::default(),
            ),
        ];
        let cases = vec![
            case("c2", "i1", "case B", 1),
            case("c1", "i1", "case A", 0),
            case("c3", "i2", "case C", 0),
        ];
        let items = assemble_items(requests, cases);
        let names: Vec<&str> = items.iter().map(|(n, _, _, _)| n.as_str()).collect();
        // 用例紧跟所属接口，且保持服务端给的顺序（此处输入即 sortOrder 序）
        assert_eq!(
            names,
            ["f / r1", "f / r1 / case B", "f / r1 / case A", "r2", "r2 / case C"]
        );
        // 请求本身 caseId 为 None；用例行带 caseId 且 itemId 指向所属接口
        assert!(items[0].2.is_none());
        assert_eq!(items[1].1.as_deref(), Some("i1"));
        assert_eq!(items[1].2.as_deref(), Some("c2"));
        assert_eq!(items[4].2.as_deref(), Some("c3"));
    }

    #[test]
    fn assemble_items_tolerates_cases_without_matching_request() {
        // 数据不一致（用例的接口已不在树中）：孤儿用例直接丢弃，不阻塞执行
        let requests = vec![(
            "r1".to_string(),
            Some("i1".to_string()),
            RequestConfig::default(),
        )];
        let cases = vec![case("c9", "ghost", "orphan", 0)];
        let items = assemble_items(requests, cases);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "r1");
    }
}

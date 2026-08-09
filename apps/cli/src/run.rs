//! run 子命令：本机执行 Collection / 单请求 / 本地 Collection 文件
//! -> 生成报告（JSON/HTML/JUnit）-> 可选上传。
//! 执行日志走 stderr，最终汇总 JSON 走 stdout；有用例失败时退出码为 1。
//!
//! 对齐 Postman CLI / newman 的运行选项：--env-file / --env-var / --globals /
//! --global-var / --folder / --iteration-count / --iteration-data / --bail /
//! --suppress-exit-code / --delay-request / --timeout-request / --insecure /
//! --silent / --export-environment / --export-globals / --cookie-jar /
//! --export-cookie-jar。
//! 变量优先级（低 -> 高）：globals（--globals）< Collection 变量
//! < 环境（--env / --env-file）< 迭代数据行（--iteration-data）
//! < 命令行覆盖（--env-var / --global-var）。
//! 脚本对 rp.environment / rp.variables / rp.globals 的改动在同一 run 内向后续
//! 请求传递（并发 >1 时按完成顺序合并，同键后完成者覆盖），并可随 --export-* 落盘。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rp_core::cookies::CookieJar;
use rp_core::exec::{self, ClientPool, ExecContext};
use rp_core::model::{CollectionItemNode, JobResult, RequestCase, RequestConfig};
use serde_json::json;
use tokio::sync::Semaphore;

use crate::client::{agent_string, CliApi};
use crate::convert::{self, ImportedNode};
use crate::output::print_json;
use crate::report::{self, ReportMeta};

pub struct RunOptions {
    pub collection: Option<String>,
    pub request: Option<String>,
    /// 本地 Collection 文件（rabbitpost.collection / Postman v2.1）
    pub file: Option<String>,
    pub env: Option<String>,
    /// 本地环境文件（Postman 环境导出 / RabbitPost 环境 / 扁平 kv）
    pub env_file: Option<String>,
    /// 本地 globals 文件（Postman globals 导出 / 扁平 kv），优先级最低
    pub globals_file: Option<String>,
    /// KEY=VALUE 覆盖（最高优先级）
    pub env_vars: Vec<String>,
    /// KEY=VALUE 全局变量（globals 作用域；替换时与 --env-var 同级最高优先）
    pub global_vars: Vec<String>,
    /// 只跑指定文件夹（名称或 "A / B" 路径，可多次）
    pub folders: Vec<String>,
    /// 只跑指定名称的请求（叶子请求名，可多次）
    pub request_names: Vec<String>,
    pub iteration_count: Option<usize>,
    pub iteration_data: Option<String>,
    /// 首个失败后停止（隐含顺序执行）
    pub bail: bool,
    /// 用例失败也返回 0（CI 只关心报告时）
    pub suppress_exit_code: bool,
    /// 每个请求前的固定延迟（毫秒）
    pub delay_request_ms: u64,
    /// 覆盖请求级超时（毫秒；0 表示不超时）
    pub timeout_request_ms: Option<u64>,
    /// 覆盖脚本超时（毫秒；0/缺省为引擎默认 5s）
    pub timeout_script_ms: Option<u64>,
    /// 跳过 TLS 证书校验
    pub insecure: bool,
    /// 不输出逐请求日志（保留汇总）
    pub silent: bool,
    /// 输出逐请求详情（URL / 状态 / 响应头 / 响应体截断 / 断言明细）
    pub verbose: bool,
    /// 日志着色：auto / always / never
    pub color: String,
    /// 显式报告导出路径（与 --report 并存；newman --reporter-*-export 用法）
    pub reporter_json_export: Option<String>,
    pub reporter_html_export: Option<String>,
    pub reporter_junit_export: Option<String>,
    /// 相对输入文件（--file/--env-file/--globals/-d/--cookie-jar）的解析基准目录
    pub working_dir: Option<String>,
    /// 禁止读取工作目录之外的文件
    pub no_insecure_file_read: bool,
    /// 数据库连接，NAME=URL，可多次（类型按 URL scheme 推导；密码写在 URL 里）
    pub db_connections: Vec<String>,
    /// 数据库连接文件（JSON 数组，ResolvedDbConnection 形态：[{name, config, password?}]）
    pub db_connections_file: Option<String>,
    /// 运行结束后导出最终环境变量（含脚本改动，Postman 环境格式）
    pub export_environment: Option<String>,
    /// 运行结束后导出最终 globals（含 rp.globals.set 改动，Postman globals 格式）
    pub export_globals: Option<String>,
    /// 加载 Cookie Jar 文件（Postman cookie 导出 / 极简数组）
    pub cookie_jar: Option<String>,
    /// 运行结束后导出 Cookie Jar
    pub export_cookie_jar: Option<String>,
    pub concurrency: usize,
    pub report_formats: Vec<String>,
    pub report_dir: String,
    pub upload: bool,
}

/// 执行项元组：（显示名, 文件夹路径, itemId, caseId, 请求配置）；用例项 name 形如「接口 / 用例」
type RunItem = (String, String, Option<String>, Option<String>, RequestConfig);

struct Target {
    /// 服务端 Collection id；本地文件运行时为 None（不能上传报告）
    collection_id: Option<String>,
    target_type: &'static str,
    target_id: String,
    target_name: String,
    /// Collection 级变量（enabled 且 key 非空）
    collection_variables: Vec<(String, String)>,
    items: Vec<RunItem>,
}

/// 树先序展开（与 expandRunTarget 一致：folder 名拼 " / " 前缀）
fn expand_tree(nodes: &[CollectionItemNode]) -> Vec<(String, String, Option<String>, RequestConfig)> {
    fn walk(
        nodes: &[CollectionItemNode],
        prefix: &str,
        out: &mut Vec<(String, String, Option<String>, RequestConfig)>,
    ) {
        for node in nodes {
            if node.item_type == "folder" {
                walk(&node.children, &format!("{prefix}{} / ", node.name), out);
            } else if let Some(request) = &node.request {
                let folder_path = prefix.strip_suffix(" / ").unwrap_or(prefix).to_string();
                out.push((
                    format!("{prefix}{}", node.name),
                    folder_path,
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

/// 导入文件节点树先序展开（与 expand_tree 同样的命名规则；条目没有服务端 id）
fn expand_imported(nodes: &[ImportedNode]) -> Vec<(String, String, Option<String>, RequestConfig)> {
    fn walk(
        nodes: &[ImportedNode],
        prefix: &str,
        out: &mut Vec<(String, String, Option<String>, RequestConfig)>,
    ) {
        for node in nodes {
            match node {
                ImportedNode::Folder { name, items, .. } => {
                    walk(items, &format!("{prefix}{name} / "), out);
                }
                ImportedNode::Request { name, request } => {
                    if let Some(request) = request {
                        let folder_path = prefix.strip_suffix(" / ").unwrap_or(prefix).to_string();
                        out.push((
                            format!("{prefix}{name}"),
                            folder_path,
                            None,
                            (**request).clone(),
                        ));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, "", &mut out);
    out
}

/// --folder 过滤：匹配文件夹路径的任意一段，或完整 "A / B" 路径
fn folder_matches(folder_path: &str, filters: &[String]) -> bool {
    if filters.is_empty() {
        return true;
    }
    if folder_path.is_empty() {
        return false;
    }
    filters.iter().any(|f| {
        f == folder_path || folder_path.split(" / ").any(|segment| segment == f.trim())
    })
}

/// 显示名（"A / B / 请求"）的叶子名（请求本身的名字）
fn leaf_name(display: &str) -> &str {
    display.rsplit(" / ").next().unwrap_or(display)
}

/// 请求本身 + 其全部用例组装为最终执行计划（用例紧跟所属接口，顺序与服务端一致）。
/// folders / request_names 过滤对整个接口生效（其用例一并跳过）。
fn assemble_items(
    requests: Vec<(String, String, Option<String>, RequestConfig)>,
    cases: Vec<RequestCase>,
    folders: &[String],
    request_names: &[String],
) -> Vec<RunItem> {
    // 按 itemId 分组（服务端已按 sortOrder 排序，组内保持该顺序）
    let mut by_item: HashMap<String, Vec<RequestCase>> = HashMap::new();
    for case in cases {
        by_item.entry(case.item_id.clone()).or_default().push(case);
    }
    let mut items: Vec<RunItem> = Vec::new();
    for (name, folder_path, item_id, request) in requests {
        let case_rows = item_id
            .as_ref()
            .and_then(|id| by_item.remove(id))
            .unwrap_or_default();
        if !folder_matches(&folder_path, folders) {
            continue;
        }
        if !request_names.is_empty() && !request_names.iter().any(|n| n == leaf_name(&name)) {
            continue;
        }
        items.push((
            name.clone(),
            folder_path.clone(),
            item_id.clone(),
            None,
            request,
        ));
        for case in case_rows {
            items.push((
                format!("{name} / {}", case.name),
                folder_path.clone(),
                item_id.clone(),
                Some(case.id),
                case.request,
            ));
        }
    }
    items
}

/// 从服务端 Collection JSON 里取启用的集合级变量
fn collection_variables(collection: &serde_json::Value) -> Vec<(String, String)> {
    collection
        .get("variables")
        .and_then(|v| v.as_array())
        .map(|vars| {
            vars.iter()
                .filter(|v| {
                    v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)
                        && v.get("key").and_then(|k| k.as_str()).is_some_and(|k| !k.is_empty())
                })
                .map(|v| {
                    (
                        v.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
                        v.get("value").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn resolve_target(
    api: &CliApi,
    opts: &RunOptions,
    file: Option<&str>,
) -> anyhow::Result<Target> {
    if let Some(file) = file {
        let text = tokio::fs::read_to_string(file)
            .await
            .map_err(|e| anyhow::anyhow!("cannot read collection file {file}: {e}"))?;
        let imported = convert::parse_collection(&text)?;
        let items = assemble_items(
            expand_imported(&imported.items),
            Vec::new(),
            &opts.folders,
            &opts.request_names,
        );
        if items.is_empty() {
            anyhow::bail!("collection file `{}` has no request to run", imported.name);
        }
        let variables = imported
            .variables
            .iter()
            .filter(|v| v.enabled && !v.key.is_empty())
            .map(|v| (v.key.clone(), v.value.clone()))
            .collect();
        return Ok(Target {
            collection_id: None,
            target_type: "file",
            target_id: file.to_string(),
            target_name: imported.name,
            collection_variables: variables,
            items,
        });
    }

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
        let items = assemble_items(expand_tree(&tree), cases, &opts.folders, &opts.request_names);
        if items.is_empty() {
            anyhow::bail!("collection `{target_name}` has no request to run");
        }
        return Ok(Target {
            collection_id: Some(collection_id.clone()),
            target_type: "collection",
            target_id: collection_id.clone(),
            target_name,
            collection_variables: collection_variables(&collection),
            items,
        });
    }

    let request_id = opts
        .request
        .clone()
        .ok_or_else(|| anyhow::anyhow!("one of --collection / --request / --file is required"))?;
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
        vec![(name.clone(), String::new(), Some(request_id.clone()), request)],
        cases,
        &opts.folders,
        &opts.request_names,
    );
    Ok(Target {
        collection_id: Some(collection_id),
        target_type: "request",
        target_id: request_id,
        target_name: name,
        collection_variables: Vec::new(),
        items,
    })
}

/// 解析 KEY=VALUE 对（--env-var / --global-var 共用）
fn parse_kv_pairs(pairs: &[String], flag: &str) -> anyhow::Result<Vec<(String, String)>> {
    pairs
        .iter()
        .map(|pair| {
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| anyhow::anyhow!("invalid {flag} `{pair}`: expected KEY=VALUE"))?;
            if key.is_empty() {
                anyhow::bail!("invalid {flag} `{pair}`: key is empty");
            }
            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

/// 变量解析结果：base 已并入 globals（最低优先级），globals 单独保留给沙箱作用域与导出
struct ResolvedVars {
    /// globals + Collection 变量 + 环境（低 -> 高）
    base: HashMap<String, String>,
    /// --env-var + --global-var（最高优先级，迭代行不得覆盖）
    overrides: Vec<(String, String)>,
    /// globals 文件 + --global-var（沙箱 rp.globals 作用域）
    globals: HashMap<String, String>,
    environment_name: Option<String>,
}

/// globals（--globals / --global-var）< Collection 变量 < 环境（--env / --env-file）
/// < 迭代数据行 < 命令行覆盖（--env-var / --global-var）。
async fn resolve_variables(
    api: &CliApi,
    opts: &RunOptions,
    env_file: Option<&str>,
    globals_file: Option<&str>,
    collection_vars: &[(String, String)],
) -> anyhow::Result<ResolvedVars> {
    // globals 作用域：文件 + 命令行
    let mut globals: HashMap<String, String> = HashMap::new();
    if let Some(globals_file) = globals_file {
        let text = tokio::fs::read_to_string(globals_file)
            .await
            .map_err(|e| anyhow::anyhow!("cannot read globals file {globals_file}: {e}"))?;
        let (_name, vars) = convert::parse_environment_file(&text)?;
        for (key, value) in vars {
            globals.insert(key, value);
        }
    }
    for (key, value) in parse_kv_pairs(&opts.global_vars, "--global-var")? {
        globals.insert(key, value);
    }

    // base：globals 垫底，其上 Collection 变量与环境
    let mut variables: HashMap<String, String> = globals.clone();
    variables.extend(collection_vars.iter().cloned());
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
    } else if let Some(env_file) = env_file {
        let text = tokio::fs::read_to_string(env_file)
            .await
            .map_err(|e| anyhow::anyhow!("cannot read environment file {env_file}: {e}"))?;
        let (name, vars) = convert::parse_environment_file(&text)?;
        environment_name = name;
        for (key, value) in vars {
            variables.insert(key, value);
        }
    }

    let mut overrides = parse_kv_pairs(&opts.env_vars, "--env-var")?;
    overrides.extend(parse_kv_pairs(&opts.global_vars, "--global-var")?);
    Ok(ResolvedVars {
        base: variables,
        overrides,
        globals,
        environment_name,
    })
}

/// 迭代计划：--iteration-data 给出行，--iteration-count 决定轮数（缺省为行数）；
/// 轮数多于行数时循环取行。无迭代数据时按 iteration-count（缺省 1）重复。
fn resolve_iterations(
    data_file: Option<&str>,
    iteration_count: Option<usize>,
) -> anyhow::Result<Vec<HashMap<String, String>>> {
    let rows: Vec<HashMap<String, String>> = match data_file {
        Some(file) => {
            let text = std::fs::read_to_string(file)
                .map_err(|e| anyhow::anyhow!("cannot read iteration data {file}: {e}"))?;
            convert::parse_iteration_data(&text)?
        }
        None => Vec::new(),
    };
    let count = iteration_count.unwrap_or_else(|| rows.len().max(1));
    if count == 0 {
        anyhow::bail!("--iteration-count must be at least 1");
    }
    let iterations = (0..count)
        .map(|i| {
            if rows.is_empty() {
                HashMap::new()
            } else {
                rows[i % rows.len()].clone()
            }
        })
        .collect();
    Ok(iterations)
}

fn log_result(result: &JobResult, color: bool) {
    let (pass, fail) = if color {
        ("\x1b[32mPASS\x1b[0m", "\x1b[31mFAIL\x1b[0m")
    } else {
        ("PASS", "FAIL")
    };
    let failed_tests = result
        .test_results
        .as_ref()
        .map(|tests| tests.iter().filter(|t| !t.passed).count())
        .unwrap_or_default();
    if let Some(error) = &result.error {
        eprintln!("{fail} {} {} — {}", result.method, result.name, error);
    } else if failed_tests > 0 {
        eprintln!(
            "{fail} {} {} {} — {} assertion(s) failed",
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            failed_tests
        );
    } else {
        eprintln!(
            "{} {} {} {} — {} ms",
            if result.ok { pass } else { fail },
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            result.duration_ms.unwrap_or_default()
        );
    }
}

/// --verbose：逐请求详情（请求行 / 状态行 / 响应头 / 响应体截断 / console / 失败断言）
fn log_verbose(result: &JobResult) {
    eprintln!("  -> {} {}", result.method, result.url);
    eprintln!(
        "  <- {} {} ({} ms, {} B)",
        result.status.map(|s| s.to_string()).unwrap_or_default(),
        result.status_text.as_deref().unwrap_or_default(),
        result.duration_ms.unwrap_or_default(),
        result.size_bytes.unwrap_or_default()
    );
    if let Some(headers) = &result.response_headers {
        let mut names: Vec<&String> = headers.keys().collect();
        names.sort();
        for name in names {
            eprintln!("     {name}: {}", headers[name]);
        }
    }
    if let Some(body) = &result.response_body {
        let truncated: String = body.chars().take(4096).collect();
        eprintln!("     {truncated}");
        if body.chars().count() > 4096 {
            eprintln!("     ... (truncated, {} chars total)", body.chars().count());
        }
    }
    if let Some(logs) = &result.console_logs {
        for entry in logs {
            eprintln!("     console.{}: {}", entry.level, entry.args.join(" "));
        }
    }
    if let Some(tests) = &result.test_results {
        for test in tests.iter().filter(|t| !t.passed) {
            eprintln!(
                "     assertion failed: {} — {}",
                test.name,
                test.error.as_deref().unwrap_or_default()
            );
        }
    }
}

/// 跨请求共享的运行状态：脚本改动按完成顺序合并（同键后完成者覆盖）
struct SharedState {
    vars: HashMap<String, String>,
    globals: HashMap<String, String>,
}

/// 一次执行所需的共享上下文（并发任务间共享）
struct RunShared {
    state: Mutex<SharedState>,
    rows: Vec<HashMap<String, String>>,
    overrides: Vec<(String, String)>,
    jar: Option<CookieJar>,
    db_connections: Vec<rp_core::model::ResolvedDbConnection>,
    multi_iteration: bool,
}

/// 把脚本执行后的完整变量表以 diff 形式回填到共享状态：
/// 值变化/新增 -> 覆盖；键消失（rp.*.unset）-> 删除。未改动的键不动，
/// 避免迭代行/命令行覆盖被错误地烘进基础变量。
fn merge_mutations(
    shared: &mut HashMap<String, String>,
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) {
    for (key, value) in after {
        if before.get(key) != Some(value) {
            shared.insert(key.clone(), value.clone());
        }
    }
    for key in before.keys() {
        if !after.contains_key(key) {
            shared.remove(key);
        }
    }
}

/// 单个请求的执行级选项（Copy，便于传入并发任务）
#[derive(Debug, Clone, Copy)]
struct ExecOpts {
    timeout_ms: Option<u64>,
    script_timeout_ms: Option<u64>,
    insecure: bool,
    silent: bool,
    verbose: bool,
    color: bool,
}

/// 执行单个计划项：取共享变量快照（叠加迭代行与命令行覆盖）-> 执行 -> 回填脚本改动
async fn execute_one(
    pool: &ClientPool,
    shared: &RunShared,
    exec_opts: ExecOpts,
    iteration: usize,
    item: RunItem,
) -> JobResult {
    let (name, _folder_path, item_id, case_id, mut request) = item;
    // --timeout-request / --insecure 覆盖（基于请求自身设置）
    if let Some(timeout) = exec_opts.timeout_ms {
        request.settings.timeout_ms = timeout;
    }
    if exec_opts.insecure {
        request.settings.verify_ssl = false;
    }

    let (mut variables, globals) = {
        let state = shared.state.lock().unwrap();
        (state.vars.clone(), state.globals.clone())
    };
    for (key, value) in &shared.rows[iteration] {
        variables.insert(key.clone(), value.clone());
    }
    for (key, value) in &shared.overrides {
        variables.insert(key.clone(), value.clone());
    }
    let name = if shared.multi_iteration {
        format!("{name} (iteration {})", iteration + 1)
    } else {
        name
    };

    let ctx = ExecContext {
        globals: Some(&globals),
        jar: shared.jar.as_ref(),
        script_timeout_ms: exec_opts.script_timeout_ms,
        db_connections: Some(&shared.db_connections),
    };
    let mut result = exec::execute_with(pool, &ctx, &name, item_id, &request, &variables).await;
    // 用例执行项：回填 caseId（报告与上传结果中标识用例行）
    result.case_id = case_id;

    {
        let mut state = shared.state.lock().unwrap();
        if let Some(after) = &result.script_variables {
            merge_mutations(&mut state.vars, &variables, after);
        }
        if let Some(after) = &result.script_globals {
            merge_mutations(&mut state.globals, &globals, after);
        }
    }
    if !exec_opts.silent {
        log_result(&result, exec_opts.color);
    }
    if exec_opts.verbose {
        log_verbose(&result);
    }
    result
}

/// 导出 Postman 环境 / globals 文件（values 数组形态，两种格式同构）
fn write_scope_file(path: &str, name: &str, scope: &str, vars: &HashMap<String, String>) -> anyhow::Result<()> {
    let mut entries: Vec<&String> = vars.keys().collect();
    entries.sort();
    let values: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|key| json!({ "key": key, "value": vars[key], "enabled": true }))
        .collect();
    let file = json!({
        "name": name,
        "values": values,
        "_postman_variable_scope": scope,
    });
    std::fs::write(path, serde_json::to_string_pretty(&file)?)?;
    eprintln!("{scope} exported: {path}");
    Ok(())
}

/// 解析输入文件路径：相对路径基于 --working-dir（缺省当前目录）；
/// --no-insecure-file-read 时拒绝解析到工作目录之外的路径
fn resolve_read_path(path: Option<&str>, opts: &RunOptions) -> anyhow::Result<Option<String>> {
    let Some(path) = path else { return Ok(None) };
    let raw = std::path::Path::new(path);
    let base = match &opts.working_dir {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::current_dir()?,
    };
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        base.join(raw)
    };
    if opts.no_insecure_file_read {
        let canon_base = base
            .canonicalize()
            .map_err(|e| anyhow::anyhow!("invalid working directory {}: {e}", base.display()))?;
        let canon = joined
            .canonicalize()
            .map_err(|e| anyhow::anyhow!("cannot read {path}: {e}"))?;
        if !canon.starts_with(&canon_base) {
            anyhow::bail!("--no-insecure-file-read: `{path}` is outside the working directory");
        }
        return Ok(Some(canon.to_string_lossy().into_owned()));
    }
    Ok(Some(joined.to_string_lossy().into_owned()))
}

/// 解析数据库连接：--db-connections-file 的 JSON 数组垫底，--db-connection NAME=URL 覆盖同名。
/// 服务端 /db-connections 不回传密码（write-only），CLI 只能由本机参数/文件提供完整连接。
fn resolve_db_connections(
    opts: &RunOptions,
    file: Option<&str>,
) -> anyhow::Result<Vec<rp_core::model::ResolvedDbConnection>> {
    let mut connections: Vec<rp_core::model::ResolvedDbConnection> = Vec::new();
    if let Some(path) = file {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("cannot read db connections file {path}: {e}"))?;
        connections = serde_json::from_str(&text)
            .map_err(|e| anyhow::anyhow!("invalid db connections file {path}: {e}"))?;
    }
    for flag in &opts.db_connections {
        let (name, url) = flag.split_once('=').ok_or_else(|| {
            anyhow::anyhow!("invalid --db-connection `{flag}`: expected NAME=URL")
        })?;
        if name.is_empty() {
            anyhow::bail!("invalid --db-connection `{flag}`: name is empty");
        }
        let scheme = url.split("://").next().unwrap_or_default();
        let conn_type = match scheme {
            "mysql" => "mysql",
            "postgres" | "postgresql" => "postgres",
            "sqlite" => "sqlite",
            "redis" | "rediss" => "redis",
            other => anyhow::bail!(
                "invalid --db-connection `{flag}`: unsupported scheme `{other}` \
                 (expect mysql/postgres/sqlite/redis)"
            ),
        };
        let connection = rp_core::model::ResolvedDbConnection {
            name: name.to_string(),
            config: rp_core::model::DbConnectionConfig {
                conn_type: conn_type.to_string(),
                connection_string: Some(url.to_string()),
                ..Default::default()
            },
            password: None,
        };
        // 同名覆盖（文件定义的同名连接被命令行替换）
        connections.retain(|c| c.name != name);
        connections.push(connection);
    }
    Ok(connections)
}

/// 返回退出码：0 全部通过，1 存在失败（--suppress-exit-code 时恒为 0）
pub async fn run(api: &CliApi, opts: &RunOptions) -> anyhow::Result<u8> {
    // 输入文件路径统一先解析（--working-dir / --no-insecure-file-read）
    let file = resolve_read_path(opts.file.as_deref(), opts)?;
    let env_file = resolve_read_path(opts.env_file.as_deref(), opts)?;
    let globals_file = resolve_read_path(opts.globals_file.as_deref(), opts)?;
    let iteration_data_file = resolve_read_path(opts.iteration_data.as_deref(), opts)?;
    let cookie_jar_file = resolve_read_path(opts.cookie_jar.as_deref(), opts)?;
    let db_connections_file = resolve_read_path(opts.db_connections_file.as_deref(), opts)?;
    let db_connections = resolve_db_connections(opts, db_connections_file.as_deref())?;

    let target = resolve_target(api, opts, file.as_deref()).await?;
    let resolved =
        resolve_variables(api, opts, env_file.as_deref(), globals_file.as_deref(), &target.collection_variables).await?;
    let environment_name = resolved.environment_name.clone();
    let iterations = resolve_iterations(iteration_data_file.as_deref(), opts.iteration_count)?;

    // Cookie Jar：--cookie-jar 加载，或任一 cookie 选项存在时建空 Jar
    let jar: Option<CookieJar> = match &cookie_jar_file {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("cannot read cookie jar {path}: {e}"))?;
            Some(CookieJar::load_json(&text)?)
        }
        None => {
            if opts.export_cookie_jar.is_some() {
                Some(CookieJar::new())
            } else {
                None
            }
        }
    };

    let concurrency = if opts.bail {
        1 // --bail 需要确定性顺序，隐含顺序执行
    } else {
        opts.concurrency.max(1)
    };
    eprintln!(
        "running `{}`: {} request(s) x {} iteration(s), concurrency {}{}",
        target.target_name,
        target.items.len(),
        iterations.len(),
        concurrency,
        environment_name
            .as_deref()
            .map(|n| format!(", env `{n}`"))
            .unwrap_or_default()
    );

    let agent = agent_string();
    let started_at = chrono::Utc::now();
    let pool = Arc::new(ClientPool::new(&agent));

    // 展开执行计划：（迭代号, 执行项）；多轮迭代时结果名带 (iteration N) 便于区分
    let multi_iteration = iterations.len() > 1;
    let mut plan: Vec<(usize, RunItem)> =
        Vec::with_capacity(target.items.len() * iterations.len());
    for iteration in 0..iterations.len() {
        for item in &target.items {
            plan.push((iteration, item.clone()));
        }
    }
    let shared = Arc::new(RunShared {
        state: Mutex::new(SharedState {
            vars: resolved.base,
            globals: resolved.globals,
        }),
        rows: iterations,
        overrides: resolved.overrides,
        jar,
        db_connections,
        multi_iteration,
    });

    let mut results: Vec<JobResult> = Vec::with_capacity(plan.len());
    let color = match opts.color.as_str() {
        "always" => true,
        "never" => false,
        "auto" => std::io::IsTerminal::is_terminal(&std::io::stderr()),
        other => anyhow::bail!("invalid --color `{other}`: expect auto / always / never"),
    };
    let exec_opts = ExecOpts {
        timeout_ms: opts.timeout_request_ms,
        script_timeout_ms: opts.timeout_script_ms,
        insecure: opts.insecure,
        silent: opts.silent,
        verbose: opts.verbose,
        color,
    };
    if opts.bail {
        // 顺序执行，首个失败即停（后续项标记跳过，不进报告）
        let total = plan.len();
        for (index, (iteration, item)) in plan.into_iter().enumerate() {
            if opts.delay_request_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(opts.delay_request_ms)).await;
            }
            let result = execute_one(&pool, &shared, exec_opts, iteration, item).await;
            let failed = !result.ok;
            results.push(result);
            if failed {
                let skipped = total - index - 1;
                if skipped > 0 {
                    eprintln!("bail: stopped after first failure ({skipped} item(s) skipped)");
                }
                break;
            }
        }
    } else {
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let delay_ms = opts.delay_request_ms;
        let mut handles = Vec::with_capacity(plan.len());
        for (iteration, item) in plan {
            let semaphore = semaphore.clone();
            let pool = pool.clone();
            let shared = shared.clone();
            handles.push(tokio::spawn(async move {
                let _permit = semaphore.acquire().await.ok();
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                execute_one(&pool, &shared, exec_opts, iteration, item).await
            }));
        }
        for handle in handles {
            results.push(handle.await?);
        }
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
        "iterations": shared.rows.len(),
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

    // 显式导出路径（newman --reporter-*-export 用法：与 --report 产物并存）
    let explicit_exports: [(&Option<String>, &str); 3] = [
        (&opts.reporter_json_export, "json"),
        (&opts.reporter_html_export, "html"),
        (&opts.reporter_junit_export, "junit"),
    ];
    for (path, format) in explicit_exports {
        let Some(path) = path else { continue };
        let content = match format {
            "json" => serde_json::to_string_pretty(&report_json)?,
            "html" => report::to_html(&meta, &results, &summary),
            _ => report::to_junit(&meta, &results, &summary),
        };
        tokio::fs::write(path, content).await?;
        eprintln!("report written: {path}");
        written.push((format.to_string(), path.clone()));
    }

    // 上传执行报告（本地文件运行没有服务端 Collection，无法挂到 Runs tab）
    let mut upload: Option<serde_json::Value> = None;
    if opts.upload {
        match &target.collection_id {
            Some(collection_id) => {
                let job = api.upload_report(collection_id, &report_json).await?;
                eprintln!("report uploaded: run job {}", job.id);
                upload = Some(json!({
                    "jobId": job.id,
                    "status": job.status,
                }));
            }
            None => {
                eprintln!("upload skipped: --file runs are not attached to a server collection");
            }
        }
    }

    // 导出最终变量 / Cookie Jar（在报告与上传之后，串行收尾）
    let mut exports: Vec<serde_json::Value> = Vec::new();
    {
        let state = shared.state.lock().unwrap();
        if let Some(path) = &opts.export_environment {
            // 环境导出剔除 globals 作用域中未变更的键（globals 有独立导出通道）
            let mut env_vars = state.vars.clone();
            for (key, value) in &state.globals {
                if env_vars.get(key) == Some(value) {
                    env_vars.remove(key);
                }
            }
            let name = environment_name.as_deref().unwrap_or("environment");
            write_scope_file(path, name, "environment", &env_vars)?;
            exports.push(json!({ "type": "environment", "path": path }));
        }
        if let Some(path) = &opts.export_globals {
            write_scope_file(path, "globals", "globals", &state.globals)?;
            exports.push(json!({ "type": "globals", "path": path }));
        }
    }
    if let (Some(path), Some(jar)) = (&opts.export_cookie_jar, &shared.jar) {
        std::fs::write(path, jar.to_json())?;
        eprintln!("cookie jar exported: {path}");
        exports.push(json!({ "type": "cookie-jar", "path": path }));
    }

    print_json(&json!({
        "target": {
            "type": target.target_type,
            "id": target.target_id,
            "name": target.target_name,
            "collectionId": target.collection_id,
        },
        "summary": report_json["summary"],
        "iterations": shared.rows.len(),
        "reports": written.into_iter().map(|(format, path)| json!({ "format": format, "path": path })).collect::<Vec<_>>(),
        "exports": exports,
        "upload": upload,
    }));

    let failed = summary.failed > 0;
    Ok(if failed && !opts.suppress_exit_code {
        1
    } else {
        0
    })
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
// 单元测试：用例组装 / 过滤 / 迭代计划
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

    fn req(name: &str, folder: &str, item_id: &str) -> (String, String, Option<String>, RequestConfig) {
        (
            name.to_string(),
            folder.to_string(),
            Some(item_id.to_string()),
            RequestConfig::default(),
        )
    }

    #[test]
    fn assemble_items_appends_cases_after_their_request() {
        let requests = vec![req("f / r1", "f", "i1"), req("r2", "", "i2")];
        let cases = vec![
            case("c2", "i1", "case B", 1),
            case("c1", "i1", "case A", 0),
            case("c3", "i2", "case C", 0),
        ];
        let items = assemble_items(requests, cases, &[], &[]);
        let names: Vec<&str> = items.iter().map(|(n, _, _, _, _)| n.as_str()).collect();
        // 用例紧跟所属接口，且保持服务端给的顺序（此处输入即 sortOrder 序）
        assert_eq!(
            names,
            ["f / r1", "f / r1 / case B", "f / r1 / case A", "r2", "r2 / case C"]
        );
        // 请求本身 caseId 为 None；用例行带 caseId 且 itemId 指向所属接口
        assert!(items[0].3.is_none());
        assert_eq!(items[1].2.as_deref(), Some("i1"));
        assert_eq!(items[1].3.as_deref(), Some("c2"));
        assert_eq!(items[4].3.as_deref(), Some("c3"));
    }

    #[test]
    fn assemble_items_tolerates_cases_without_matching_request() {
        // 数据不一致（用例的接口已不在树中）：孤儿用例直接丢弃，不阻塞执行
        let requests = vec![req("r1", "", "i1")];
        let cases = vec![case("c9", "ghost", "orphan", 0)];
        let items = assemble_items(requests, cases, &[], &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "r1");
    }

    #[test]
    fn folder_filter_matches_segment_or_full_path() {
        let requests = vec![
            req("a / b / r1", "a / b", "i1"),
            req("a / r2", "a", "i2"),
            req("r3", "", "i3"),
        ];
        let items = assemble_items(requests, Vec::new(), &["b".to_string()], &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "a / b / r1");

        let requests = vec![req("a / b / r1", "a / b", "i1"), req("a / r2", "a", "i2")];
        let items = assemble_items(requests, Vec::new(), &["a / b".to_string()], &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "a / b / r1");

        // 根级请求在任何 --folder 过滤下都被排除
        let requests = vec![req("r3", "", "i3")];
        assert!(assemble_items(requests, Vec::new(), &["a".to_string()], &[]).is_empty());
    }

    #[test]
    fn request_name_filter_matches_leaf_name() {
        let requests = vec![req("a / b / r1", "a / b", "i1"), req("r2", "", "i2")];
        let items = assemble_items(requests, Vec::new(), &[], &["r1".to_string()]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "a / b / r1");

        // 用例随所属请求保留
        let requests = vec![req("r2", "", "i2")];
        let cases = vec![case("c1", "i2", "case A", 0)];
        let items = assemble_items(requests, cases, &[], &["r2".to_string()]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].0, "r2 / case A");
    }

    #[test]
    fn resolve_read_path_honors_working_dir_and_insecure_guard() {
        let base = std::env::temp_dir().join(format!("rp-wd-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("in.json"), "{}").unwrap();
        let opts = RunOptions {
            collection: None,
            request: None,
            file: None,
            env: None,
            env_file: None,
            globals_file: None,
            env_vars: Vec::new(),
            global_vars: Vec::new(),
            folders: Vec::new(),
            request_names: Vec::new(),
            iteration_count: None,
            iteration_data: None,
            bail: false,
            suppress_exit_code: false,
            delay_request_ms: 0,
            timeout_request_ms: None,
            timeout_script_ms: None,
            insecure: false,
            silent: false,
            verbose: false,
            color: "never".to_string(),
            reporter_json_export: None,
            reporter_html_export: None,
            reporter_junit_export: None,
            working_dir: Some(base.to_string_lossy().into_owned()),
            no_insecure_file_read: true,
            db_connections: Vec::new(),
            db_connections_file: None,
            export_environment: None,
            export_globals: None,
            cookie_jar: None,
            export_cookie_jar: None,
            concurrency: 1,
            report_formats: Vec::new(),
            report_dir: ".".to_string(),
            upload: false,
        };
        // 工作目录内的相对路径可解析
        let resolved = resolve_read_path(Some("in.json"), &opts).unwrap().unwrap();
        assert!(resolved.ends_with("in.json"));
        // 越界路径被拒绝
        assert!(resolve_read_path(Some("../outside.json"), &opts).is_err());
        std::fs::remove_dir_all(&base).ok();
    }
}

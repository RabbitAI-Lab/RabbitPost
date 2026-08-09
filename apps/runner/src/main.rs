//! RabbitPost Runner CLI
//!
//! serve：常驻领取服务端派发的任务（单个请求或整个 Collection），按任务并发上限执行并回传结果。
//! run  ：在本机一次性执行指定 Collection / 请求，用退出码表达成败，便于接入 CI。
//! 执行引擎与脚本沙箱来自共享库 rp-core（与 rabbitpost CLI 同源）。
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Args, Parser, Subcommand};
use rp_core::exec::{self, ClientPool};
use rp_core::model::{JobAssignment, JobResult};
use rp_core::runner_api::RunnerApi;
use tokio::sync::{mpsc, Semaphore};
use tokio::time::{sleep, timeout, Duration};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 带时间戳的日志行（Runner 通常以服务形式运行，日志需要可追溯时间）
macro_rules! logln {
    ($($arg:tt)*) => {
        println!(
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            format_args!($($arg)*)
        )
    };
}

mod agent;
mod rt;

/// 单批上报的结果条数上限（与服务端 results 接口的上限一致）
const REPORT_BATCH: usize = 20;
/// 攒批等待时间：让 UI 能较快看到进度，又不至于每条一次请求
const REPORT_FLUSH_MS: u64 = 500;

#[derive(Parser)]
#[command(
    name = "rabbitpost-runner",
    version,
    about = "RabbitPost Runner：执行服务端派发或本机指定的接口与 Collection"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Clone)]
struct Connection {
    /// RabbitPost 服务地址，例如 https://rabbitpost.example.com
    #[arg(long, env = "RABBITPOST_SERVER")]
    server: String,
    /// Runner Token（注册 Runner 时生成，形如 rpr_...）
    #[arg(long, env = "RABBITPOST_RUNNER_TOKEN")]
    token: String,
}

#[derive(Args)]
struct ServeArgs {
    #[command(flatten)]
    connection: Connection,
    /// 本机并发上限；任务自带的并发数超过该值时按本值裁剪
    #[arg(long, default_value_t = 8)]
    concurrency: usize,
    /// 队列为空时的轮询间隔（秒）
    #[arg(long, default_value_t = 3)]
    poll_interval: u64,
}

#[derive(Args)]
struct RunArgs {
    #[command(flatten)]
    connection: Connection,
    /// 要执行的 Collection id
    #[arg(long, conflicts_with = "request", required_unless_present = "request")]
    collection: Option<String>,
    /// 要执行的单个请求 id（Collection 条目 id）
    #[arg(long)]
    request: Option<String>,
    /// 环境 id：提供后按该环境的变量做 {{var}} 替换
    #[arg(long)]
    env: Option<String>,
    /// 并发数
    #[arg(long, default_value_t = 4)]
    concurrency: usize,
}

#[derive(Args)]
struct LocalAgentArgs {
    /// 监听起始端口（127.0.0.1）；被占时递增探测，最多 +10
    #[arg(long, default_value_t = 17337)]
    port: u16,
    /// 额外放行的 Origin（逗号分隔，可重复）；默认已放行 localhost/127.0.0.1/tauri
    #[arg(long = "allow-origin", env = "RABBITPOST_AGENT_ALLOW_ORIGIN", value_delimiter = ',')]
    allow_origin: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// 常驻运行，领取并执行服务端派发的任务
    Serve(ServeArgs),
    /// 在本机执行一次指定的 Collection 或请求
    Run(RunArgs),
    /// 作为桌面客户端的本地执行代理运行（不注册、不连接服务器）
    LocalAgent(LocalAgentArgs),
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => match serve(args).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("runner exited with error: {e:#}");
                ExitCode::from(2)
            }
        },
        Command::Run(args) => match run_once(args).await {
            Ok(true) => ExitCode::SUCCESS,
            // 存在失败请求：退出码 1，便于 CI 直接作为门禁
            Ok(false) => ExitCode::from(1),
            Err(e) => {
                eprintln!("run failed: {e:#}");
                ExitCode::from(2)
            }
        },
        Command::LocalAgent(args) => match agent::serve(args.port, args.allow_origin).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("local-agent exited with error: {e:#}");
                ExitCode::from(2)
            }
        },
    }
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let cap = args.concurrency.max(1);
    let client = Arc::new(RunnerApi::new(
        &args.connection.server,
        &args.connection.token,
        VERSION,
    )?);
    // 首次心跳即校验 Token，配错时立刻失败而不是静默空转
    client.heartbeat(VERSION).await?;
    logln!(
        "runner online at {} (concurrency cap {}, poll {}s)",
        args.connection.server,
        cap,
        args.poll_interval
    );

    let heartbeat = tokio::spawn({
        let client = client.clone();
        async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                if let Err(e) = client.heartbeat(VERSION).await {
                    logln!("heartbeat failed: {e:#}");
                }
            }
        }
    });

    let pool = Arc::new(ClientPool::new(&format!("RabbitPostRunner/{VERSION}")));
    let work = async {
        loop {
            match client.claim().await {
                Ok(Some(job)) => run_job(&client, &pool, job, cap).await,
                Ok(None) => sleep(Duration::from_secs(args.poll_interval)).await,
                Err(e) => {
                    logln!("claim failed: {e:#}");
                    sleep(Duration::from_secs(args.poll_interval)).await;
                }
            }
        }
    };

    // 实时通道：与轮询循环并行保持 rt downlink 长连接（断线内部退避重连）
    let rt_link = tokio::spawn(rt::rt_link_loop(client.clone()));

    tokio::select! {
        _ = work => {}
        _ = rt_link => {}
        signal = tokio::signal::ctrl_c() => {
            signal?;
            logln!("interrupted, shutting down");
        }
    }
    heartbeat.abort();
    Ok(())
}

/// 执行一个已领取的任务：信号量控制并发，结果攒批回传，最后统一收尾
async fn run_job(client: &Arc<RunnerApi>, pool: &Arc<ClientPool>, job: JobAssignment, cap: usize) {
    let job_id = job.job_id.clone();
    let concurrency = job.concurrency.clamp(1, cap);
    let is_scenario = job.target_type == "scenario";
    logln!(
        "job {} claimed: target `{}`, {} request(s), concurrency {}{}",
        job_id,
        job.target_name,
        job.items.len(),
        concurrency,
        if is_scenario { " (scenario, sequential)" } else { "" },
    );

    let (tx, rx) = mpsc::channel::<JobResult>(256);
    let reporter = tokio::spawn(report_loop(client.clone(), job_id.clone(), rx));

    if is_scenario {
        // 场景测试：串行执行，步骤间通过 rp.variables.set() 传递临时变量
        let mut tmp_vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let base_variables = job.variables;
        let db_connections = job.db_connections;
        let mut succeeded = 0usize;
        let mut failed = 0usize;

        for item in job.items {
            // 合并基础变量与临时变量（临时变量以 tmp. 前缀注入）
            let mut merged = base_variables.clone();
            for (k, v) in &tmp_vars {
                merged.insert(format!("tmp.{k}"), v.clone());
            }

            let ctx = exec::ExecContext {
                db_connections: Some(&db_connections),
                ..Default::default()
            };
            let mut result =
                exec::execute_with(pool, &ctx, &item.name, item.item_id, &item.request, &merged).await;
            result.case_id = item.case_id;
            log_result(&result);
            let ok = result.ok;

            // 收集脚本中的变量改动到临时变量表（供后续步骤使用）
            if let Some(vars) = &result.script_variables {
                for (k, v) in vars {
                    if !base_variables.contains_key(k) {
                        tmp_vars.insert(k.clone(), v.clone());
                    }
                }
            }

            let _ = tx.send(result).await;
            if ok {
                succeeded += 1;
            } else {
                failed += 1;
            }
        }
        drop(tx);

        let report_error = reporter.await.unwrap_or_else(|e| Some(e.to_string()));
        logln!(
            "job {} finished: {} succeeded, {} failed",
            job_id,
            succeeded,
            failed
        );
        if let Err(e) = client
            .complete(&job_id, failed == 0 && report_error.is_none(), report_error)
            .await
        {
            logln!("failed to complete job {job_id}: {e:#}");
        }
        return;
    }

    // 普通任务：并发执行
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let variables = Arc::new(job.variables);
    let db_connections = Arc::new(job.db_connections);
    let mut tasks = Vec::with_capacity(job.items.len());
    for item in job.items {
        let semaphore = semaphore.clone();
        let pool = pool.clone();
        let variables = variables.clone();
        let db_connections = db_connections.clone();
        let tx = tx.clone();
        tasks.push(tokio::spawn(async move {
            // permit 在任务结束时释放，从而保持在并发上限内
            let _permit = semaphore.acquire().await.ok();
            let ctx = exec::ExecContext {
                db_connections: Some(&db_connections),
                ..Default::default()
            };
            let mut result =
                exec::execute_with(&pool, &ctx, &item.name, item.item_id, &item.request, &variables).await;
            // 用例作为独立执行项时回填 caseId（服务端按此聚合用例结果）
            result.case_id = item.case_id;
            log_result(&result);
            let ok = result.ok;
            let _ = tx.send(result).await;
            ok
        }));
    }
    drop(tx);

    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for task in tasks {
        match task.await {
            Ok(true) => succeeded += 1,
            Ok(false) => failed += 1,
            Err(e) => {
                failed += 1;
                logln!("request task aborted: {e}");
            }
        }
    }

    let report_error = reporter.await.unwrap_or_else(|e| Some(e.to_string()));
    logln!(
        "job {} finished: {} succeeded, {} failed",
        job_id,
        succeeded,
        failed
    );
    if let Err(e) = client
        .complete(&job_id, failed == 0 && report_error.is_none(), report_error)
        .await
    {
        logln!("failed to complete job {job_id}: {e:#}");
    }
}

fn log_result(result: &JobResult) {
    let failed_tests = result
        .test_results
        .as_ref()
        .map(|tests| tests.iter().filter(|t| !t.passed).count())
        .unwrap_or_default();
    if let Some(error) = &result.error {
        logln!("  FAIL {} {} — {}", result.method, result.name, error);
    } else if failed_tests > 0 {
        logln!(
            "  FAIL {} {} {} — {} assertion(s) failed",
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            failed_tests
        );
    } else {
        logln!(
            "  {} {} {} {} — {} ms",
            if result.ok { "PASS" } else { "FAIL" },
            result.status.map(|s| s.to_string()).unwrap_or_default(),
            result.method,
            result.name,
            result.duration_ms.unwrap_or_default()
        );
    }
}

/// 攒批上报结果；返回最后一次上报失败的原因（用于任务收尾时标记失败）
async fn report_loop(
    client: Arc<RunnerApi>,
    job_id: String,
    mut rx: mpsc::Receiver<JobResult>,
) -> Option<String> {
    let mut buffer: Vec<JobResult> = Vec::new();
    let mut last_error: Option<String> = None;

    async fn flush(
        client: &RunnerApi,
        job_id: &str,
        buffer: &mut Vec<JobResult>,
        last_error: &mut Option<String>,
    ) {
        if buffer.is_empty() {
            return;
        }
        if let Err(e) = client.report(job_id, buffer).await {
            let message = format!("failed to report results: {e:#}");
            logln!("{message}");
            *last_error = Some(message);
        }
        // 上报失败也清空，避免缓冲无限增长；失败原因已记录并在收尾时反馈
        buffer.clear();
    }

    loop {
        match timeout(Duration::from_millis(REPORT_FLUSH_MS), rx.recv()).await {
            Ok(Some(result)) => {
                buffer.push(result);
                if buffer.len() >= REPORT_BATCH {
                    flush(&client, &job_id, &mut buffer, &mut last_error).await;
                }
            }
            Ok(None) => {
                flush(&client, &job_id, &mut buffer, &mut last_error).await;
                break;
            }
            Err(_) => flush(&client, &job_id, &mut buffer, &mut last_error).await,
        }
    }
    last_error
}

/// run 子命令：本机执行一次，结果只打印不回传；全部成功返回 true
async fn run_once(args: RunArgs) -> anyhow::Result<bool> {
    let client = RunnerApi::new(&args.connection.server, &args.connection.token, VERSION)?;
    let (target_type, target_id) = match (&args.collection, &args.request) {
        (Some(id), _) => ("collection", id.clone()),
        (_, Some(id)) => ("request", id.clone()),
        _ => anyhow::bail!("either --collection or --request is required"),
    };
    let concurrency = args.concurrency.max(1);
    let job = client
        .expand(target_type, &target_id, args.env.clone(), concurrency)
        .await?;
    logln!(
        "running `{}`: {} request(s), concurrency {}",
        job.target_name,
        job.items.len(),
        concurrency
    );

    let pool = Arc::new(ClientPool::new(&format!("RabbitPostRunner/{VERSION}")));
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let variables = Arc::new(job.variables);
    let db_connections = Arc::new(job.db_connections);
    let mut tasks = Vec::with_capacity(job.items.len());
    for item in job.items {
        let semaphore = semaphore.clone();
        let pool = pool.clone();
        let variables = variables.clone();
        let db_connections = db_connections.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await.ok();
            let ctx = exec::ExecContext {
                db_connections: Some(&db_connections),
                ..Default::default()
            };
            let mut result =
                exec::execute_with(&pool, &ctx, &item.name, item.item_id, &item.request, &variables).await;
            result.case_id = item.case_id;
            log_result(&result);
            result.ok
        }));
    }

    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for task in tasks {
        match task.await {
            Ok(true) => succeeded += 1,
            _ => failed += 1,
        }
    }
    logln!("done: {} succeeded, {} failed", succeeded, failed);
    Ok(failed == 0)
}

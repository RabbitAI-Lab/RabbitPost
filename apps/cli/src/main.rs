//! RabbitPost CLI（bin: rabbitpost）
//!
//! 面向 AI 与 CI 的本地工具：增删改查接口/Collection/文件夹/环境，
//! 本机执行用例（含 rp.* 断言脚本），生成 JSON/HTML/JUnit 报告并上传服务端。
//! 数据 JSON 走 stdout，日志与错误走 stderr；退出码 0 成功 / 1 用例失败 / 2 操作错误。
mod client;
mod config;
mod crud;
mod output;
mod report;
mod run;

use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use client::CliApi;
use output::fail;

#[derive(Parser)]
#[command(
    name = "rabbitpost",
    version,
    about = "RabbitPost CLI：接口增删改查、用例执行、测试报告与上传"
)]
struct Cli {
    /// RabbitPost 服务地址（优先级高于 RABBITPOST_SERVER 与 ~/.rabbitpost/config.json）
    #[arg(long, env = "RABBITPOST_SERVER", global = true)]
    server: Option<String>,
    /// 个人 API Key，形如 rpk_...（优先级高于 RABBITPOST_API_KEY 与配置文件）
    #[arg(long, env = "RABBITPOST_API_KEY", global = true, hide_env_values = true)]
    api_key: Option<String>,
    /// 列表类命令以表格输出（默认 JSON）
    #[arg(long, global = true)]
    table: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 凭证查看与清理（API Key 通过 --api-key / RABBITPOST_API_KEY / 配置文件提供）
    Auth {
        #[command(subcommand)]
        action: AuthAction,
    },
    /// 团队（只读）
    Team {
        #[command(subcommand)]
        action: TeamAction,
    },
    /// Workspace（只读）
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Collection 增删改查
    Collection {
        #[command(subcommand)]
        action: CollectionAction,
    },
    /// 文件夹增删改查
    Folder {
        #[command(subcommand)]
        action: FolderAction,
    },
    /// 接口（请求）增删改查
    Request {
        #[command(subcommand)]
        action: RequestAction,
    },
    /// 环境变量增删改查
    Env {
        #[command(subcommand)]
        action: EnvAction,
    },
    /// 本机执行 Collection / 单请求，生成报告并可上传
    Run(RunArgs),
    /// 执行报告管理
    Report {
        #[command(subcommand)]
        action: ReportAction,
    },
}

#[derive(Subcommand)]
enum AuthAction {
    /// 查看当前凭证对应的用户（验证 --api-key / 环境变量 / 配置文件是否可用）
    Status,
    /// 删除本地保存的凭证（~/.rabbitpost/config.json）
    Logout,
}

#[derive(Subcommand)]
enum TeamAction {
    /// 团队列表
    List,
}

#[derive(Subcommand)]
enum WorkspaceAction {
    /// Workspace 列表（需指定团队）
    List {
        /// 团队 id
        #[arg(long)]
        team: String,
    },
}

#[derive(Subcommand)]
enum CollectionAction {
    /// Collection 列表
    List {
        /// Workspace id
        #[arg(long)]
        workspace: String,
    },
    /// Collection 详情
    Get { id: String },
    /// Collection 树（folder/request 嵌套）
    Tree { id: String },
    /// 新建 Collection
    Create {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// 描述（Markdown）
        #[arg(long)]
        description: Option<String>,
    },
    /// 更新 Collection
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        description: Option<String>,
    },
    /// 删除 Collection
    Delete { id: String },
}

#[derive(Subcommand)]
enum FolderAction {
    /// 文件夹列表（含嵌套路径）
    List {
        /// Collection id
        #[arg(long)]
        collection: String,
    },
    /// 新建文件夹
    Create {
        /// Collection id
        #[arg(long)]
        collection: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// 父文件夹 id（缺省为根级）
        #[arg(long)]
        parent: Option<String>,
    },
    /// 重命名 / 移动文件夹
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// 移到其它文件夹；传 "root" 表示移回根级
        #[arg(long)]
        parent: Option<String>,
    },
    /// 删除文件夹（子级一并删除）
    Delete { id: String },
}

#[derive(Subcommand)]
enum RequestAction {
    /// 接口列表（含嵌套路径）
    List {
        /// Collection id
        #[arg(long)]
        collection: String,
    },
    /// 接口详情（完整请求配置）
    Get { id: String },
    /// 新建接口
    Create {
        /// Collection id
        #[arg(long)]
        collection: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// 父文件夹 id（缺省为根级）
        #[arg(long)]
        parent: Option<String>,
        /// HTTP 方法（与 --url 搭配快速创建）
        #[arg(long)]
        method: Option<String>,
        /// 请求 URL
        #[arg(long)]
        url: Option<String>,
        /// 完整 RequestConfig JSON：@file 读文件、- 读 stdin、否则按字面量解析
        #[arg(long)]
        data: Option<String>,
    },
    /// 更新接口
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// 只改方法（基于现有配置）
        #[arg(long)]
        method: Option<String>,
        /// 只改 URL（基于现有配置）
        #[arg(long)]
        url: Option<String>,
        /// 完整 RequestConfig JSON，整体替换（@file / - / 字面量）
        #[arg(long)]
        data: Option<String>,
    },
    /// 删除接口
    Delete { id: String },
}

#[derive(Subcommand)]
enum EnvAction {
    /// 环境列表
    List {
        /// Workspace id
        #[arg(long)]
        workspace: String,
    },
    /// 环境详情（含变量）
    Get { id: String },
    /// 新建环境
    Create {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// 初始变量，KEY=VALUE，可多次
        #[arg(long = "set")]
        sets: Vec<String>,
    },
    /// 更新环境变量
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// 设置/覆盖变量，KEY=VALUE，可多次
        #[arg(long = "set")]
        sets: Vec<String>,
        /// 删除变量，可多次
        #[arg(long = "unset")]
        unsets: Vec<String>,
    },
    /// 删除环境
    Delete { id: String },
}

#[derive(Args)]
struct RunArgs {
    /// 要执行的 Collection id
    #[arg(long, conflicts_with = "request", required_unless_present = "request")]
    collection: Option<String>,
    /// 要执行的单个请求 id（Collection 条目 id）
    #[arg(long)]
    request: Option<String>,
    /// 环境 id：按该环境的变量做 {{var}} 替换
    #[arg(long)]
    env: Option<String>,
    /// 并发数
    #[arg(long, default_value_t = 4)]
    concurrency: usize,
    /// 生成报告格式，逗号分隔：json,html,junit
    #[arg(long, value_delimiter = ',')]
    report: Vec<String>,
    /// 报告输出目录（默认当前目录）
    #[arg(long, default_value = ".")]
    report_dir: String,
    /// 执行完成后上传报告（在 Collection 的 Runs tab 可见）
    #[arg(long)]
    upload: bool,
}

#[derive(Subcommand)]
enum ReportAction {
    /// 上传此前生成的 JSON 报告文件
    Upload {
        /// rabbitpost.run-report 格式的 JSON 文件路径
        #[arg(long)]
        file: String,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(cli).await {
        Ok(code) => ExitCode::from(code),
        Err(e) => fail(&e),
    }
}

async fn dispatch(cli: Cli) -> anyhow::Result<u8> {
    let table = cli.table;

    // auth logout 不需要已有凭证
    if let Command::Auth {
        action: AuthAction::Logout,
    } = &cli.command
    {
        return crud::auth_logout().map(|()| 0);
    }

    let creds = config::resolve(cli.server.as_deref(), cli.api_key.as_deref())?;
    let api = CliApi::new(&creds)?;

    match cli.command {
        Command::Auth {
            action: AuthAction::Status,
        } => crud::auth_status(&api).await.map(|()| 0),
        Command::Auth { .. } => unreachable!(),
        Command::Team { action } => match action {
            TeamAction::List => crud::team_list(&api, table).await.map(|()| 0),
        },
        Command::Workspace { action } => match action {
            WorkspaceAction::List { team } => {
                crud::workspace_list(&api, &team, table).await.map(|()| 0)
            }
        },
        Command::Collection { action } => match action {
            CollectionAction::List { workspace } => {
                crud::collection_list(&api, &workspace, table).await.map(|()| 0)
            }
            CollectionAction::Get { id } => crud::collection_get(&api, &id).await.map(|()| 0),
            CollectionAction::Tree { id } => crud::collection_tree(&api, &id).await.map(|()| 0),
            CollectionAction::Create {
                workspace,
                name,
                description,
            } => crud::collection_create(&api, &workspace, &name, description.as_deref())
                .await
                .map(|()| 0),
            CollectionAction::Update {
                id,
                name,
                description,
            } => crud::collection_update(&api, &id, name.as_deref(), description.as_deref())
                .await
                .map(|()| 0),
            CollectionAction::Delete { id } => crud::collection_delete(&api, &id).await.map(|()| 0),
        },
        Command::Folder { action } => match action {
            FolderAction::List { collection } => {
                crud::folder_list(&api, &collection, table).await.map(|()| 0)
            }
            FolderAction::Create {
                collection,
                name,
                parent,
            } => crud::folder_create(&api, &collection, &name, parent.as_deref())
                .await
                .map(|()| 0),
            FolderAction::Update { id, name, parent } => {
                let parent = parent.as_deref().map(|p| if p == "root" { "" } else { p });
                crud::folder_update(&api, &id, name.as_deref(), parent)
                    .await
                    .map(|()| 0)
            }
            FolderAction::Delete { id } => crud::item_delete(&api, &id).await.map(|()| 0),
        },
        Command::Request { action } => match action {
            RequestAction::List { collection } => {
                crud::request_list(&api, &collection, table).await.map(|()| 0)
            }
            RequestAction::Get { id } => crud::request_get(&api, &id).await.map(|()| 0),
            RequestAction::Create {
                collection,
                name,
                parent,
                method,
                url,
                data,
            } => crud::request_create(
                &api,
                &collection,
                &name,
                parent.as_deref(),
                method.as_deref(),
                url.as_deref(),
                data.as_deref(),
            )
            .await
            .map(|()| 0),
            RequestAction::Update {
                id,
                name,
                method,
                url,
                data,
            } => crud::request_update(
                &api,
                &id,
                name.as_deref(),
                method.as_deref(),
                url.as_deref(),
                data.as_deref(),
            )
            .await
            .map(|()| 0),
            RequestAction::Delete { id } => crud::item_delete(&api, &id).await.map(|()| 0),
        },
        Command::Env { action } => match action {
            EnvAction::List { workspace } => {
                crud::env_list(&api, &workspace, table).await.map(|()| 0)
            }
            EnvAction::Get { id } => crud::env_get(&api, &id).await.map(|()| 0),
            EnvAction::Create {
                workspace,
                name,
                sets,
            } => crud::env_create(&api, &workspace, &name, &sets)
                .await
                .map(|()| 0),
            EnvAction::Update {
                id,
                name,
                sets,
                unsets,
            } => crud::env_update(&api, &id, name.as_deref(), &sets, &unsets)
                .await
                .map(|()| 0),
            EnvAction::Delete { id } => crud::env_delete(&api, &id).await.map(|()| 0),
        },
        Command::Run(args) => {
            let opts = run::RunOptions {
                collection: args.collection,
                request: args.request,
                env: args.env,
                concurrency: args.concurrency,
                report_formats: args.report,
                report_dir: args.report_dir,
                upload: args.upload,
            };
            run::run(&api, &opts).await
        }
        Command::Report { action } => match action {
            ReportAction::Upload { file } => {
                run::upload_existing(&api, &file).await.map(|()| 0)
            }
        },
    }
}

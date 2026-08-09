//! RabbitPost CLI（bin: rabbitpost）
//!
//! 面向 AI 与 CI 的本地工具：增删改查接口/Collection/文件夹/环境，
//! 本机执行用例（含 rp.* 断言脚本），生成 JSON/HTML/JUnit 报告并上传服务端。
//! 数据 JSON 走 stdout，日志与错误走 stderr；退出码 0 成功 / 1 用例失败 / 2 操作错误。
mod client;
mod config;
mod convert;
mod crud;
mod lint;
mod output;
mod report;
mod resources;
mod rt;
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
    /// 本机执行 Collection / 单请求 / 本地文件，生成报告并可上传
    Run(Box<RunArgs>),
    /// 执行记录查询（Runs tab 数据）
    Runs {
        #[command(subcommand)]
        action: RunsAction,
    },
    /// 执行报告管理
    Report {
        #[command(subcommand)]
        action: ReportAction,
    },
    /// 请求历史（Workspace 级）
    History {
        #[command(subcommand)]
        action: HistoryAction,
    },
    /// Spec（OpenAPI / AsyncAPI 定义）
    Spec {
        #[command(subcommand)]
        action: SpecAction,
    },
    /// 组织（Org）
    Org {
        #[command(subcommand)]
        action: OrgAction,
    },
    /// Runner 管理（团队级；token 类输出只展示一次）
    Runner {
        #[command(subcommand)]
        action: RunnerAction,
    },
    /// 文档（Workspace 级）
    Doc {
        #[command(subcommand)]
        action: DocAction,
    },
    /// 场景（Scenario）步骤管理
    Scenario {
        #[command(subcommand)]
        action: ScenarioAction,
    },
    /// 长连接协议会话（WebSocket / Socket.IO / MQTT / MCP / gRPC / SSE 等，经 Runner 执行）
    Rt(RtArgs),
}

#[derive(Args)]
struct RtArgs {
    /// Workspace id（会话归属）
    #[arg(long)]
    workspace: String,
    /// 协议：websocket / socketio / mqtt / mcp / grpc / sse / graphql-subscription
    #[arg(long)]
    protocol: String,
    /// 目标地址
    #[arg(long)]
    url: String,
    /// 协议配置 JSON（headers / 子协议等，@file / - / 字面量）
    #[arg(long)]
    config: Option<String>,
    /// 连接打开后发送的消息，可多次
    #[arg(long = "send")]
    sends: Vec<String>,
    /// 监听时长（秒，默认 30）；收到 closed/error 会提前结束
    #[arg(long, default_value_t = 30)]
    listen: u64,
}

#[derive(Subcommand)]
enum OrgAction {
    /// 组织列表
    List,
    /// 新建组织
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        slug: Option<String>,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long)]
        logo_url: Option<String>,
    },
    /// 组织详情
    Get { id: String },
    /// 更新组织（admin+）
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        domain: Option<String>,
        /// active / suspended
        #[arg(long)]
        status: Option<String>,
    },
    /// 删除组织（owner）
    Delete { id: String },
}

#[derive(Subcommand)]
enum RunnerAction {
    /// Runner 列表（team admin）
    List {
        /// 团队 id
        #[arg(long)]
        team: String,
    },
    /// 注册 Runner（返回一次性明文 token）
    Create {
        /// 团队 id
        #[arg(long)]
        team: String,
        /// 名称
        #[arg(long)]
        name: String,
        #[arg(long)]
        description: Option<String>,
    },
    /// Runner 详情
    Get { id: String },
    /// 更新 Runner（名称 / 描述 / 状态 active|disabled）
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        status: Option<String>,
    },
    /// 删除 Runner
    Delete { id: String },
    /// 轮换 token（旧的立即失效，新的只返回一次）
    RotateToken { id: String },
}

#[derive(Subcommand)]
enum DocAction {
    /// 文档树
    List {
        /// Workspace id
        #[arg(long)]
        workspace: String,
    },
    /// 文档详情（含正文）
    Get { id: String },
    /// 新建文档 / 文件夹
    Create {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// document / folder（默认 document）
        #[arg(long, default_value = "document", rename_all = "kebab-case")]
        doc_type: String,
        /// 父文件夹 id（缺省为根级）
        #[arg(long)]
        parent: Option<String>,
        /// 正文：@file 读文件、- 读 stdin、否则按字面量
        #[arg(long)]
        content: Option<String>,
    },
    /// 更新文档
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// 正文：@file / - / 字面量
        #[arg(long)]
        content: Option<String>,
        /// 移到其它文件夹；传 "root" 表示移回根级
        #[arg(long)]
        parent: Option<String>,
    },
    /// 删除文档（子树级联删除）
    Delete { id: String },
}

#[derive(Subcommand)]
enum ScenarioAction {
    /// 场景步骤列表
    Steps { id: String },
    /// 新增步骤（--source-item 从接口导入快照，或 --name + --data 建空步骤）
    StepAdd {
        id: String,
        /// 来源接口（Collection 条目 id）
        #[arg(long)]
        source_item: Option<String>,
        #[arg(long)]
        name: Option<String>,
        /// 步骤请求配置 JSON：@file / - / 字面量
        #[arg(long)]
        data: Option<String>,
    },
    /// 更新步骤
    StepUpdate {
        step_id: String,
        #[arg(long)]
        name: Option<String>,
        /// 步骤请求配置 JSON：@file / - / 字面量
        #[arg(long)]
        data: Option<String>,
    },
    /// 删除步骤
    StepDelete { step_id: String },
    /// 同步单个步骤（与来源接口对齐）
    StepSync { step_id: String },
    /// 批量同步步骤
    SyncAll {
        id: String,
        /// 步骤 id，可多次
        #[arg(long = "step")]
        step_ids: Vec<String>,
    },
    /// 重排步骤
    Reorder {
        id: String,
        /// 步骤 id（按目标顺序），可多次
        #[arg(long = "step")]
        ordered_ids: Vec<String>,
    },
}

#[derive(Subcommand)]
enum SpecAction {
    /// 静态检查 spec 定义（Spectral 风格规则，与 Web 端 Issues 面板一致；有 error 时退出码 1）
    Lint {
        /// Spec id（与 --file 二选一；类型取服务端记录）
        #[arg(conflicts_with = "file", required_unless_present = "file")]
        id: Option<String>,
        /// 本地 spec 文件（YAML / JSON）
        #[arg(long)]
        file: Option<String>,
        /// 显式指定类型：openapi-3.0 / openapi-3.1 / asyncapi-2.0（缺省自动识别）
        #[arg(long = "type", value_name = "TYPE")]
        spec_type: Option<String>,
    },
    /// Spec 列表
    List {
        /// Workspace id
        #[arg(long)]
        workspace: String,
    },
    /// 新建 Spec
    Create {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        #[arg(long)]
        name: String,
        /// openapi-3.0 / openapi-3.1 / asyncapi-2.0
        #[arg(long = "type", value_name = "TYPE")]
        spec_type: String,
        /// yaml / json（默认 yaml）
        #[arg(long)]
        format: Option<String>,
        /// 定义正文：@file / - / 字面量（缺省按类型生成模板）
        #[arg(long)]
        content: Option<String>,
    },
    /// 更新 Spec
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        format: Option<String>,
        /// 定义正文：@file / - / 字面量
        #[arg(long)]
        content: Option<String>,
    },
    /// 删除 Spec
    Delete { id: String },
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
    /// 新建团队
    Create {
        /// 名称
        #[arg(long)]
        name: String,
        /// slug（缺省由服务端生成）
        #[arg(long)]
        slug: Option<String>,
    },
    /// 更新团队（admin+）
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// 头像 URL；传空串清除
        #[arg(long)]
        avatar_url: Option<String>,
    },
    /// 删除团队（owner）
    Delete { id: String },
    /// 成员列表
    Members { id: String },
    /// 邀请成员（按邮箱，被邀请人须已注册；admin+）
    MemberAdd {
        id: String,
        /// 邮箱
        #[arg(long)]
        email: String,
        /// 角色：admin / editor / viewer（默认 editor）
        #[arg(long, default_value = "editor")]
        role: String,
    },
    /// 修改成员角色（admin+）
    MemberUpdate {
        id: String,
        /// 用户 id
        #[arg(long)]
        user: String,
        /// 角色：admin / editor / viewer
        #[arg(long)]
        role: String,
    },
    /// 移除成员（admin+）
    MemberRemove {
        id: String,
        /// 用户 id
        #[arg(long)]
        user: String,
    },
}

#[derive(Subcommand)]
enum WorkspaceAction {
    /// Workspace 列表（需指定团队）
    List {
        /// 团队 id
        #[arg(long)]
        team: String,
    },
    /// 新建 Workspace（editor+）
    Create {
        /// 团队 id
        #[arg(long)]
        team: String,
        /// 名称
        #[arg(long)]
        name: String,
        /// 描述
        #[arg(long)]
        description: Option<String>,
    },
    /// 更新 Workspace（editor+）
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        description: Option<String>,
    },
    /// 删除 Workspace（admin+）
    Delete { id: String },
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
    /// 导出为 rabbitpost.collection 交换文件（默认 JSON 到 stdout，--file 写文件）
    Export {
        id: String,
        /// 输出文件路径
        #[arg(long)]
        file: Option<String>,
    },
    /// 从文件导入 Collection（rabbitpost.collection / Postman v2.1 JSON）
    Import {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        /// Collection 文件路径（@前缀可省略，直接给路径）
        #[arg(long)]
        file: String,
    },
    /// 静态检查 Collection（内置最佳实践规则；有 error 级 issue 时退出码 1）
    Lint {
        /// Collection id（与 --file 二选一）
        #[arg(conflicts_with = "file", required_unless_present = "file")]
        id: Option<String>,
        /// 本地 Collection 文件（rabbitpost.collection / Postman v2.1）
        #[arg(long)]
        file: Option<String>,
        /// 补充可见变量（unresolved-variable 规则），本地环境文件
        #[arg(long)]
        env_file: Option<String>,
        /// 补充可见变量，本地 globals 文件
        #[arg(long)]
        globals: Option<String>,
    },
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
    #[arg(long, conflicts_with_all = ["request", "file"], required_unless_present_any = ["request", "file"])]
    collection: Option<String>,
    /// 要执行的单个请求 id（Collection 条目 id）
    #[arg(long, conflicts_with = "file")]
    request: Option<String>,
    /// 本地 Collection 文件（rabbitpost.collection / Postman v2.1 JSON），离线执行
    #[arg(long)]
    file: Option<String>,
    /// 环境 id：按该环境的变量做 {{var}} 替换
    #[arg(long, conflicts_with = "env_file")]
    env: Option<String>,
    /// 本地环境文件（Postman 环境导出 / RabbitPost 环境 JSON / 扁平 {"K":"V"} 映射）
    #[arg(long)]
    env_file: Option<String>,
    /// 覆盖变量，KEY=VALUE，可多次（优先级最高，覆盖环境/集合/迭代数据同名变量）
    #[arg(long = "env-var")]
    env_vars: Vec<String>,
    /// 本地 globals 文件（Postman globals 导出 / 扁平 kv），优先级最低
    #[arg(long)]
    globals: Option<String>,
    /// 全局变量，KEY=VALUE，可多次（globals 作用域；替换时与 --env-var 同级）
    #[arg(long = "global-var")]
    global_vars: Vec<String>,
    /// 只执行指定文件夹下的请求（文件夹名或 "A / B" 路径），可多次
    #[arg(long = "folder")]
    folders: Vec<String>,
    /// 只执行指定名称的请求（请求名，可多次）
    #[arg(long = "request-name")]
    request_names: Vec<String>,
    /// 迭代轮数：整个目标重复执行 N 次
    #[arg(long, short = 'n')]
    iteration_count: Option<usize>,
    /// 迭代数据文件（JSON 对象数组或 CSV，首行表头）；每行对应一轮迭代的变量
    #[arg(long, short = 'd')]
    iteration_data: Option<String>,
    /// 首个失败后停止执行（隐含顺序执行，忽略 --concurrency）
    #[arg(long)]
    bail: bool,
    /// 用例失败时退出码仍为 0（CI 只依据报告判断时使用）
    #[arg(long, short = 'x')]
    suppress_exit_code: bool,
    /// 每个请求前的固定延迟（毫秒）
    #[arg(long, default_value_t = 0)]
    delay_request: u64,
    /// 覆盖所有请求的超时（毫秒；0 表示不超时）
    #[arg(long)]
    timeout_request: Option<u64>,
    /// 覆盖脚本超时（毫秒；0/缺省为引擎默认 5s）
    #[arg(long)]
    timeout_script: Option<u64>,
    /// 跳过 TLS 证书校验（自签名证书环境）
    #[arg(long, short = 'k')]
    insecure: bool,
    /// 不输出逐请求日志（保留汇总与报告）
    #[arg(long)]
    silent: bool,
    /// 输出逐请求详情（URL / 状态 / 响应头 / 响应体截断 / 断言明细）
    #[arg(long)]
    verbose: bool,
    /// 日志着色：auto（默认，按终端探测）/ always / never
    #[arg(long, default_value = "auto")]
    color: String,
    /// 显式导出 JSON 报告到指定文件（与 --report 并存）
    #[arg(long)]
    reporter_json_export: Option<String>,
    /// 显式导出 HTML 报告到指定文件
    #[arg(long)]
    reporter_html_export: Option<String>,
    /// 显式导出 JUnit XML 报告到指定文件
    #[arg(long)]
    reporter_junit_export: Option<String>,
    /// 相对输入文件（--file/--env-file/--globals/-d/--cookie-jar）的解析基准目录
    #[arg(long)]
    working_dir: Option<String>,
    /// 禁止读取工作目录之外的输入文件
    #[arg(long)]
    no_insecure_file_read: bool,
    /// 数据库连接，NAME=URL，可多次（类型按 scheme 推导：mysql/postgres/sqlite/redis；密码写在 URL 里，
    /// 服务端 API 不回传密码故不支持在线拉取）
    #[arg(long = "db-connection")]
    db_connections: Vec<String>,
    /// 数据库连接文件（JSON 数组：[{ "name", "config": { "type", ... }, "password"? }]）
    #[arg(long)]
    db_connections_file: Option<String>,
    /// 运行结束后导出最终环境变量（含脚本改动，Postman 环境格式）
    #[arg(long)]
    export_environment: Option<String>,
    /// 运行结束后导出最终 globals（含 rp.globals.set 改动，Postman globals 格式）
    #[arg(long)]
    export_globals: Option<String>,
    /// 加载 Cookie Jar 文件（Postman cookie 导出 / 极简数组），run 内共享
    #[arg(long)]
    cookie_jar: Option<String>,
    /// 运行结束后导出 Cookie Jar（含运行期间 Set-Cookie 的变化）
    #[arg(long)]
    export_cookie_jar: Option<String>,
    /// 并发数
    #[arg(long, default_value_t = 4)]
    concurrency: usize,
    /// 生成报告格式，逗号分隔：json,html,junit
    #[arg(long, value_delimiter = ',')]
    report: Vec<String>,
    /// 报告输出目录（默认当前目录）
    #[arg(long, default_value = ".")]
    report_dir: String,
    /// 执行完成后上传报告（在 Collection 的 Runs tab 可见；--file 运行时不可用）
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

#[derive(Subcommand)]
enum RunsAction {
    /// Collection 的执行记录列表
    List {
        /// Collection id
        #[arg(long)]
        collection: String,
        /// 返回条数（默认 50，最大 200）
        #[arg(long)]
        limit: Option<u32>,
    },
    /// 单次执行详情（含逐请求结果与断言）
    Get { id: String },
    /// 下载单次执行的报告（服务端生成，html / junit）
    Report {
        id: String,
        /// 报告格式：html / junit
        #[arg(long, default_value = "html")]
        format: String,
        /// 输出文件路径（缺省写到当前目录，按服务端文件名）
        #[arg(long)]
        file: Option<String>,
    },
}

#[derive(Subcommand)]
enum HistoryAction {
    /// 请求历史列表（按时间倒序）
    List {
        /// Workspace id
        #[arg(long)]
        workspace: String,
        /// 返回条数（默认 50，最大 200）
        #[arg(long)]
        limit: Option<u32>,
        /// 分页偏移
        #[arg(long, default_value_t = 0)]
        offset: u32,
    },
    /// 清空请求历史（需 editor 及以上角色）
    Clear {
        /// Workspace id
        #[arg(long)]
        workspace: String,
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
            TeamAction::Create { name, slug } => {
                resources::team_create(&api, &name, slug.as_deref())
                    .await
                    .map(|()| 0)
            }
            TeamAction::Update { id, name, avatar_url } => {
                resources::team_update(&api, &id, name.as_deref(), avatar_url.as_deref())
                    .await
                    .map(|()| 0)
            }
            TeamAction::Delete { id } => resources::team_delete(&api, &id).await.map(|()| 0),
            TeamAction::Members { id } => {
                resources::team_members(&api, &id, table).await.map(|()| 0)
            }
            TeamAction::MemberAdd { id, email, role } => {
                resources::team_member_add(&api, &id, &email, &role)
                    .await
                    .map(|()| 0)
            }
            TeamAction::MemberUpdate { id, user, role } => {
                resources::team_member_update(&api, &id, &user, &role)
                    .await
                    .map(|()| 0)
            }
            TeamAction::MemberRemove { id, user } => {
                resources::team_member_remove(&api, &id, &user)
                    .await
                    .map(|()| 0)
            }
        },
        Command::Workspace { action } => match action {
            WorkspaceAction::List { team } => {
                crud::workspace_list(&api, &team, table).await.map(|()| 0)
            }
            WorkspaceAction::Create {
                team,
                name,
                description,
            } => resources::workspace_create(&api, &team, &name, description.as_deref())
                .await
                .map(|()| 0),
            WorkspaceAction::Update {
                id,
                name,
                description,
            } => resources::workspace_update(&api, &id, name.as_deref(), description.as_deref())
                .await
                .map(|()| 0),
            WorkspaceAction::Delete { id } => {
                resources::workspace_delete(&api, &id).await.map(|()| 0)
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
            CollectionAction::Export { id, file } => {
                crud::collection_export(&api, &id, file.as_deref())
                    .await
                    .map(|()| 0)
            }
            CollectionAction::Import { workspace, file } => {
                crud::collection_import(&api, &workspace, &file)
                    .await
                    .map(|()| 0)
            }
            CollectionAction::Lint {
                id,
                file,
                env_file,
                globals,
            } => {
                lint::collection_lint(
                    &api,
                    id.as_deref(),
                    file.as_deref(),
                    env_file.as_deref(),
                    globals.as_deref(),
                )
                .await
            }
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
            let args = *args;
            let opts = run::RunOptions {
                collection: args.collection,
                request: args.request,
                file: args.file,
                env: args.env,
                env_file: args.env_file,
                globals_file: args.globals,
                env_vars: args.env_vars,
                global_vars: args.global_vars,
                folders: args.folders,
                request_names: args.request_names,
                iteration_count: args.iteration_count,
                iteration_data: args.iteration_data,
                bail: args.bail,
                suppress_exit_code: args.suppress_exit_code,
                delay_request_ms: args.delay_request,
                timeout_request_ms: args.timeout_request,
                timeout_script_ms: args.timeout_script,
                insecure: args.insecure,
                silent: args.silent,
                verbose: args.verbose,
                color: args.color,
                reporter_json_export: args.reporter_json_export,
                reporter_html_export: args.reporter_html_export,
                reporter_junit_export: args.reporter_junit_export,
                working_dir: args.working_dir,
                no_insecure_file_read: args.no_insecure_file_read,
                db_connections: args.db_connections,
                db_connections_file: args.db_connections_file,
                export_environment: args.export_environment,
                export_globals: args.export_globals,
                cookie_jar: args.cookie_jar,
                export_cookie_jar: args.export_cookie_jar,
                concurrency: args.concurrency,
                report_formats: args.report,
                report_dir: args.report_dir,
                upload: args.upload,
            };
            run::run(&api, &opts).await
        }
        Command::Runs { action } => match action {
            RunsAction::List { collection, limit } => {
                crud::runs_list(&api, &collection, limit, table)
                    .await
                    .map(|()| 0)
            }
            RunsAction::Get { id } => crud::runs_get(&api, &id).await.map(|()| 0),
            RunsAction::Report { id, format, file } => {
                crud::runs_report(&api, &id, &format, file.as_deref())
                    .await
                    .map(|()| 0)
            }
        },
        Command::Report { action } => match action {
            ReportAction::Upload { file } => {
                run::upload_existing(&api, &file).await.map(|()| 0)
            }
        },
        Command::History { action } => match action {
            HistoryAction::List {
                workspace,
                limit,
                offset,
            } => crud::history_list(&api, &workspace, limit, offset, table)
                .await
                .map(|()| 0),
            HistoryAction::Clear { workspace } => {
                crud::history_clear(&api, &workspace).await.map(|()| 0)
            }
        },
        Command::Spec { action } => match action {
            SpecAction::Lint {
                id,
                file,
                spec_type,
            } => {
                lint::spec_lint(&api, id.as_deref(), file.as_deref(), spec_type.as_deref()).await
            }
            SpecAction::List { workspace } => {
                resources::spec_list(&api, &workspace, table).await.map(|()| 0)
            }
            SpecAction::Create {
                workspace,
                name,
                spec_type,
                format,
                content,
            } => resources::spec_create(
                &api,
                &workspace,
                &name,
                &spec_type,
                format.as_deref(),
                content.as_deref(),
            )
            .await
            .map(|()| 0),
            SpecAction::Update {
                id,
                name,
                format,
                content,
            } => resources::spec_update(
                &api,
                &id,
                name.as_deref(),
                format.as_deref(),
                content.as_deref(),
            )
            .await
            .map(|()| 0),
            SpecAction::Delete { id } => resources::spec_delete(&api, &id).await.map(|()| 0),
        },
        Command::Org { action } => match action {
            OrgAction::List => resources::org_list(&api, table).await.map(|()| 0),
            OrgAction::Create {
                name,
                slug,
                domain,
                logo_url,
            } => resources::org_create(
                &api,
                &name,
                slug.as_deref(),
                domain.as_deref(),
                logo_url.as_deref(),
            )
            .await
            .map(|()| 0),
            OrgAction::Get { id } => resources::org_get(&api, &id).await.map(|()| 0),
            OrgAction::Update {
                id,
                name,
                domain,
                status,
            } => resources::org_update(&api, &id, name.as_deref(), domain.as_deref(), status.as_deref())
                .await
                .map(|()| 0),
            OrgAction::Delete { id } => resources::org_delete(&api, &id).await.map(|()| 0),
        },
        Command::Runner { action } => match action {
            RunnerAction::List { team } => {
                resources::runner_list(&api, &team, table).await.map(|()| 0)
            }
            RunnerAction::Create {
                team,
                name,
                description,
            } => resources::runner_create(&api, &team, &name, description.as_deref())
                .await
                .map(|()| 0),
            RunnerAction::Get { id } => resources::runner_get(&api, &id).await.map(|()| 0),
            RunnerAction::Update {
                id,
                name,
                description,
                status,
            } => resources::runner_update(
                &api,
                &id,
                name.as_deref(),
                description.as_deref(),
                status.as_deref(),
            )
            .await
            .map(|()| 0),
            RunnerAction::Delete { id } => resources::runner_delete(&api, &id).await.map(|()| 0),
            RunnerAction::RotateToken { id } => {
                resources::runner_rotate_token(&api, &id).await.map(|()| 0)
            }
        },
        Command::Doc { action } => match action {
            DocAction::List { workspace } => {
                resources::doc_list(&api, &workspace).await.map(|()| 0)
            }
            DocAction::Get { id } => resources::doc_get(&api, &id).await.map(|()| 0),
            DocAction::Create {
                workspace,
                name,
                doc_type,
                parent,
                content,
            } => resources::doc_create(
                &api,
                &workspace,
                &name,
                &doc_type,
                parent.as_deref(),
                content.as_deref(),
            )
            .await
            .map(|()| 0),
            DocAction::Update {
                id,
                name,
                content,
                parent,
            } => resources::doc_update(&api, &id, name.as_deref(), content.as_deref(), parent.as_deref())
                .await
                .map(|()| 0),
            DocAction::Delete { id } => resources::doc_delete(&api, &id).await.map(|()| 0),
        },
        Command::Scenario { action } => match action {
            ScenarioAction::Steps { id } => {
                resources::scenario_steps(&api, &id, table).await.map(|()| 0)
            }
            ScenarioAction::StepAdd {
                id,
                source_item,
                name,
                data,
            } => resources::scenario_step_add(
                &api,
                &id,
                source_item.as_deref(),
                name.as_deref(),
                data.as_deref(),
            )
            .await
            .map(|()| 0),
            ScenarioAction::StepUpdate { step_id, name, data } => {
                resources::scenario_step_update(&api, &step_id, name.as_deref(), data.as_deref())
                    .await
                    .map(|()| 0)
            }
            ScenarioAction::StepDelete { step_id } => {
                resources::scenario_step_delete(&api, &step_id).await.map(|()| 0)
            }
            ScenarioAction::StepSync { step_id } => {
                resources::scenario_step_sync(&api, &step_id).await.map(|()| 0)
            }
            ScenarioAction::SyncAll { id, step_ids } => {
                resources::scenario_sync_all(&api, &id, &step_ids)
                    .await
                    .map(|()| 0)
            }
            ScenarioAction::Reorder { id, ordered_ids } => {
                resources::scenario_reorder(&api, &id, &ordered_ids)
                    .await
                    .map(|()| 0)
            }
        },
        Command::Rt(args) => {
            rt::rt_run(
                &api,
                rt::RtOptions {
                    workspace: args.workspace,
                    protocol: args.protocol,
                    url: args.url,
                    config: args.config,
                    sends: args.sends,
                    listen_secs: args.listen,
                },
            )
            .await
        }
    }
}

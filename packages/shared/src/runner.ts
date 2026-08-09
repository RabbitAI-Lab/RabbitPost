/**
 * Runner / CLI 契约：团队级 Runner 注册与任务下发、CLI 执行报告上传。
 * 管理端（Web/Session）与 Runner 端（Bearer Token）、CLI 端（API Key）共用同一批类型。
 */
import type { ConsoleLogEntry, EnvironmentVariable, RequestConfig, ResolvedDbConnection, TestResult } from "./index";

/** Runner 状态；disabled 的 Runner 不再被派发任务 */
export const RUNNER_STATUSES = ["active", "disabled"] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export interface Runner {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  /** Token 前缀（形如 rpr_ab12cd34），仅用于展示与区分，不足以还原 Token */
  tokenPrefix: string;
  status: RunnerStatus;
  /** 最近一次心跳/取任务时间 */
  lastSeenAt: string | null;
  /** Runner 上报的版本与运行平台 */
  version: string | null;
  platform: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 注册 / 重置 Token 时的响应：明文 Token 仅此一次返回 */
export interface RunnerWithToken {
  runner: Runner;
  token: string;
}

export const RUN_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type RunJobStatus = (typeof RUN_JOB_STATUSES)[number];

/** 任务来源：Web 派发给 Runner 执行 / RabbitPost CLI 本机执行后上传 / Web 界面直接执行上报 */
export const RUN_SOURCES = ["dispatch", "cli", "web"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

/** 派发目标：单个请求 / 整个 Collection（含子文件夹内所有请求） / 接口用例运行（Web Cases 面板上报） / 场景测试（多接口编排串行执行） */
export const RUN_TARGET_TYPES = ["request", "collection", "case", "scenario"] as const;
export type RunTargetType = (typeof RUN_TARGET_TYPES)[number];

export interface RunJob {
  id: string;
  teamId: string;
  workspaceId: string;
  /** 任务来源：dispatch = Web 派发；cli = CLI 本机执行后上传报告；web = Web 界面直接执行上报 */
  source: RunSource;
  /** 所属 Collection（Runs tab 按此过滤；旧数据可能为 null） */
  collectionId: string | null;
  /** targetType === "case" 时关联的用例：单条运行为该用例 id，Run All 批量为 null */
  caseId: string | null;
  /** null 表示任意在线 Runner 均可领取 */
  runnerId: string | null;
  runnerName: string | null;
  /** CLI 上传时的执行方标识，如 rabbitpost-cli/0.1.0 darwin-arm64 */
  agent: string | null;
  targetType: RunTargetType;
  targetId: string;
  targetName: string;
  environmentId: string | null;
  /** 派发/上传时的环境名快照，环境删除后仍可追溯 */
  environmentName: string | null;
  /** 执行时的环境变量快照（secret 值已脱敏）；未带环境或旧数据为 null */
  environmentSnapshot: EnvironmentVariable[] | null;
  /** 单请求直接执行时的请求配置快照（targetId 不在库中时使用） */
  requestConfig: RequestConfig | null;
  /** Runner 侧并发上限 */
  concurrency: number;
  status: RunJobStatus;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  /** 断言通过/失败总数（由逐请求 testResults 累计） */
  testPassedCount: number;
  testFailedCount: number;
  /** Runner 上报的整体失败原因（原文透传） */
  error: string | null;
  createdBy: string;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** 单个请求的执行结果（由 Runner / CLI 上报） */
export interface RunJobResult {
  id: string;
  jobId: string;
  itemId: string | null;
  /** 该结果来自接口用例时为用例 id；请求本身为 null（用例删除后由外键置 null） */
  caseId: string | null;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status: number | null;
  statusText: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  /** 网络层错误原文透传 */
  error: string | null;
  /** rp.test 断言结果（执行脚本的来源才有） */
  testResults: TestResult[] | null;
  /** 脚本 console 输出 */
  consoleLogs: ConsoleLogEntry[] | null;
  /** 执行时的请求配置快照（报告展示请求参数） */
  request: RequestConfig | null;
  /** 响应头（报告展示） */
  responseHeaders: Record<string, string> | null;
  /** 响应体文本（报告展示；二进制不存） */
  responseBody: string | null;
  createdAt: string;
}

export interface RunJobDetail {
  job: RunJob;
  results: RunJobResult[];
}

// ---------------------------------------------------------------------------
// Runner 侧接口（Authorization: Bearer <token>）
// ---------------------------------------------------------------------------

export interface RunnerJobItem {
  /** 关联的 collection item；单请求派发时可为 null */
  itemId: string | null;
  /** 展开时用例作为独立执行项追加（name 形如「接口 / 用例」）；请求本身为 null */
  caseId?: string | null;
  name: string;
  request: RequestConfig;
}

/** 领取到的任务：变量表由服务端解析下发，Runner 侧只做 {{var}} 替换 */
export interface RunnerJobAssignment {
  jobId: string;
  workspaceId: string;
  targetType: RunTargetType;
  targetName: string;
  concurrency: number;
  variables: Record<string, string>;
  /** 已解析的数据库连接（含明文密码，与 variables 同级下发；Runner 侧用于 dbOperations 与 rp.db） */
  dbConnections?: ResolvedDbConnection[];
  items: RunnerJobItem[];
}

export interface RunnerJobResultInput {
  itemId?: string | null;
  /** 该结果对应的接口用例 id；请求本身为 null */
  caseId?: string | null;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status?: number | null;
  statusText?: string | null;
  sizeBytes?: number | null;
  durationMs?: number | null;
  error?: string | null;
  testResults?: TestResult[] | null;
  consoleLogs?: ConsoleLogEntry[] | null;
  /** 执行时的请求配置快照（报告展示请求参数） */
  request?: RequestConfig | null;
  /** 响应头（报告展示） */
  responseHeaders?: Record<string, string> | null;
  /** 响应体文本（报告展示；二进制不存） */
  responseBody?: string | null;
}

/** Runner 心跳：上报版本与平台，服务端刷新 lastSeenAt */
export interface RunnerHeartbeatInput {
  version?: string;
  platform?: string;
}

// ---------------------------------------------------------------------------
// RabbitPost CLI 执行报告（本地落盘 + 上传服务端共用同一份结构）
// ---------------------------------------------------------------------------

export const RUN_REPORT_FORMAT = "rabbitpost.run-report";
export const RUN_REPORT_VERSION = 1;

export interface RunReportSummary {
  /** 请求总数 / 成功 / 失败 */
  total: number;
  succeeded: number;
  failed: number;
  /** 断言通过 / 失败总数 */
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
}

/** CLI `run --report json` 落盘的标准报告；上传时整体作为请求体 */
export interface RunReport {
  format: typeof RUN_REPORT_FORMAT;
  version: typeof RUN_REPORT_VERSION;
  /** 执行方标识，如 rabbitpost-cli/0.1.0 darwin-arm64 */
  agent: string;
  collectionId: string;
  targetType: RunTargetType;
  targetId: string;
  targetName: string;
  environmentId: string | null;
  environmentName: string | null;
  concurrency: number;
  /** ISO 时间戳 */
  startedAt: string;
  finishedAt: string;
  summary: RunReportSummary;
  results: RunnerJobResultInput[];
}

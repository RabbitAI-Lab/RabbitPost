import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ConsoleLogEntry,
  EnvironmentVariable,
  HistoryResponseSummary,
  KeyValueItem,
  OrgPlan,
  OrgRole,
  RequestConfig,
  RunJobStatus,
  RunnerStatus,
  RunSource,
  RunTargetType,
  SpecFormat,
  SpecType,
  TeamRole,
  TestResult,
} from "@rabbitpost/shared";

// ---------------------------------------------------------------------------
// users：由 Casdoor 登录后自动同步（upsert）
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    casdoorId: text("casdoor_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("users_casdoor_id_idx").on(t.casdoorId)],
);

// ---------------------------------------------------------------------------
// api_keys（个人 API Key，CLI 凭证；明文只返回一次，仅存 sha256 摘要）
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    /** Key 的 sha256 十六进制摘要 */
    keyHash: text("key_hash").notNull(),
    /** Key 前缀，用于列表区分（不足以还原 Key） */
    keyPrefix: text("key_prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("api_keys_user_idx").on(t.userId),
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
  ],
);

// ---------------------------------------------------------------------------
// organizations（企业）& organization_members（企业成员）
// ---------------------------------------------------------------------------
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logoUrl: text("logo_url"),
    /** 企业域名（用于邮箱后缀自动加入） */
    domain: text("domain"),
    plan: text("plan").$type<OrgPlan>().notNull().default("enterprise"),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    /** 套牌席位上限（0 = 不限） */
    seatLimit: integer("seat_limit").notNull().default(0),
    /** 每月请求配额（0 = 不限） */
    requestQuota: integer("request_quota").notNull().default(0),
    /** SSO / SCIM 配置（JSON） */
    ssoConfig: jsonb("sso_config").$type<Record<string, unknown>>(),
    /** 企业管理员通知邮箱（团队/工作区变更通知收件人） */
    adminEmail: text("admin_email"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").$type<OrgRole>().notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ---------------------------------------------------------------------------
// audit_logs（企业审计日志）
// ---------------------------------------------------------------------------
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    /** 目标名称快照，目标删除后仍可追溯 */
    targetName: text("target_name"),
    detail: jsonb("detail"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// notifications（企业通知：团队/工作区/成员变更通知）
// ---------------------------------------------------------------------------
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** 通知级别：org_admin / team_admin */
    level: text("level").$type<"org_admin" | "team_admin">().notNull(),
    /** 通知标题 */
    title: text("title").notNull(),
    /** 通知正文 */
    body: text("body").notNull(),
    /** 触发者 id */
    actorId: uuid("actor_id").references(() => users.id),
    /** 触发者名称快照 */
    actorName: text("actor_name"),
    /** 关联团队 id（team_admin 级别通知时必填） */
    teamId: uuid("team_id"),
    /** 关联团队名称快照 */
    teamName: text("team_name"),
    /** 是否已读 */
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("notifications_org_created_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// usage_events（用量事件流，用于统计聚合）
// ---------------------------------------------------------------------------
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    teamId: uuid("team_id"),
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id"),
    metric: text("metric").notNull(),
    count: integer("count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("usage_events_org_metric_idx").on(t.orgId, t.metric, t.createdAt)],
);

// ---------------------------------------------------------------------------
// teams & team_members
// ---------------------------------------------------------------------------
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    avatarUrl: text("avatar_url"),
    /** 企业下团队的 orgId；个人版为 null */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("teams_slug_idx").on(t.slug)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").$type<TeamRole>().notNull().default("editor"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("workspaces_team_idx").on(t.teamId)],
);

// ---------------------------------------------------------------------------
// collections & collection_items（自引用树：folder / request / scenario）
// ---------------------------------------------------------------------------
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** 侧边栏手动拖拽排序 */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Collection 级变量（作用域为当前 Collection，优先级低于 Environment） */
    variables: jsonb("variables").$type<KeyValueItem[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("collections_workspace_idx").on(t.workspaceId)],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => collections.id, { onDelete: "cascade" })
      .notNull(),
    parentId: uuid("parent_id"),
    type: text("type").$type<"folder" | "request" | "scenario">().notNull(),
    name: text("name").notNull(),
    /** 文件夹 Overview 文档（Markdown） */
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 仅 type = request 时有值，保存完整请求配置 */
    request: jsonb("request").$type<RequestConfig>(),
    /** 标记该 folder 是否为 Collection 的默认场景测试根目录 */
    isScenarioRoot: boolean("is_scenario_root").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("collection_items_collection_idx").on(t.collectionId)],
);

// ---------------------------------------------------------------------------
// scenario_steps（场景测试步骤：请求配置快照 + 源接口引用，按 sortOrder 串行执行）
// ---------------------------------------------------------------------------
export const scenarioSteps = pgTable(
  "scenario_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 所属场景（collection_items 中 type=scenario 的条目） */
    scenarioId: uuid("scenario_id")
      .references(() => collectionItems.id, { onDelete: "cascade" })
      .notNull(),
    /** 步骤名称（导入时默认为接口名，可修改） */
    name: text("name").notNull(),
    /** 步骤排序 */
    sortOrder: integer("sort_order").notNull().default(0),
    /** 请求配置快照（导入时从源接口拷贝，之后独立编辑） */
    request: jsonb("request").$type<RequestConfig>().notNull(),
    /** 来源接口 id（记录来源引用，用于差异检测与同步；源接口删除后置 null） */
    sourceItemId: uuid("source_item_id").references(
      () => collectionItems.id,
      { onDelete: "set null" },
    ),
    /** 导入时源接口的 updatedAt，用于快速判断是否有变更 */
    sourceSnapshotAt: timestamp("source_snapshot_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("scenario_steps_scenario_idx").on(t.scenarioId)],
);

// ---------------------------------------------------------------------------
// request_cases（接口用例：request item 下的独立配置副本，新建时快照继承）
// ---------------------------------------------------------------------------
export const requestCases = pgTable(
  "request_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .references(() => collectionItems.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    /** 用例说明（验证什么场景） */
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 完整请求配置快照；reset 时被接口当前配置覆盖 */
    request: jsonb("request").$type<RequestConfig>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("request_cases_item_idx").on(t.itemId)],
);

// ---------------------------------------------------------------------------
// collection_shares（Collection 公开只读分享链接；每个 Collection 最多一条）
// ---------------------------------------------------------------------------
export const collectionShares = pgTable(
  "collection_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => collections.id, { onDelete: "cascade" })
      .notNull(),
    /** 链接中的随机令牌；撤销分享直接删行 */
    token: text("token").notNull(),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("collection_shares_collection_idx").on(t.collectionId),
    uniqueIndex("collection_shares_token_idx").on(t.token),
  ],
);

// ---------------------------------------------------------------------------
// document_items（workspace 级自引用树：folder / document）
// ---------------------------------------------------------------------------
export const documentItems = pgTable(
  "document_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    parentId: uuid("parent_id"),
    type: text("type").$type<"folder" | "document">().notNull(),
    name: text("name").notNull(),
    /** 文档正文（Markdown）；仅 type = document 时有值 */
    content: text("content"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("document_items_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// specs（workspace 级 API 定义：OpenAPI / AsyncAPI）
// ---------------------------------------------------------------------------
export const specs = pgTable(
  "specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").$type<SpecType>().notNull(),
    format: text("format").$type<SpecFormat>().notNull().default("yaml"),
    /** 定义正文（YAML 或 JSON 文本） */
    content: text("content").notNull().default(""),
    /** 由该 spec 生成的 Collection；Collection 被删除后置空 */
    generatedCollectionId: uuid("generated_collection_id").references(
      () => collections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("specs_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// environments
// ---------------------------------------------------------------------------
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    variables: jsonb("variables")
      .$type<EnvironmentVariable[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("environments_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// histories
// ---------------------------------------------------------------------------
export const histories = pgTable(
  "histories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    name: text("name"),
    request: jsonb("request").$type<RequestConfig>().notNull(),
    response: jsonb("response").$type<HistoryResponseSummary>(),
    /** 网络层错误原文透传 */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("histories_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// runners（团队级 Runner CLI 注册；Token 仅存 sha256 摘要）
// ---------------------------------------------------------------------------
export const runners = pgTable(
  "runners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Token 的 sha256 十六进制摘要；明文仅在注册/重置时返回一次 */
    tokenHash: text("token_hash").notNull(),
    /** Token 前缀，用于列表区分（不足以还原 Token） */
    tokenPrefix: text("token_prefix").notNull(),
    status: text("status").$type<RunnerStatus>().notNull().default("active"),
    /** 最近一次心跳 / 取任务时间 */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** Runner 上报的自身版本与运行平台 */
    version: text("version"),
    platform: text("platform"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("runners_team_idx").on(t.teamId),
    uniqueIndex("runners_token_hash_idx").on(t.tokenHash),
  ],
);

// ---------------------------------------------------------------------------
// run_jobs（下发给 Runner 的执行任务：单请求 or 整个 Collection）
// ---------------------------------------------------------------------------
export const runJobs = pgTable(
  "run_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    /** 指定 Runner；为空表示团队内任意 Runner 均可领取 */
    runnerId: uuid("runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    /** 任务来源：dispatch = Web 派发；cli = CLI 本机执行后上传报告 */
    source: text("source").$type<RunSource>().notNull().default("dispatch"),
    /** 所属 Collection（Runs tab 按此过滤；旧数据可能为 null） */
    collectionId: uuid("collection_id").references(() => collections.id, {
      onDelete: "cascade",
    }),
    /** targetType === "case" 时关联的用例：单条运行为该用例 id，Run All 批量为 null */
    caseId: uuid("case_id").references(() => requestCases.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type").$type<RunTargetType>().notNull(),
    /** collectionId 或 collectionItemId（随 targetType 而定） */
    targetId: uuid("target_id").notNull(),
    /** 派发时的目标名称快照，目标删除后仍可追溯 */
    targetName: text("target_name").notNull(),
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    /** 派发/上传时的环境名快照，环境删除后仍可追溯 */
    environmentName: text("environment_name"),
    /** 执行时的环境变量快照（secret 值脱敏为 ******），环境后续改动不影响历史可追溯 */
    environmentSnapshot: jsonb("environment_snapshot").$type<EnvironmentVariable[]>(),
    /** 单请求直接执行时的请求配置快照（targetId 不在库中时使用） */
    requestConfig: jsonb("request_config").$type<RequestConfig>(),
    /** CLI 上传时的执行方标识（runner 名之外的展示来源） */
    agent: text("agent"),
    concurrency: integer("concurrency").notNull().default(4),
    status: text("status").$type<RunJobStatus>().notNull().default("queued"),
    totalCount: integer("total_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** 断言通过/失败总数（由逐请求 testResults 累计） */
    testPassedCount: integer("test_passed_count").notNull().default(0),
    testFailedCount: integer("test_failed_count").notNull().default(0),
    /** Runner 上报的整体失败原因，原文透传 */
    error: text("error"),
    createdBy: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("run_jobs_team_created_idx").on(t.teamId, t.createdAt),
    index("run_jobs_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// run_job_results（Runner 上报的逐请求结果；并发写入故独立成表）
// ---------------------------------------------------------------------------
export const runJobResults = pgTable(
  "run_job_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .references(() => runJobs.id, { onDelete: "cascade" })
      .notNull(),
    itemId: uuid("item_id"),
    /** 该结果来自接口用例时为用例 id；用例删除后置 null（结果保留） */
    caseId: uuid("case_id").references(() => requestCases.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    ok: boolean("ok").notNull(),
    status: integer("status"),
    statusText: text("status_text"),
    sizeBytes: integer("size_bytes"),
    durationMs: integer("duration_ms"),
    /** 网络层错误原文透传 */
    error: text("error"),
    /** rp.test 断言结果（执行脚本的来源才有） */
    testResults: jsonb("test_results").$type<TestResult[]>(),
    /** 脚本 console 输出 */
    consoleLogs: jsonb("console_logs").$type<ConsoleLogEntry[]>(),
    /** 执行时的请求配置快照（报告展示请求参数） */
    request: jsonb("request").$type<RequestConfig>(),
    /** 响应头（报告展示） */
    responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
    /** 响应体文本（截断存储，报告展示；二进制不存） */
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("run_job_results_job_idx").on(t.jobId)],
);

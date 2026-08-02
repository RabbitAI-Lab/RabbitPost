/**
 * Runner CLI 服务端支撑：Token 签发/校验、Runner 侧路由鉴权包装、行到 DTO 的转换，
 * 以及派发任务时把目标（单请求 / Collection）展开为待执行请求列表。
 */
import crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type {
  EnvironmentVariable,
  RequestConfig,
  RunJob,
  RunJobResult,
  Runner,
  RunnerJobItem,
  VariableMap,
} from "@rabbitpost/shared";
import { db } from "../db";
import {
  collectionItems,
  collections,
  environments,
  requestCases,
  runJobResults,
  runJobs,
  runners,
} from "../db/schema";
import { err, HttpError } from "./http";

const TOKEN_PREFIX = "rpr_";

/** 签发 Runner Token：明文只返回一次，库里只存 sha256 摘要 */
export function issueRunnerToken(): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashRunnerToken(token),
    // 前缀只取到随机段的前 8 位，便于在列表里区分同名 Runner
    tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 8),
  };
}

export function hashRunnerToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

type RunnerRow = typeof runners.$inferSelect;

export function toRunner(row: RunnerRow): Runner {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    tokenPrefix: row.tokenPrefix,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    version: row.version,
    platform: row.platform,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRunJob(
  row: typeof runJobs.$inferSelect,
  runnerName: string | null = null,
): RunJob {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    source: row.source,
    collectionId: row.collectionId,
    caseId: row.caseId,
    runnerId: row.runnerId,
    runnerName,
    agent: row.agent,
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: row.targetName,
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    environmentSnapshot: row.environmentSnapshot ?? null,
    requestConfig: row.requestConfig ?? null,
    concurrency: row.concurrency,
    status: row.status,
    totalCount: row.totalCount,
    succeededCount: row.succeededCount,
    failedCount: row.failedCount,
    testPassedCount: row.testPassedCount,
    testFailedCount: row.testFailedCount,
    error: row.error,
    createdBy: row.createdBy,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRunJobResult(row: typeof runJobResults.$inferSelect): RunJobResult {
  return {
    id: row.id,
    jobId: row.jobId,
    itemId: row.itemId,
    caseId: row.caseId,
    name: row.name,
    method: row.method,
    url: row.url,
    ok: row.ok,
    status: row.status,
    statusText: row.statusText,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    error: row.error,
    testResults: row.testResults ?? null,
    consoleLogs: row.consoleLogs ?? null,
    request: row.request ?? null,
    responseHeaders: row.responseHeaders ?? null,
    responseBody: row.responseBody ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 逐请求结果入参 schema（Runner 分批上报与 CLI 报告上传共用）
// ---------------------------------------------------------------------------

const testResultSchema = z.object({
  name: z.string().max(512),
  passed: z.boolean(),
  error: z.string().max(4096).optional(),
});

const consoleLogSchema = z.object({
  level: z.enum(["log", "warn", "error", "info"]),
  args: z.array(z.string().max(4096)).max(50),
});

export const runJobResultInputSchema = z.object({
  itemId: z.string().uuid().nullable().optional(),
  caseId: z.string().uuid().nullable().optional(),
  name: z.string().max(512),
  method: z.string().max(16),
  url: z.string().max(4096),
  ok: z.boolean(),
  status: z.number().int().nullable().optional(),
  statusText: z.string().max(256).nullable().optional(),
  sizeBytes: z.number().int().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
  testResults: z.array(testResultSchema).max(200).nullable().optional(),
  consoleLogs: z.array(consoleLogSchema).max(200).nullable().optional(),
  /** 执行时的请求配置快照（报告展示请求参数） */
  request: z.record(z.string(), z.unknown()).nullable().optional(),
  /** 响应头（报告展示） */
  responseHeaders: z.record(z.string(), z.string()).nullable().optional(),
  /** 响应体文本（截断存储，报告展示；二进制不存） */
  responseBody: z.string().max(65536).nullable().optional(),
});

/** 从逐请求结果累计断言通过/失败数 */
export function countAssertions(
  results: z.infer<typeof runJobResultInputSchema>[],
): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    for (const t of r.testResults ?? []) {
      if (t.passed) passed += 1;
      else failed += 1;
    }
  }
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Runner 侧鉴权（Authorization: Bearer <token>）
// ---------------------------------------------------------------------------

/**
 * 包裹 Runner 侧 route handler：以 Token 认证 Runner 身份（无浏览器会话），
 * 并顺带刷新 lastSeenAt，使管理页能看到在线状态。
 */
export function handleRunnerRoute<Ctx>(
  handler: (req: Request, ctx: Ctx, runner: RunnerRow) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const header = req.headers.get("authorization") ?? "";
      const token = header.replace(/^Bearer\s+/i, "").trim();
      if (!token) {
        return err(401, "RUNNER_UNAUTHORIZED", "Missing runner token");
      }
      const [row] = await db
        .select()
        .from(runners)
        .where(eq(runners.tokenHash, hashRunnerToken(token)))
        .limit(1);
      if (!row) return err(401, "RUNNER_UNAUTHORIZED", "Invalid runner token");
      if (row.status !== "active") {
        return err(403, "RUNNER_DISABLED", "This runner has been disabled");
      }
      await db
        .update(runners)
        .set({ lastSeenAt: new Date() })
        .where(eq(runners.id, row.id));
      return await handler(req, ctx, row);
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.code, e.message);
      const message = e instanceof Error ? e.message : String(e);
      console.error("[runner-api] unhandled error:", e);
      return err(500, "INTERNAL_ERROR", message);
    }
  };
}

// ---------------------------------------------------------------------------
// 派发目标展开
// ---------------------------------------------------------------------------

/** 校验 Runner 属于该团队并返回行 */
export async function requireRunnerInTeam(
  runnerId: string,
  teamId: string,
): Promise<RunnerRow> {
  const [row] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.teamId, teamId)))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Runner not found");
  return row;
}

/** 环境变量表：与 /api/v1/execute 同源语义，仅取 enabled 的键值 */
export async function loadRunnerVariables(
  environmentId: string | null,
): Promise<VariableMap> {
  if (!environmentId) return {};
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) return {};
  const vars: VariableMap = {};
  for (const v of row.variables as EnvironmentVariable[]) {
    if (v.enabled && v.key) vars[v.key] = v.value;
  }
  return vars;
}

/**
 * 把派发目标展开为待执行请求列表：
 * - request：单个 collection item
 * - collection：该 Collection 下所有 request 条目，按树的先序（同级 sortOrder）排列
 * - scenario：场景测试的步骤列表，按 sortOrder 串行排列
 */
export async function expandRunTarget(
  // "case" 是 Web Cases 面板上报的历史类型，不是 Runner 可派发目标，这里收窄
  targetType: "request" | "collection" | "scenario",
  targetId: string,
): Promise<{
  workspaceId: string;
  collectionId: string;
  targetName: string;
  items: RunnerJobItem[];
}> {
  if (targetType === "request") {
    const [item] = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.id, targetId))
      .limit(1);
    if (!item || item.type !== "request") {
      throw new HttpError(404, "NOT_FOUND", "Request item not found");
    }
    const [col] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, item.collectionId))
      .limit(1);
    if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
    if (!item.request) {
      throw new HttpError(400, "EMPTY_REQUEST", "This item has no request config");
    }
    // 请求本身 + 其全部用例（用例作为独立执行项，name 形如「接口 / 用例」）
    const caseRows = await db
      .select()
      .from(requestCases)
      .where(eq(requestCases.itemId, item.id))
      .orderBy(asc(requestCases.sortOrder), asc(requestCases.createdAt));
    return {
      workspaceId: col.workspaceId,
      collectionId: col.id,
      targetName: item.name,
      items: [
        { itemId: item.id, caseId: null, name: item.name, request: item.request },
        ...caseRows.map((c) => ({
          itemId: item.id,
          caseId: c.id,
          name: `${item.name} / ${c.name}`,
          request: c.request,
        })),
      ],
    };
  }

  if (targetType === "scenario") {
    return expandScenario(targetId);
  }

  const [col] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, targetId))
    .limit(1);
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
  const rows = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, targetId))
    .orderBy(asc(collectionItems.sortOrder), asc(collectionItems.createdAt));

  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  // 一次性取出该 Collection 全部用例并按 itemId 分组（避免逐请求查询）
  const requestIds = rows.filter((r) => r.type === "request").map((r) => r.id);
  const caseRows = requestIds.length
    ? await db
        .select()
        .from(requestCases)
        .where(inArray(requestCases.itemId, requestIds))
        .orderBy(asc(requestCases.sortOrder), asc(requestCases.createdAt))
    : [];
  const casesByItem = new Map<string, typeof caseRows>();
  for (const c of caseRows) {
    const list = casesByItem.get(c.itemId) ?? [];
    list.push(c);
    casesByItem.set(c.itemId, list);
  }

  // 每个请求条目之后紧跟其全部用例（name 形如「文件夹 / 接口 / 用例」）
  const items: RunnerJobItem[] = [];
  const walk = (parentId: string | null, prefix: string): void => {
    for (const row of byParent.get(parentId) ?? []) {
      if (row.type === "folder") {
        walk(row.id, `${prefix}${row.name} / `);
      } else if (row.request) {
        const requestName = `${prefix}${row.name}`;
        items.push({
          itemId: row.id,
          caseId: null,
          name: requestName,
          request: row.request as RequestConfig,
        });
        for (const c of casesByItem.get(row.id) ?? []) {
          items.push({
            itemId: row.id,
            caseId: c.id,
            name: `${requestName} / ${c.name}`,
            request: c.request,
          });
        }
      }
    }
  };
  walk(null, "");
  if (items.length === 0) {
    throw new HttpError(400, "EMPTY_COLLECTION", "This collection has no request");
  }
  return {
    workspaceId: col.workspaceId,
    collectionId: col.id,
    targetName: col.name,
    items,
  };
}

/** 展开场景测试：查询 scenario_steps 按 sortOrder 排列 */
async function expandScenario(
  targetId: string,
): Promise<{
  workspaceId: string;
  collectionId: string;
  targetName: string;
  items: RunnerJobItem[];
}> {
  // 查找场景条目
  const [scenario] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, targetId))
    .limit(1);
  if (!scenario || scenario.type !== "scenario") {
    throw new HttpError(404, "NOT_FOUND", "Scenario not found");
  }
  const [col] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, scenario.collectionId))
    .limit(1);
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");

  // 查询步骤列表
  const { scenarioSteps } = await import("../db/schema");
  const steps = await db
    .select()
    .from(scenarioSteps)
    .where(eq(scenarioSteps.scenarioId, targetId))
    .orderBy(asc(scenarioSteps.sortOrder), asc(scenarioSteps.createdAt));

  if (steps.length === 0) {
    throw new HttpError(400, "EMPTY_SCENARIO", "This scenario has no steps");
  }

  return {
    workspaceId: col.workspaceId,
    collectionId: col.id,
    targetName: scenario.name,
    items: steps.map((step) => ({
      itemId: step.id,
      caseId: null,
      name: `${scenario.name} / ${step.name}`,
      request: step.request as RequestConfig,
    })),
  };
}

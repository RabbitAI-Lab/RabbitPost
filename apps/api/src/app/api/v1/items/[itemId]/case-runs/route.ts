import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { EnvironmentVariable, RunJob } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import {
  collectionItems,
  environments,
  requestCases,
  runJobResults,
  runJobs,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../../lib/http";
import {
  countAssertions,
  runJobResultInputSchema,
  toRunJob,
} from "../../../../../../lib/runner";

type Ctx = { params: Promise<{ itemId: string }> };

/**
 * GET /api/v1/items/:itemId/case-runs?limit=50
 * 该接口的用例运行历史（targetType = "case"），新→旧；viewer+。
 */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { itemId } = await ctx.params;
  await requireItemRole(itemId, user.id);
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50,
    200,
  );
  const rows = await db
    .select()
    .from(runJobs)
    .where(and(eq(runJobs.targetType, "case"), eq(runJobs.targetId, itemId)))
    .orderBy(desc(runJobs.createdAt))
    .limit(limit);
  return ok<RunJob[]>(rows.map((r) => toRunJob(r)));
});

const reportSchema = z.object({
  /** single = 单条运行（caseId 必填）；batch = Run All 聚合（caseId 为 null） */
  kind: z.enum(["single", "batch"]),
  caseId: z.string().uuid().nullable().optional(),
  environmentId: z.string().uuid().nullable().optional(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  results: z.array(runJobResultInputSchema).min(1).max(500),
});

/**
 * POST /api/v1/items/:itemId/case-runs
 * Web Cases 面板上报一次用例运行：落一条终态 run_jobs（source=cli, targetType=case）
 * 与全部逐用例结果；editor+。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { itemId } = await ctx.params;
  const { collectionId, workspaceId } = await requireItemRole(itemId, user.id, "editor");
  const body = reportSchema.parse(await req.json());

  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");

  // 单条运行：caseId 必填且必须属于该接口
  let caseRow: typeof requestCases.$inferSelect | null = null;
  if (body.kind === "single") {
    if (!body.caseId) {
      throw new HttpError(400, "CASE_REQUIRED", "single run requires caseId");
    }
    const [found] = await db
      .select()
      .from(requestCases)
      .where(and(eq(requestCases.id, body.caseId), eq(requestCases.itemId, itemId)))
      .limit(1);
    if (!found) throw new HttpError(404, "NOT_FOUND", "Request case not found");
    caseRow = found;
  }

  // 环境必须属于同一 workspace；名称以服务端当前值为准；同时存变量快照（secret 脱敏）
  let environmentName: string | null = null;
  let environmentSnapshot: EnvironmentVariable[] | null = null;
  if (body.environmentId) {
    const [env] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, body.environmentId))
      .limit(1);
    if (!env || env.workspaceId !== workspaceId) {
      throw new HttpError(400, "ENV_MISMATCH", "Environment does not belong to this workspace");
    }
    environmentName = env.name;
    // 执行时的环境变量快照：secret 值脱敏，环境后续改动不影响历史可追溯
    environmentSnapshot = (env.variables as EnvironmentVariable[]).map((v) =>
      v.secret ? { ...v, value: "******" } : v,
    );
  }

  const [ws] = await db
    .select({ teamId: workspaces.teamId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new HttpError(404, "NOT_FOUND", "Workspace not found");

  const results = body.results;
  const succeeded = results.filter((r) => r.ok).length;
  const assertions = countAssertions(results);
  const targetName =
    body.kind === "single" ? `${item.name} / ${caseRow!.name}` : `${item.name}（全部用例）`;

  const [job] = await db
    .insert(runJobs)
    .values({
      teamId: ws.teamId,
      workspaceId,
      // Web Cases 面板直接执行上报，来源标记为 web（区别于 CLI 上传与 Runner 派发）
      source: "web",
      collectionId,
      caseId: body.kind === "single" ? body.caseId! : null,
      runnerId: null,
      agent: "rabbitpost-web",
      targetType: "case",
      targetId: itemId,
      targetName,
      environmentId: body.environmentId ?? null,
      environmentName,
      environmentSnapshot,
      concurrency: 1,
      status: results.every((r) => r.ok) ? "succeeded" : "failed",
      totalCount: results.length,
      succeededCount: succeeded,
      failedCount: results.length - succeeded,
      testPassedCount: assertions.passed,
      testFailedCount: assertions.failed,
      createdBy: user.id,
      claimedAt: new Date(body.startedAt),
      finishedAt: new Date(body.finishedAt),
    })
    .returning();
  if (!job) throw new Error("Failed to save case run");

  await db.insert(runJobResults).values(
    results.map((r) => ({
      jobId: job.id,
      itemId: r.itemId ?? itemId,
      caseId: r.caseId ?? null,
      name: r.name,
      method: r.method,
      url: r.url,
      ok: r.ok,
      status: r.status ?? null,
      statusText: r.statusText ?? null,
      sizeBytes: r.sizeBytes ?? null,
      durationMs: r.durationMs ?? null,
      error: r.error ?? null,
      testResults: r.testResults ?? null,
      consoleLogs: r.consoleLogs ?? null,
      request: (r.request as never) ?? null,
      responseHeaders: r.responseHeaders ?? null,
      responseBody: r.responseBody ?? null,
    })),
  );

  return ok<RunJob>(toRunJob(job), { status: 201 });
});

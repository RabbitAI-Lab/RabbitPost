import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  RUN_REPORT_FORMAT,
  RUN_REPORT_VERSION,
  RUN_SOURCES,
  RUN_TARGET_TYPES,
  type RunJob,
} from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import {
  collectionItems,
  environments,
  runJobResults,
  runJobs,
  runners,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireCollectionRole,
} from "../../../../../../lib/http";
import {
  countAssertions,
  runJobResultInputSchema,
  toRunJob,
} from "../../../../../../lib/runner";

type Ctx = { params: Promise<{ collectionId: string }> };

/** GET /api/v1/collections/:collectionId/runs?limit=50 — 该 Collection 的执行记录（viewer+） */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id);
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50,
    200,
  );
  const rows = await db
    .select({ job: runJobs, runnerName: runners.name })
    .from(runJobs)
    .leftJoin(runners, eq(runJobs.runnerId, runners.id))
    .where(eq(runJobs.collectionId, collectionId))
    .orderBy(desc(runJobs.createdAt))
    .limit(limit);
  return ok<RunJob[]>(rows.map((r) => toRunJob(r.job, r.runnerName)));
});

const reportSchema = z.object({
  format: z.literal(RUN_REPORT_FORMAT),
  version: z.literal(RUN_REPORT_VERSION),
  /** 来源标记：缺省 cli（CLI 上传），web 表示 Web Runner 直接执行后上报 */
  source: z.enum(RUN_SOURCES).optional(),
  agent: z.string().min(1).max(128),
  collectionId: z.string().uuid(),
  targetType: z.enum(RUN_TARGET_TYPES),
  targetId: z.string().uuid(),
  targetName: z.string().min(1).max(256),
  environmentId: z.string().uuid().nullable().optional(),
  environmentName: z.string().max(256).nullable().optional(),
  concurrency: z.number().int().min(1).max(64),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  summary: z.unknown().optional(),
  results: z.array(runJobResultInputSchema).max(5000),
});

/**
 * POST /api/v1/collections/:collectionId/runs — CLI 上传本机执行报告（editor+）。
 * 直接落一条终态 run_jobs（source=cli）与全部逐请求结果。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { collectionId } = await ctx.params;
  const { workspaceId } = await requireCollectionRole(collectionId, user.id, "editor");
  const report = reportSchema.parse(await req.json());

  if (report.collectionId !== collectionId) {
    throw new HttpError(400, "COLLECTION_MISMATCH", "Report collectionId does not match path");
  }
  if (report.targetType === "collection" && report.targetId !== collectionId) {
    throw new HttpError(400, "TARGET_MISMATCH", "Report target does not match collection");
  }
  if (report.targetType === "request") {
    const [item] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.id, report.targetId),
          eq(collectionItems.collectionId, collectionId),
        ),
      )
      .limit(1);
    if (!item) {
      throw new HttpError(400, "TARGET_MISMATCH", "Request does not belong to this collection");
    }
  }

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new HttpError(404, "NOT_FOUND", "Workspace not found");

  // 环境必须属于同一 workspace；名称以服务端当前值为准，客户端快照兜底
  let environmentName = report.environmentName ?? null;
  if (report.environmentId) {
    const [env] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, report.environmentId))
      .limit(1);
    if (!env || env.workspaceId !== workspaceId) {
      throw new HttpError(400, "ENV_MISMATCH", "Environment does not belong to this workspace");
    }
    environmentName = env.name;
  }

  const results = report.results;
  const succeeded = results.filter((r) => r.ok).length;
  const assertions = countAssertions(results);

  const [job] = await db
    .insert(runJobs)
    .values({
      teamId: ws.teamId,
      workspaceId,
      source: report.source ?? "cli",
      collectionId,
      runnerId: null,
      agent: report.agent,
      targetType: report.targetType,
      targetId: report.targetId,
      targetName: report.targetName,
      environmentId: report.environmentId ?? null,
      environmentName,
      concurrency: report.concurrency,
      // CLI 报告在本地已执行完，落库即终态
      status: results.every((r) => r.ok) ? "succeeded" : "failed",
      totalCount: results.length,
      succeededCount: succeeded,
      failedCount: results.length - succeeded,
      testPassedCount: assertions.passed,
      testFailedCount: assertions.failed,
      createdBy: user.id,
      claimedAt: new Date(report.startedAt),
      finishedAt: new Date(report.finishedAt),
    })
    .returning();
  if (!job) throw new Error("Failed to upload run report");

  if (results.length > 0) {
    await db.insert(runJobResults).values(
      results.map((r) => ({
        jobId: job.id,
        itemId: r.itemId ?? null,
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
      })),
    );
  }

  return ok<RunJob>(toRunJob(job), { status: 201 });
});

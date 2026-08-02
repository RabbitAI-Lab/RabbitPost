import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { RequestConfig } from "@rabbitpost/shared";
import { db } from "../../../../../../../db";
import { runJobResults, runJobs } from "../../../../../../../db/schema";
import { HttpError, ok } from "../../../../../../../lib/http";
import {
  countAssertions,
  handleRunnerRoute,
  runJobResultInputSchema,
} from "../../../../../../../lib/runner";

type Ctx = { params: Promise<{ jobId: string }> };

const bodySchema = z.object({
  results: z.array(runJobResultInputSchema).min(1).max(200),
});

/**
 * POST /api/v1/runner/jobs/:jobId/results
 * Runner 分批上报逐请求结果；成功/失败计数用 SQL 自增，多协程并发上报也不会互相覆盖。
 */
export const POST = handleRunnerRoute(async (req, ctx: Ctx, runner) => {
  const { jobId } = await ctx.params;
  const [job] = await db
    .select()
    .from(runJobs)
    .where(and(eq(runJobs.id, jobId), eq(runJobs.runnerId, runner.id)))
    .limit(1);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Run job not claimed by this runner");

  const { results } = bodySchema.parse(await req.json());
  await db.insert(runJobResults).values(
    results.map((r) => ({
      jobId,
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
      request: (r.request as RequestConfig | null | undefined) ?? null,
      responseHeaders: r.responseHeaders ?? null,
      responseBody: r.responseBody ?? null,
    })),
  );

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const assertions = countAssertions(results);
  await db
    .update(runJobs)
    .set({
      succeededCount: sql`${runJobs.succeededCount} + ${succeeded}`,
      failedCount: sql`${runJobs.failedCount} + ${failed}`,
      testPassedCount: sql`${runJobs.testPassedCount} + ${assertions.passed}`,
      testFailedCount: sql`${runJobs.testFailedCount} + ${assertions.failed}`,
    })
    .where(eq(runJobs.id, jobId));

  return ok({ accepted: results.length });
});

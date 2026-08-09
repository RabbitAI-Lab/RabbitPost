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
 * Postgres text/jsonb 拒绝 NUL（\u0000）。二进制响应体经 rp-core 有损转字符串后
 * NUL 仍是合法 UTF-8 会被保留（如 PNG 字节流），直接落库会报
 * "invalid byte sequence for encoding UTF8: 0x00"。上报入口统一剥除。
 */
function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\0/g, "") as T;
  if (Array.isArray(value)) return value.map(stripNulDeep) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripNulDeep(v)]),
    ) as T;
  }
  return value;
}

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
    results.map((r) =>
      stripNulDeep({
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
      }),
    ),
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

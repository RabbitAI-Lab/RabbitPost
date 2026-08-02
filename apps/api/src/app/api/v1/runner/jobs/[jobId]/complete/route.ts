import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../../db";
import { runJobs } from "../../../../../../../db/schema";
import { HttpError, ok } from "../../../../../../../lib/http";
import { handleRunnerRoute } from "../../../../../../../lib/runner";

type Ctx = { params: Promise<{ jobId: string }> };

const bodySchema = z.object({
  /** 全部请求成功则 succeeded，否则 failed */
  status: z.enum(["succeeded", "failed"]),
  /** 整体失败原因（原文透传，如取任务后自身异常） */
  error: z.string().nullable().optional(),
});

/**
 * POST /api/v1/runner/jobs/:jobId/complete
 * Runner 执行完毕后收尾；已被管理端取消的任务不再改写状态。
 */
export const POST = handleRunnerRoute(async (req, ctx: Ctx, runner) => {
  const { jobId } = await ctx.params;
  const body = bodySchema.parse(await req.json());
  const [job] = await db
    .select()
    .from(runJobs)
    .where(and(eq(runJobs.id, jobId), eq(runJobs.runnerId, runner.id)))
    .limit(1);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Run job not claimed by this runner");
  if (job.status === "canceled") return ok({ status: job.status });

  const [row] = await db
    .update(runJobs)
    .set({
      status: body.status,
      error: body.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(runJobs.id, jobId))
    .returning();
  return ok({ status: row?.status ?? body.status });
});

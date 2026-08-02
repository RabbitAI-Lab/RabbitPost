import { asc, eq } from "drizzle-orm";
import type { RunJobDetail } from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { runJobResults, runJobs, runners } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireTeamRole,
} from "../../../../../lib/http";
import { toRunJob, toRunJobResult } from "../../../../../lib/runner";

type Ctx = { params: Promise<{ jobId: string }> };

async function loadJob(jobId: string, userId: string, minRole: "viewer" | "admin") {
  const [row] = await db
    .select({ job: runJobs, runnerName: runners.name })
    .from(runJobs)
    .leftJoin(runners, eq(runJobs.runnerId, runners.id))
    .where(eq(runJobs.id, jobId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Run job not found");
  await requireTeamRole(row.job.teamId, userId, minRole);
  return row;
}

/** GET /api/v1/runs/:jobId — 任务详情与逐请求结果（viewer+，Runs tab 可读） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { jobId } = await ctx.params;
  const { job, runnerName } = await loadJob(jobId, user.id, "viewer");
  const results = await db
    .select()
    .from(runJobResults)
    .where(eq(runJobResults.jobId, jobId))
    .orderBy(asc(runJobResults.createdAt));
  return ok<RunJobDetail>({
    job: toRunJob(job, runnerName),
    results: results.map(toRunJobResult),
  });
});

/** DELETE /api/v1/runs/:jobId — 取消尚未领取的任务（admin+） */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { jobId } = await ctx.params;
  const { job } = await loadJob(jobId, user.id, "admin");
  if (job.status !== "queued" && job.status !== "running") {
    throw new HttpError(409, "JOB_FINISHED", `Job is already ${job.status}`);
  }
  await db
    .update(runJobs)
    .set({ status: "canceled", finishedAt: new Date() })
    .where(eq(runJobs.id, jobId));
  return ok({ canceled: true });
});

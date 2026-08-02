import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RUN_TARGET_TYPES, type RunJob } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import {
  environments,
  runJobs,
  runners,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireTeamRole,
} from "../../../../../../lib/http";
import {
  expandRunTarget,
  requireRunnerInTeam,
  toRunJob,
} from "../../../../../../lib/runner";

type Ctx = { params: Promise<{ teamId: string }> };

/** GET /api/v1/teams/:teamId/runs?limit=50 — 最近的执行任务（admin+） */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50,
    200,
  );
  const rows = await db
    .select({ job: runJobs, runnerName: runners.name })
    .from(runJobs)
    .leftJoin(runners, eq(runJobs.runnerId, runners.id))
    .where(eq(runJobs.teamId, teamId))
    .orderBy(desc(runJobs.createdAt))
    .limit(limit);
  return ok<RunJob[]>(rows.map((r) => toRunJob(r.job, r.runnerName)));
});

const dispatchSchema = z.object({
  workspaceId: z.string().uuid(),
  /** 缺省表示团队内任意 Runner 均可领取 */
  runnerId: z.string().uuid().nullable().optional(),
  // Runner 只能执行 request / collection；case 是 Web 上报的历史类型，不可派发
  targetType: z.enum(["request", "collection"]),
  targetId: z.string().uuid(),
  environmentId: z.string().uuid().nullable().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});

/** POST /api/v1/teams/:teamId/runs — 派发执行任务给 Runner（admin+） */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = dispatchSchema.parse(await req.json());

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, body.workspaceId))
    .limit(1);
  if (!ws || ws.teamId !== teamId) {
    throw new HttpError(404, "NOT_FOUND", "Workspace not found in this team");
  }
  if (body.runnerId) await requireRunnerInTeam(body.runnerId, teamId);

  // 派发时即展开目标，既校验目标可执行，也把请求总数落库便于展示进度
  const target = await expandRunTarget(body.targetType, body.targetId);
  if (target.workspaceId !== body.workspaceId) {
    throw new HttpError(400, "TARGET_MISMATCH", "Target does not belong to workspace");
  }

  // 环境名快照：环境后续被改名/删除时，执行记录仍可读
  let environmentName: string | null = null;
  if (body.environmentId) {
    const [env] = await db
      .select({ name: environments.name })
      .from(environments)
      .where(eq(environments.id, body.environmentId))
      .limit(1);
    environmentName = env?.name ?? null;
  }

  const [row] = await db
    .insert(runJobs)
    .values({
      teamId,
      workspaceId: body.workspaceId,
      collectionId: target.collectionId,
      runnerId: body.runnerId ?? null,
      targetType: body.targetType,
      targetId: body.targetId,
      targetName: target.targetName,
      environmentId: body.environmentId ?? null,
      environmentName,
      concurrency: body.concurrency ?? 4,
      totalCount: target.items.length,
      createdBy: user.id,
    })
    .returning();
  if (!row) throw new Error("Failed to dispatch run job");
  return ok<RunJob>(toRunJob(row), { status: 201 });
});

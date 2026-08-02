import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  RUN_TARGET_TYPES,
  type RunnerJobAssignment,
} from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { workspaces } from "../../../../../db/schema";
import { HttpError, ok } from "../../../../../lib/http";
import {
  expandRunTarget,
  handleRunnerRoute,
  loadRunnerVariables,
} from "../../../../../lib/runner";

const bodySchema = z.object({
  // Runner 只能执行 request / collection / scenario；case 是 Web 上报的历史类型，不可派发
  targetType: z.enum(["request", "collection", "scenario"]),
  targetId: z.string().uuid(),
  environmentId: z.string().uuid().nullable().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});

/**
 * POST /api/v1/runner/expand
 * 供 CLI 的 run 子命令直接取一次目标定义（不落任务、不回传结果）；
 * 目标必须落在 Token 所属团队的 workspace 内。
 */
export const POST = handleRunnerRoute(async (req, _ctx, runner) => {
  const body = bodySchema.parse(await req.json());
  const target = await expandRunTarget(body.targetType, body.targetId);

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, target.workspaceId))
    .limit(1);
  if (!ws || ws.teamId !== runner.teamId) {
    throw new HttpError(403, "FORBIDDEN", "Target does not belong to this runner's team");
  }

  const assignment: RunnerJobAssignment = {
    // 本地执行不产生服务端任务，用空 id 标记
    jobId: "",
    workspaceId: target.workspaceId,
    targetType: body.targetType,
    targetName: target.targetName,
    concurrency: body.concurrency ?? 4,
    // Collection 级变量为底，Environment 覆盖
    variables: await loadRunnerVariables(body.environmentId ?? null, target.collectionId),
    items: target.items,
  };
  return ok<RunnerJobAssignment>(assignment);
});

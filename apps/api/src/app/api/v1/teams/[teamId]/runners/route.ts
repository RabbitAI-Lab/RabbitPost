import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Runner, RunnerWithToken } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { runners } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireTeamRole,
} from "../../../../../../lib/http";
import { EMBEDDED_RUNNER_NAME } from "../../../../../../lib/embedded-runner";
import { issueRunnerToken, toRunner } from "../../../../../../lib/runner";

type Ctx = { params: Promise<{ teamId: string }> };

/** GET /api/v1/teams/:teamId/runners — Runner 列表（admin+）。
 *  Runner 全局共享，不按团队隔离：返回所有 Runner，任意团队均可见。 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const rows = await db
    .select()
    .from(runners)
    .orderBy(desc(runners.createdAt));
  return ok<Runner[]>(rows.map(toRunner));
});

const registerSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
});

/**
 * POST /api/v1/teams/:teamId/runners — 注册 Runner（admin+）
 * 明文 Token 仅此一次返回，服务端只保留 sha256 摘要。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = registerSchema.parse(await req.json());

  // 拦截保留名：__embedded__ 由服务自动管理，手动注册会造成名称冲突与误判
  if (body.name === EMBEDDED_RUNNER_NAME) {
    throw new HttpError(
      400,
      "RUNNER_NAME_RESERVED",
      `Name "${EMBEDDED_RUNNER_NAME}" is reserved for the embedded runner`,
    );
  }

  // 同一团队内 Runner 名称不重复，避免运维时认错机器
  const [dup] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.teamId, teamId), eq(runners.name, body.name)))
    .limit(1);
  if (dup) {
    throw new HttpError(
      409,
      "RUNNER_NAME_TAKEN",
      `Runner "${body.name}" already exists in this team`,
    );
  }

  const { token, tokenHash, tokenPrefix } = issueRunnerToken();
  const [row] = await db
    .insert(runners)
    .values({
      teamId,
      name: body.name,
      description: body.description ?? null,
      tokenHash,
      tokenPrefix,
      createdBy: user.id,
    })
    .returning();
  if (!row) throw new Error("Failed to register runner");
  return ok<RunnerWithToken>({ runner: toRunner(row), token }, { status: 201 });
});

import { eq } from "drizzle-orm";
import { z } from "zod";
import { RUNNER_STATUSES, type Runner } from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { runners } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireTeamRole,
} from "../../../../../lib/http";
import { isEmbeddedRunner } from "../../../../../lib/embedded-runner";
import { toRunner } from "../../../../../lib/runner";

type Ctx = { params: Promise<{ runnerId: string }> };

/** 读取 Runner 并校验调用者在其所属团队中的角色 */
async function loadRunner(runnerId: string, userId: string) {
  const [row] = await db
    .select()
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Runner not found");
  await requireTeamRole(row.teamId, userId, "admin");
  return row;
}

/** 写操作前置校验：内嵌 Runner 随服务托管，禁止手动改名 / 启停 / 删除 */
function ensureNotEmbedded(name: string): void {
  if (isEmbeddedRunner(name)) {
    throw new HttpError(
      403,
      "EMBEDDED_RUNNER_PROTECTED",
      "Embedded runner is managed by the server and cannot be modified",
    );
  }
}

/** GET /api/v1/runners/:runnerId — admin+ */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { runnerId } = await ctx.params;
  const row = await loadRunner(runnerId, user.id);
  return ok<Runner>(toRunner(row));
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  status: z.enum(RUNNER_STATUSES).optional(),
});

/** PATCH /api/v1/runners/:runnerId — 改名 / 启用停用（admin+） */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { runnerId } = await ctx.params;
  const existing = await loadRunner(runnerId, user.id);
  ensureNotEmbedded(existing.name);
  const patch = patchSchema.parse(await req.json());
  const [row] = await db
    .update(runners)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(runners.id, runnerId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Runner not found");
  return ok<Runner>(toRunner(row));
});

/** DELETE /api/v1/runners/:runnerId — admin+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { runnerId } = await ctx.params;
  const existing = await loadRunner(runnerId, user.id);
  ensureNotEmbedded(existing.name);
  await db.delete(runners).where(eq(runners.id, runnerId));
  return ok({ deleted: true });
});

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { scenarioSteps } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ stepId: string }> };

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  sortOrder: z.number().int().optional(),
  /** 更新请求配置（整体替换） */
  request: z.record(z.string(), z.unknown()).optional(),
});

/** PATCH /api/v1/scenario-steps/:stepId — 更新步骤名称 / 排序 / 请求配置 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { stepId } = await ctx.params;

  // 先查步骤获取 scenarioId，再级联鉴权
  const [step] = await db
    .select()
    .from(scenarioSteps)
    .where(eq(scenarioSteps.id, stepId))
    .limit(1);
  if (!step) throw new HttpError(404, "NOT_FOUND", "Scenario step not found");
  await requireItemRole(step.scenarioId, user.id, "editor");

  const body = patchSchema.parse(await req.json());
  const [updated] = await db
    .update(scenarioSteps)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.request !== undefined
        ? { request: body.request as never }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(scenarioSteps.id, stepId))
    .returning();
  if (!updated) throw new HttpError(404, "NOT_FOUND", "Scenario step not found");
  return ok({ id: updated.id, name: updated.name, updatedAt: updated.updatedAt.toISOString() });
});

/** DELETE /api/v1/scenario-steps/:stepId — 删除步骤 */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { stepId } = await ctx.params;

  const [step] = await db
    .select()
    .from(scenarioSteps)
    .where(eq(scenarioSteps.id, stepId))
    .limit(1);
  if (!step) throw new HttpError(404, "NOT_FOUND", "Scenario step not found");
  await requireItemRole(step.scenarioId, user.id, "editor");

  await db.delete(scenarioSteps).where(eq(scenarioSteps.id, stepId));
  return ok({ deleted: true });
});

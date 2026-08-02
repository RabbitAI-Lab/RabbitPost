import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { requestCases } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireCaseRole,
} from "../../../../../lib/http";
import { toRequestCase } from "../../../../../lib/request-case";

type Ctx = { params: Promise<{ caseId: string }> };

/** GET /api/v1/cases/:caseId — 用例详情（含完整请求配置） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { caseId } = await ctx.params;
  await requireCaseRole(caseId, user.id);
  const [row] = await db
    .select()
    .from(requestCases)
    .where(eq(requestCases.id, caseId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Request case not found");
  return ok(toRequestCase(row));
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2000).nullable().optional(),
  /** 更新用例配置（整体替换） */
  request: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
});

/** PATCH /api/v1/cases/:caseId — 重命名 / 说明 / 保存用例配置 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { caseId } = await ctx.params;
  await requireCaseRole(caseId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [row] = await db
    .update(requestCases)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.request !== undefined ? { request: body.request as never } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(eq(requestCases.id, caseId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Request case not found");
  return ok(toRequestCase(row));
});

/** DELETE /api/v1/cases/:caseId — editor+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { caseId } = await ctx.params;
  await requireCaseRole(caseId, user.id, "editor");
  await db.delete(requestCases).where(eq(requestCases.id, caseId));
  return ok({ deleted: true });
});

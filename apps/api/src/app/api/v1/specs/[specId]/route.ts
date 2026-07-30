import { eq } from "drizzle-orm";
import { z } from "zod";
import { SPEC_FORMATS } from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { specs } from "../../../../../db/schema";
import { handleRoute, HttpError, ok, requireSpecRole } from "../../../../../lib/http";
import { toSpec } from "../../../../../lib/spec-row";

type Ctx = { params: Promise<{ specId: string }> };

/** GET /api/v1/specs/:specId — 单个 spec（含定义正文） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { specId } = await ctx.params;
  await requireSpecRole(specId, user.id);
  const [row] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Spec not found");
  return ok(toSpec(row));
});

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  format: z.enum([...SPEC_FORMATS]).optional(),
  content: z.string().optional(),
});

/** PATCH /api/v1/specs/:specId — 重命名 / 切换格式 / 保存定义，editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { specId } = await ctx.params;
  await requireSpecRole(specId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [row] = await db
    .update(specs)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(specs.id, specId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Spec not found");
  return ok(toSpec(row));
});

/** DELETE /api/v1/specs/:specId — editor+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { specId } = await ctx.params;
  await requireSpecRole(specId, user.id, "editor");
  await db.delete(specs).where(eq(specs.id, specId));
  return ok({ deleted: true });
});

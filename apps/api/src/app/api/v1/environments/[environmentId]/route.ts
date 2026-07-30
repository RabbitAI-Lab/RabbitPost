import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { environments } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireEnvironmentRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ environmentId: string }> };

/** GET /api/v1/environments/:environmentId */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { environmentId } = await ctx.params;
  await requireEnvironmentRole(environmentId, user.id);
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Environment not found");
  return ok({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    variables: row.variables,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});

const variableSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  variables: z.array(variableSchema).optional(),
});

/** PATCH /api/v1/environments/:environmentId — editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { environmentId } = await ctx.params;
  await requireEnvironmentRole(environmentId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [row] = await db
    .update(environments)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(environments.id, environmentId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Environment not found");
  return ok({ id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() });
});

/** DELETE /api/v1/environments/:environmentId — editor+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { environmentId } = await ctx.params;
  await requireEnvironmentRole(environmentId, user.id, "editor");
  await db.delete(environments).where(eq(environments.id, environmentId));
  return ok({ deleted: true });
});

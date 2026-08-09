import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { workspaces } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireWorkspaceRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ workspaceId: string }> };

/** GET /api/v1/workspaces/:workspaceId */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new HttpError(404, "NOT_FOUND", "Workspace not found");
  return ok({
    id: ws.id,
    teamId: ws.teamId,
    name: ws.name,
    description: ws.description,
    createdBy: ws.createdBy,
    variables: ws.variables ?? [],
    createdAt: ws.createdAt.toISOString(),
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(512).nullable().optional(),
  variables: z
    .array(
      z
        .object({
          id: z.string(),
          key: z.string(),
          value: z.string(),
          enabled: z.boolean(),
          description: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

/** PATCH /api/v1/workspaces/:workspaceId — editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [ws] = await db
    .update(workspaces)
    .set(body)
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!ws) throw new HttpError(404, "NOT_FOUND", "Workspace not found");
  return ok({ id: ws.id, name: ws.name, description: ws.description, variables: ws.variables ?? [] });
});

/** DELETE /api/v1/workspaces/:workspaceId — admin+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "admin");
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  return ok({ deleted: true });
});

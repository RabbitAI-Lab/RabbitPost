import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Environment } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { environments } from "../../../../../../db/schema";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ workspaceId: string }> };

function toEnvironment(row: typeof environments.$inferSelect): Environment {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    variables: row.variables,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/v1/workspaces/:workspaceId/environments */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const rows = await db
    .select()
    .from(environments)
    .where(eq(environments.workspaceId, workspaceId))
    .orderBy(asc(environments.createdAt));
  return ok(rows.map(toEnvironment));
});

const variableSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  variables: z.array(variableSchema).default([]),
});

/** POST /api/v1/workspaces/:workspaceId/environments — editor+ */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = createSchema.parse(await req.json());
  const [row] = await db
    .insert(environments)
    .values({ workspaceId, name: body.name, variables: body.variables })
    .returning();
  if (!row) throw new Error("Failed to create environment");
  return ok(toEnvironment(row), { status: 201 });
});

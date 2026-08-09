import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Workspace } from "@rabbitpost/shared";
import { db } from "../../../../db";
import { workspaces } from "../../../../db/schema";
import { seedDemoCollection } from "../../../../lib/demo-collection";
import { handleRoute, ok, requireTeamRole } from "../../../../lib/http";

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    variables: row.variables ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/v1/workspaces?teamId=xxx */
export const GET = handleRoute(async (req, _ctx, user) => {
  const teamId = new URL(req.url).searchParams.get("teamId");
  if (!teamId) {
    // 未指定团队时返回空，前端应先选团队
    return ok([]);
  }
  await requireTeamRole(teamId, user.id);
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.teamId, teamId))
    .orderBy(desc(workspaces.createdAt));
  return ok(rows.map(toWorkspace));
});

const createSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
});

/** POST /api/v1/workspaces — editor+ 可创建 */
export const POST = handleRoute(async (req, _ctx, user) => {
  const body = createSchema.parse(await req.json());
  await requireTeamRole(body.teamId, user.id, "editor");
  const [ws] = await db
    .insert(workspaces)
    .values({
      teamId: body.teamId,
      name: body.name,
      description: body.description ?? null,
      createdBy: user.id,
    })
    .returning();
  if (!ws) throw new Error("Failed to create workspace");
  // 新 workspace 自动附带 Demo Collection（Rabbit Post Api Demo）
  await seedDemoCollection(ws.id);
  return ok(toWorkspace(ws), { status: 201 });
});

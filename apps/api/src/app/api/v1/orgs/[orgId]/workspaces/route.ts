import { count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import {
  collections,
  collectionItems,
  teams,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

interface OrgWorkspaceRow {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  collectionCount: number;
  requestCount: number;
}

/** GET /api/v1/orgs/:orgId/workspaces — 跨团队 Workspace 列表 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  const orgTeams = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);
  if (orgTeamIds.length === 0) return ok<OrgWorkspaceRow[]>([]);

  const teamMap = new Map(orgTeams.map((t) => [t.id, t.name]));
  const wsRows = await db
    .select()
    .from(workspaces)
    .where(inArray(workspaces.teamId, orgTeamIds))
    .orderBy(desc(workspaces.createdAt));

  const result: OrgWorkspaceRow[] = [];
  for (const ws of wsRows) {
    // 合并两次 collections 查询为一次
    const colRows = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.workspaceId, ws.id));
    const colIds = colRows.map((c) => c.id);
    const collectionCount = colIds.length;
    let requestCount = 0;
    if (colIds.length > 0) {
      const reqCountRows = await db
        .select({ c: count() })
        .from(collectionItems)
        .where(inArray(collectionItems.collectionId, colIds));
      requestCount = Number(reqCountRows[0]?.c ?? 0);
    }

    result.push({
      id: ws.id,
      teamId: ws.teamId,
      teamName: teamMap.get(ws.teamId) ?? "Unknown",
      name: ws.name,
      description: ws.description,
      createdBy: ws.createdBy,
      createdAt: ws.createdAt.toISOString(),
      collectionCount,
      requestCount,
    });
  }
  return ok(result);
});

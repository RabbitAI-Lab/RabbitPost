import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import { runners, teams } from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

interface OrgRunnerRow {
  id: string;
  name: string;
  description: string | null;
  tokenPrefix: string;
  status: string;
  lastSeenAt: string | null;
  version: string | null;
  platform: string | null;
  teamId: string;
  teamName: string;
  createdAt: string;
}

/** GET /api/v1/orgs/:orgId/runners — 企业下所有 Runner */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  const orgTeams = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);
  const teamNameMap = new Map(orgTeams.map((t) => [t.id, t.name]));
  if (orgTeamIds.length === 0) return ok<OrgRunnerRow[]>([]);

  const rows = await db
    .select()
    .from(runners)
    .where(inArray(runners.teamId, orgTeamIds))
    .orderBy(desc(runners.createdAt));

  const result: OrgRunnerRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    tokenPrefix: r.tokenPrefix,
    status: r.status,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    version: r.version,
    platform: r.platform,
    teamId: r.teamId,
    teamName: teamNameMap.get(r.teamId) ?? "Unknown",
    createdAt: r.createdAt.toISOString(),
  }));
  return ok(result);
});

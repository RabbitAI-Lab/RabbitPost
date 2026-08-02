import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import {
  histories,
  organizationMembers,
  organizations,
  teams,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

interface BillingInfo {
  plan: string;
  status: string;
  seatLimit: number;
  seatUsed: number;
  requestQuota: number;
  /** 当前周期已用请求量（近 30 天 histories 估算） */
  requestUsedEstimate: number;
}

/** GET /api/v1/orgs/:orgId/billing — 计费与配额信息 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "billing");

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new HttpError(404, "NOT_FOUND", "Organization not found");

  const seatRows = await db
    .select({ c: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const seatUsed = Number(seatRows[0]?.c ?? 0);

  // 近 30 天请求量估算
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let requestUsedEstimate = 0;
  const orgTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);
  if (orgTeamIds.length > 0) {
    const wsRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.teamId, orgTeamIds));
    const wsIds = wsRows.map((w) => w.id);
    if (wsIds.length > 0) {
      const reqRows = await db
        .select({ c: count() })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, since)));
      requestUsedEstimate = Number(reqRows[0]?.c ?? 0);
    }
  }

  const info: BillingInfo = {
    plan: org.plan,
    status: org.status,
    seatLimit: org.seatLimit,
    seatUsed,
    requestQuota: org.requestQuota,
    requestUsedEstimate,
  };
  return ok(info);
});

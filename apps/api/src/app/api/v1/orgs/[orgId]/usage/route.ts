import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { UsageDataPoint, UsageMetric, UsageSummary } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { histories, runJobs, teams, workspaces } from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/usage?metric=&from=&to=&groupBy= */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  const sp = new URL(req.url).searchParams;
  const metric = (sp.get("metric") ?? "request_sent") as UsageMetric;
  const from = sp.get("from")
    ? new Date(sp.get("from")!)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date();
  const groupBy = (sp.get("groupBy") ?? "total") as UsageSummary["groupBy"];

  // 获取企业下所有团队 + workspace
  const orgTeams = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);
  const teamNameMap = new Map(orgTeams.map((t) => [t.id, t.name]));
  if (orgTeamIds.length === 0) {
    return ok<UsageSummary>({ metric, groupBy, from: from.toISOString(), to: to.toISOString(), points: [], total: 0 });
  }

  const wsRows = await db
    .select({ id: workspaces.id, teamId: workspaces.teamId })
    .from(workspaces)
    .where(inArray(workspaces.teamId, orgTeamIds));
  const wsIds = wsRows.map((w) => w.id);
  const wsTeamMap = new Map(wsRows.map((w) => [w.id, w.teamId]));

  const points: UsageDataPoint[] = [];
  let total = 0;

  if (metric === "request_sent") {
    if (wsIds.length === 0) return ok<UsageSummary>({ metric, groupBy, from: from.toISOString(), to: to.toISOString(), points: [], total: 0 });

    if (groupBy === "total") {
      const rows = await db
        .select({
          day: sql<string>`to_char(${histories.createdAt}, 'YYYY-MM-DD')`,
          c: count(),
        })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, from), lte(histories.createdAt, to)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      for (const r of rows) {
        points.push({ label: r.day, count: Number(r.c) });
        total += Number(r.c);
      }
    } else if (groupBy === "workspace") {
      const rows = await db
        .select({
          wsId: histories.workspaceId,
          day: sql<string>`to_char(${histories.createdAt}, 'YYYY-MM-DD')`,
          c: count(),
        })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, from), lte(histories.createdAt, to)))
        .groupBy(histories.workspaceId, sql`2`)
        .orderBy(sql`2`);
      for (const r of rows) {
        points.push({ label: r.day, group: r.wsId, count: Number(r.c) });
        total += Number(r.c);
      }
    } else if (groupBy === "team") {
      const rows = await db
        .select({
          wsId: histories.workspaceId,
          c: count(),
        })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, from), lte(histories.createdAt, to)))
        .groupBy(histories.workspaceId);
      const teamAgg = new Map<string, number>();
      for (const r of rows) {
        const teamId = wsTeamMap.get(r.wsId);
        if (!teamId) continue;
        teamAgg.set(teamId, (teamAgg.get(teamId) ?? 0) + Number(r.c));
        total += Number(r.c);
      }
      for (const [teamId, c] of teamAgg) {
        points.push({ label: from.toISOString().slice(0, 10), group: teamNameMap.get(teamId) ?? teamId, count: c });
      }
    } else if (groupBy === "member") {
      const rows = await db
        .select({
          userId: histories.userId,
          c: count(),
        })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, from), lte(histories.createdAt, to)))
        .groupBy(histories.userId);
      for (const r of rows) {
        points.push({ label: from.toISOString().slice(0, 10), group: r.userId, count: Number(r.c) });
        total += Number(r.c);
      }
    }
  } else if (metric === "run_executed") {
    if (groupBy === "total") {
      const rows = await db
        .select({
          day: sql<string>`to_char(${runJobs.createdAt}, 'YYYY-MM-DD')`,
          c: count(),
        })
        .from(runJobs)
        .where(and(inArray(runJobs.teamId, orgTeamIds), gte(runJobs.createdAt, from), lte(runJobs.createdAt, to)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      for (const r of rows) {
        points.push({ label: r.day, count: Number(r.c) });
        total += Number(r.c);
      }
    } else if (groupBy === "team") {
      const rows = await db
        .select({ teamId: runJobs.teamId, c: count() })
        .from(runJobs)
        .where(and(inArray(runJobs.teamId, orgTeamIds), gte(runJobs.createdAt, from), lte(runJobs.createdAt, to)))
        .groupBy(runJobs.teamId);
      for (const r of rows) {
        points.push({ label: from.toISOString().slice(0, 10), group: teamNameMap.get(r.teamId) ?? r.teamId, count: Number(r.c) });
        total += Number(r.c);
      }
    }
  }

  return ok<UsageSummary>({ metric, groupBy, from: from.toISOString(), to: to.toISOString(), points, total });
});

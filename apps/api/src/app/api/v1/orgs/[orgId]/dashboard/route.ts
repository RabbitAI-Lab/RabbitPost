import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { AuditLog, DashboardSummary, UsageDataPoint } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import {
  auditLogs,
  collections,
  histories,
  organizationMembers,
  runJobs,
  teams,
  users,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/dashboard — KPI 聚合 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  // 企业下所有团队
  const orgTeams = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);
  const teamMap = new Map(orgTeams.map((t) => [t.id, t.name]));

  // 基础计数（复用已查数据避免冗余查询）
  const teamCount = orgTeams.length;
  const memberRows = await db
    .select({ c: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const memberCount = Number(memberRows[0]?.c ?? 0);

  let workspaceCount = 0;
  let collectionCount = 0;
  let requestSent30d = 0;
  let runExecuted30d = 0;
  let runPassed30d = 0;
  let runFailed30d = 0;
  const requestTrend: UsageDataPoint[] = [];
  const runTrend: UsageDataPoint[] = [];
  const teamActivity: DashboardSummary["teamActivity"] = [];

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  if (orgTeamIds.length > 0) {
    // Workspace 数
    const wsCountRows = await db
      .select({ c: count() })
      .from(workspaces)
      .where(inArray(workspaces.teamId, orgTeamIds));
    workspaceCount = Number(wsCountRows[0]?.c ?? 0);

    // 获取企业下所有 workspace ids
    const wsRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.teamId, orgTeamIds));
    const wsIds = wsRows.map((w) => w.id);

    if (wsIds.length > 0) {
      // Collection 数
      const colCountRows = await db
        .select({ c: count() })
        .from(collections)
        .where(inArray(collections.workspaceId, wsIds));
      collectionCount = Number(colCountRows[0]?.c ?? 0);

      // 近 30 天请求量（从 histories 表）
      const reqRows = await db
        .select({
          day: sql<string>`to_char(${histories.createdAt}, 'YYYY-MM-DD')`,
          c: count(),
        })
        .from(histories)
        .where(and(inArray(histories.workspaceId, wsIds), gte(histories.createdAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      requestSent30d = reqRows.reduce((s, r) => s + Number(r.c), 0);
      for (const r of reqRows) {
        requestTrend.push({ label: r.day, count: Number(r.c) });
      }

      // 近 30 天运行量（从 run_jobs 表）
      const runRows = await db
        .select({
          day: sql<string>`to_char(${runJobs.createdAt}, 'YYYY-MM-DD')`,
          c: count(),
        })
        .from(runJobs)
        .where(and(inArray(runJobs.teamId, orgTeamIds), gte(runJobs.createdAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      runExecuted30d = runRows.reduce((s, r) => s + Number(r.c), 0);
      for (const r of runRows) {
        runTrend.push({ label: r.day, count: Number(r.c) });
      }

      // 运行通过/失败（从 run_jobs 聚合）
      const statusRows = await db
        .select({
          status: runJobs.status,
          c: count(),
        })
        .from(runJobs)
        .where(and(inArray(runJobs.teamId, orgTeamIds), gte(runJobs.createdAt, since)))
        .groupBy(runJobs.status);
      for (const r of statusRows) {
        if (r.status === "succeeded") runPassed30d += Number(r.c);
        if (r.status === "failed") runFailed30d += Number(r.c);
      }

      // 团队活跃度排行（按近 30 天 histories 请求数，单次 join 聚合避免 N+1）
      const teamActivityRows = await db
        .select({
          teamId: workspaces.teamId,
          c: count(),
        })
        .from(histories)
        .innerJoin(workspaces, eq(histories.workspaceId, workspaces.id))
        .where(
          and(
            inArray(workspaces.teamId, orgTeamIds),
            gte(histories.createdAt, since),
          ),
        )
        .groupBy(workspaces.teamId);
      const activityMap = new Map<string, number>();
      for (const r of teamActivityRows) {
        activityMap.set(r.teamId, Number(r.c));
      }
      for (const teamId of orgTeamIds) {
        teamActivity.push({
          teamId,
          teamName: teamMap.get(teamId) ?? "Unknown",
          requestCount: activityMap.get(teamId) ?? 0,
        });
      }
      teamActivity.sort((a, b) => b.requestCount - a.requestCount);
    }
  }

  // 最近活动（审计日志）
  const recentLogRows = await db
    .select({ log: auditLogs, actorName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorId, users.id))
    .where(eq(auditLogs.orgId, orgId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(20);
  const recentActivity: AuditLog[] = recentLogRows.map((r) => ({
    id: r.log.id,
    orgId: r.log.orgId,
    actorId: r.log.actorId,
    actorName: r.actorName,
    action: r.log.action,
    targetType: r.log.targetType,
    targetId: r.log.targetId,
    targetName: r.log.targetName,
    detail: (r.log.detail as Record<string, unknown>) ?? null,
    ip: r.log.ip,
    createdAt: r.log.createdAt.toISOString(),
  }));

  const summary: DashboardSummary = {
    teamCount,
    activeTeamCount: teamCount,
    memberCount,
    workspaceCount,
    collectionCount,
    requestSent30d,
    runExecuted30d,
    runPassed30d,
    runFailed30d,
    requestTrend,
    runTrend,
    teamActivity: teamActivity.slice(0, 5),
    recentActivity,
  };
  return ok(summary);
});

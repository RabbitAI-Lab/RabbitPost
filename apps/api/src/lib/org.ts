import { eq } from "drizzle-orm";
import type { Organization, OrgMember, UsageMetric } from "@rabbitpost/shared";
import { db } from "../db";
import { auditLogs, organizationMembers, organizations, teams, usageEvents, users } from "../db/schema";

/** Organization 行 → DTO */
export function toOrg(
  row: typeof organizations.$inferSelect,
  role?: Organization["role"],
): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logoUrl,
    domain: row.domain,
    plan: row.plan,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    role,
  };
}

/** 生成唯一 slug（带随机后缀） */
export function slugifyOrg(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "org"}-${suffix}`;
}

/** 写入一条审计日志 */
export async function writeAuditLog(input: {
  orgId: string;
  actorId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: input.orgId,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    targetName: input.targetName ?? null,
    detail: input.detail ?? null,
    ip: input.ip ?? null,
  });
}

/** 写入一条用量事件 */
export async function writeUsageEvent(input: {
  orgId: string;
  metric: UsageMetric;
  teamId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  count?: number;
}): Promise<void> {
  await db.insert(usageEvents).values({
    orgId: input.orgId,
    metric: input.metric,
    teamId: input.teamId ?? null,
    workspaceId: input.workspaceId ?? null,
    userId: input.userId ?? null,
    count: input.count ?? 1,
  });
}

/** 将 organization_members + users 行映射为 OrgMember DTO */
export function toOrgMember(
  memberRow: typeof organizationMembers.$inferSelect,
  userRow: typeof users.$inferSelect,
  teamIds: string[] = [],
  lastActiveAt?: string | null,
): OrgMember {
  return {
    orgId: memberRow.orgId,
    userId: memberRow.userId,
    role: memberRow.role,
    joinedAt: memberRow.joinedAt.toISOString(),
    user: {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      avatarUrl: userRow.avatarUrl,
    },
    teamIds,
    lastActiveAt: lastActiveAt ?? null,
  };
}

/** 获取企业下所有团队 id */
export async function getOrgTeamIds(orgId: string): Promise<string[]> {
  const rows = await db.select({ id: teams.id }).from(teams).where(eq(teams.orgId, orgId));
  return rows.map((r) => r.id);
}

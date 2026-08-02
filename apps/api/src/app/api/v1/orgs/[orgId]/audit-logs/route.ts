import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { AuditLog } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { auditLogs, users } from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/audit-logs?action=&actorId=&from=&to=&limit= */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  const sp = new URL(req.url).searchParams;
  const action = sp.get("action");
  const actorId = sp.get("actorId");
  const from = sp.get("from");
  const to = sp.get("to");
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 500);

  const conditions = [eq(auditLogs.orgId, orgId)];
  if (action) conditions.push(eq(auditLogs.action, action));
  if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
  if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
  if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

  const rows = await db
    .select({ log: auditLogs, actorName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const logs: AuditLog[] = rows.map((r) => ({
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
  return ok(logs);
});

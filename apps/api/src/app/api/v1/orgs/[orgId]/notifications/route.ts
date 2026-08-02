import { and, desc, eq } from "drizzle-orm";
import type { Notification } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { notifications } from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/notifications — 通知列表 */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  const sp = new URL(req.url).searchParams;
  const level = sp.get("level"); // org_admin | team_admin
  const unreadOnly = sp.get("unread") === "true";
  const limit = Math.min(Number(sp.get("limit") ?? 50) || 50, 200);

  const conditions = [eq(notifications.orgId, orgId)];
  if (level === "org_admin" || level === "team_admin") {
    conditions.push(eq(notifications.level, level));
  }
  if (unreadOnly) conditions.push(eq(notifications.read, false));

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const result: Notification[] = rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    level: r.level,
    title: r.title,
    body: r.body,
    actorId: r.actorId,
    actorName: r.actorName,
    teamId: r.teamId,
    teamName: r.teamName,
    read: r.read,
    createdAt: r.createdAt.toISOString(),
  }));
  return ok(result);
});

/** PATCH /api/v1/orgs/:orgId/notifications — 标记已读 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);
  const body = (await req.json()) as { id?: string; all?: boolean };

  if (body.all) {
    await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.orgId, orgId));
  } else if (body.id) {
    await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, body.id), eq(notifications.orgId, orgId)));
  }
  return ok({ updated: true });
});

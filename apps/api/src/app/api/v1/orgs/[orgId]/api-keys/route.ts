import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import {
  apiKeys,
  organizationMembers,
  users,
} from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ orgId: string }> };

interface OrgApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  userId: string;
  userName: string;
  userEmail: string | null;
}

/** GET /api/v1/orgs/:orgId/api-keys — 企业下所有成员的 API Key 列表 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  const memberRows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const memberUserIds = memberRows.map((m) => m.userId);
  if (memberUserIds.length === 0) return ok<OrgApiKeyRow[]>([]);

  const rows = await db
    .select({ key: apiKeys, userName: users.name, userEmail: users.email })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(inArray(apiKeys.userId, memberUserIds))
    .orderBy(desc(apiKeys.createdAt));

  const result: OrgApiKeyRow[] = rows.map((r) => ({
    id: r.key.id,
    name: r.key.name,
    keyPrefix: r.key.keyPrefix,
    lastUsedAt: r.key.lastUsedAt?.toISOString() ?? null,
    createdAt: r.key.createdAt.toISOString(),
    userId: r.key.userId,
    userName: r.userName,
    userEmail: r.userEmail,
  }));
  return ok(result);
});

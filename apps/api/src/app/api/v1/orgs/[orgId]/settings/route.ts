import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../db";
import { organizations } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";
import { writeAuditLog } from "../../../../../../lib/org";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/settings */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new HttpError(404, "NOT_FOUND", "Organization not found");
  return ok({
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoUrl,
    domain: org.domain,
    plan: org.plan,
    status: org.status,
    seatLimit: org.seatLimit,
    requestQuota: org.requestQuota,
    ssoConfig: org.ssoConfig ?? null,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  logoUrl: z.string().url().nullable().optional(),
  domain: z.string().max(255).nullable().optional(),
  seatLimit: z.number().int().min(0).optional(),
  requestQuota: z.number().int().min(0).optional(),
  ssoConfig: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** PATCH /api/v1/orgs/:orgId/settings — admin+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const body = patchSchema.parse(await req.json());
  const [org] = await db
    .update(organizations)
    .set(body)
    .where(eq(organizations.id, orgId))
    .returning();
  if (!org) throw new HttpError(404, "NOT_FOUND", "Organization not found");

  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "org.settings_update",
    targetType: "org",
    targetId: org.id,
    targetName: org.name,
    detail: body as Record<string, unknown>,
  });

  return ok({
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoUrl,
    domain: org.domain,
    plan: org.plan,
    status: org.status,
    seatLimit: org.seatLimit,
    requestQuota: org.requestQuota,
    ssoConfig: org.ssoConfig ?? null,
  });
});

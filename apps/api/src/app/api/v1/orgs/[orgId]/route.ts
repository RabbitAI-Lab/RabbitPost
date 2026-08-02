import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { organizations } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireOrgRole,
} from "../../../../../lib/http";
import { toOrg, writeAuditLog } from "../../../../../lib/org";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  const role = await requireOrgRole(orgId, user.id);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new HttpError(404, "NOT_FOUND", "Organization not found");
  return ok(toOrg(org, role));
});

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  logoUrl: z.string().url().nullable().optional(),
  domain: z.string().max(255).nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  seatLimit: z.number().int().min(0).optional(),
  requestQuota: z.number().int().min(0).optional(),
});

/** PATCH /api/v1/orgs/:orgId — admin+ */
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
    action: "org.update",
    targetType: "org",
    targetId: org.id,
    targetName: org.name,
    detail: body as Record<string, unknown>,
  });

  return ok(toOrg(org));
});

/** DELETE /api/v1/orgs/:orgId — owner only */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "owner");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  await db.delete(organizations).where(eq(organizations.id, orgId));
  // 审计日志随级联删除而消失，此处无需再写
  return ok({ deleted: true, orgName: org?.name ?? null });
});

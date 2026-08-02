import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Organization } from "@rabbitpost/shared";
import { db } from "../../../../db";
import { organizationMembers, organizations } from "../../../../db/schema";
import { handleRoute, ok } from "../../../../lib/http";
import { slugifyOrg, toOrg, writeAuditLog } from "../../../../lib/org";

/** GET /api/v1/orgs — 当前用户的企业列表 */
export const GET = handleRoute(async (_req, _ctx, user) => {
  const rows = await db
    .select({ org: organizations, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(desc(organizations.createdAt));
  return ok<Organization[]>(rows.map((r) => toOrg(r.org, r.role)));
});

const createSchema = z.object({
  name: z.string().min(1).max(128),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64)
    .optional(),
  domain: z.string().max(255).optional(),
  logoUrl: z.string().url().optional(),
});

/** POST /api/v1/orgs — 创建企业，创建者自动成为 owner */
export const POST = handleRoute(async (req, _ctx, user) => {
  const body = createSchema.parse(await req.json());
  const [org] = await db
    .insert(organizations)
    .values({
      name: body.name,
      slug: body.slug ?? slugifyOrg(body.name),
      domain: body.domain ?? null,
      logoUrl: body.logoUrl ?? null,
      plan: "enterprise",
      createdBy: user.id,
    })
    .returning();
  if (!org) throw new Error("Failed to create organization");

  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId: user.id,
    role: "owner",
  });

  await writeAuditLog({
    orgId: org.id,
    actorId: user.id,
    action: "org.create",
    targetType: "org",
    targetId: org.id,
    targetName: org.name,
  });

  return ok(toOrg(org, "owner"), { status: 201 });
});

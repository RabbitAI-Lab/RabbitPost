import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ORG_ROLES, type OrgMember } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import {
  organizationMembers,
  teamMembers,
  teams,
  users,
} from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";
import { toOrgMember, writeAuditLog } from "../../../../../../lib/org";

type Ctx = { params: Promise<{ orgId: string }> };

/** GET /api/v1/orgs/:orgId/members — 企业成员列表（含团队归属） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  const rows = await db
    .select({ member: organizationMembers, user: users })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(desc(organizationMembers.joinedAt));

  // 获取企业下所有团队，用于计算成员的团队归属
  const orgTeams = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const orgTeamIds = orgTeams.map((t) => t.id);

  // 单次批量查询所有成员的团队归属（避免 N+1）
  const memberUserIds = rows.map((r) => r.user.id);
  const teamMembershipMap = new Map<string, string[]>();
  if (orgTeamIds.length > 0 && memberUserIds.length > 0) {
    const allTmRows = await db
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(
        and(
          inArray(teamMembers.teamId, orgTeamIds),
          inArray(teamMembers.userId, memberUserIds),
        ),
      );
    for (const tm of allTmRows) {
      const arr = teamMembershipMap.get(tm.userId) ?? [];
      arr.push(tm.teamId);
      teamMembershipMap.set(tm.userId, arr);
    }
  }

  const members: OrgMember[] = [];
  for (const r of rows) {
    members.push(toOrgMember(r.member, r.user, teamMembershipMap.get(r.user.id) ?? []));
  }
  return ok(members);
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORG_ROLES).exclude(["owner"]).default("member"),
});

/** POST /api/v1/orgs/:orgId/members — 邀请成员（admin+），被邀请人需至少登录过一次 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const body = inviteSchema.parse(await req.json());

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);
  if (!target) {
    throw new HttpError(
      404,
      "USER_NOT_FOUND",
      `No registered user with email ${body.email}. Ask them to sign in once first.`,
    );
  }

  await db
    .insert(organizationMembers)
    .values({ orgId, userId: target.id, role: body.role })
    .onConflictDoUpdate({
      target: [organizationMembers.orgId, organizationMembers.userId],
      set: { role: body.role },
    });

  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "member.invite",
    targetType: "member",
    targetId: target.id,
    targetName: target.name,
    detail: { email: body.email, role: body.role },
  });

  return ok({ added: true, userId: target.id }, { status: 201 });
});

const patchSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(ORG_ROLES).exclude(["owner"]),
});

/** PATCH /api/v1/orgs/:orgId/members — 调整企业角色（admin+，不能改 owner） */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const body = patchSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, body.userId),
      ),
    )
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_MODIFY_OWNER", "Cannot change the owner's role");
  }

  await db
    .update(organizationMembers)
    .set({ role: body.role })
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, body.userId),
      ),
    );

  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "member.role_change",
    targetType: "member",
    targetId: body.userId,
    detail: { from: existing.role, to: body.role },
  });

  return ok({ updated: true });
});

const deleteSchema = z.object({ userId: z.string().uuid() });

/** DELETE /api/v1/orgs/:orgId/members — 移除成员（admin+，不能移除 owner） */
export const DELETE = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const body = deleteSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, body.userId),
      ),
    )
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_REMOVE_OWNER", "Cannot remove the org owner");
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, body.userId),
      ),
    );

  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "member.remove",
    targetType: "member",
    targetId: body.userId,
  });

  return ok({ removed: true });
});

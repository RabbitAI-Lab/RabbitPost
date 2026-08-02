import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { TEAM_ROLES, type TeamMember } from "@rabbitpost/shared";
import { db } from "../../../../../../../db";
import { organizationMembers, teamMembers, teams, users } from "../../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireOrgRole,
} from "../../../../../../../lib/http";
import { notifyTeamAdmins, writeAuditLog } from "../../../../../../../lib/org";

type Ctx = { params: Promise<{ orgId: string; teamId: string }> };

/** GET /api/v1/orgs/:orgId/teams/:teamId — 团队详情（含 Team Admin 列表 + 全部成员） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId, teamId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  // 验证团队属于该企业
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)))
    .limit(1);
  if (!team) throw new HttpError(404, "NOT_FOUND", "Team not found in this organization");

  // 获取全部成员
  const memberRows = await db
    .select({ member: teamMembers, user: users })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));

  const members: TeamMember[] = memberRows.map((r) => ({
    teamId: r.member.teamId,
    userId: r.member.userId,
    role: r.member.role,
    joinedAt: r.member.joinedAt.toISOString(),
    user: {
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      avatarUrl: r.user.avatarUrl,
    },
  }));

  // Team Admin = role 为 owner 或 admin 的成员
  const admins = members
    .filter((m) => (m.role === "owner" || m.role === "admin") && m.user)
    .map((m) => ({
      userId: m.userId,
      name: m.user!.name,
      email: m.user!.email,
      avatarUrl: m.user!.avatarUrl,
      role: m.role,
    }));

  return ok({
    id: team.id,
    name: team.name,
    slug: team.slug,
    avatarUrl: team.avatarUrl,
    orgId: team.orgId,
    createdBy: team.createdBy,
    createdAt: team.createdAt.toISOString(),
    memberCount: members.length,
    admins,
    members,
  });
});

const addMemberSchema = z.object({
  /** 按邮箱查找已注册用户 */
  email: z.string().email(),
  role: z.enum(TEAM_ROLES).exclude(["owner"]).default("editor"),
});

/** POST /api/v1/orgs/:orgId/teams/:teamId/members — 添加成员到团队（admin+） */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId, teamId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  // 验证团队属于该企业
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)))
    .limit(1);
  if (!team) throw new HttpError(404, "NOT_FOUND", "Team not found in this organization");

  const body = addMemberSchema.parse(await req.json());

  // 查找用户
  const [target] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!target) {
    throw new HttpError(
      404,
      "USER_NOT_FOUND",
      `No registered user with email ${body.email}. Ask them to sign in once first.`,
    );
  }

  // 验证目标用户是企业成员
  const [orgMember] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, target.id)),
    )
    .limit(1);
  if (!orgMember) {
    throw new HttpError(
      403,
      "NOT_ORG_MEMBER",
      `User ${body.email} is not a member of this organization. Add them to the org first.`,
    );
  }

  // 添加到团队（幂等）
  await db
    .insert(teamMembers)
    .values({ teamId, userId: target.id, role: body.role })
    .onConflictDoUpdate({
      target: [teamMembers.teamId, teamMembers.userId],
      set: { role: body.role },
    });

  // 审计日志
  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "team.member_added",
    targetType: "member",
    targetId: target.id,
    targetName: target.name,
    detail: { teamId, teamName: team.name, role: body.role },
  });

  // 通知团队管理员
  await notifyTeamAdmins({
    orgId,
    teamId,
    actorId: user.id,
    title: "新成员加入团队",
    body: `${target.name}（${body.email}）已被添加到团队「${team.name}」，角色：${body.role}`,
  });

  return ok({ added: true, userId: target.id }, { status: 201 });
});

const patchMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(TEAM_ROLES).exclude(["owner"]),
});

/** PATCH /api/v1/orgs/:orgId/teams/:teamId/members — 调整团队成员角色（admin+） */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId, teamId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  const body = patchMemberSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Team member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_MODIFY_OWNER", "Cannot change the team owner's role");
  }

  await db
    .update(teamMembers)
    .set({ role: body.role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)));

  // 通知团队管理员
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  await notifyTeamAdmins({
    orgId,
    teamId,
    actorId: user.id,
    title: "成员角色变更",
    body: `团队成员角色已变更为 ${body.role}`,
  });

  return ok({ updated: true });
});

const deleteMemberSchema = z.object({ userId: z.string().uuid() });

/** DELETE /api/v1/orgs/:orgId/teams/:teamId/members — 移除团队成员（admin+） */
export const DELETE = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId, teamId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");

  const body = deleteMemberSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Team member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_REMOVE_OWNER", "Cannot remove the team owner");
  }

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)));

  // 通知团队管理员
  await notifyTeamAdmins({
    orgId,
    teamId,
    actorId: user.id,
    title: "成员被移除",
    body: `一名成员已从团队移除`,
  });

  return ok({ removed: true });
});

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { TEAM_ROLES, type TeamMember } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { teamMembers, users } from "../../../../../../db/schema";
import { handleRoute, HttpError, ok, requireTeamRole } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ teamId: string }> };

/** GET /api/v1/teams/:teamId/members */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id);
  const rows = await db
    .select({ member: teamMembers, user: users })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
  const members: TeamMember[] = rows.map((r) => ({
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
  return ok(members);
});

const addSchema = z.object({
  /** 按邮箱查找已登录过的用户 */
  email: z.string().email(),
  role: z.enum(TEAM_ROLES).exclude(["owner"]).default("editor"),
});

/** POST /api/v1/teams/:teamId/members — admin+；被邀请人需至少登录过一次 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = addSchema.parse(await req.json());

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);
  if (!target) {
    throw new HttpError(
      404,
      "USER_NOT_FOUND",
      `No registered user with email ${body.email}. Ask them to sign in via Casdoor once first.`,
    );
  }

  await db
    .insert(teamMembers)
    .values({ teamId, userId: target.id, role: body.role })
    .onConflictDoUpdate({
      target: [teamMembers.teamId, teamMembers.userId],
      set: { role: body.role },
    });
  return ok({ added: true, userId: target.id }, { status: 201 });
});

const patchSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(TEAM_ROLES).exclude(["owner"]),
});

/** PATCH /api/v1/teams/:teamId/members — 调整角色（admin+，不能改 owner） */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = patchSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_MODIFY_OWNER", "Cannot change the owner's role");
  }

  await db
    .update(teamMembers)
    .set({ role: body.role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)));
  return ok({ updated: true });
});

const deleteSchema = z.object({ userId: z.string().uuid() });

/** DELETE /api/v1/teams/:teamId/members — 移除成员（admin+，不能移除 owner） */
export const DELETE = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = deleteSchema.parse(await req.json());

  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)))
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Member not found");
  if (existing.role === "owner") {
    throw new HttpError(400, "CANNOT_REMOVE_OWNER", "Cannot remove the team owner");
  }

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, body.userId)));
  return ok({ removed: true });
});

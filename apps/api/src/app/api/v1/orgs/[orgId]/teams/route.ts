import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../db";
import {
  collections,
  teamMembers,
  teams,
  workspaces,
} from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireOrgRole,
} from "../../../../../../lib/http";
import { slugifyOrg, writeAuditLog, notifyOrgAdmins } from "../../../../../../lib/org";

type Ctx = { params: Promise<{ orgId: string }> };

interface OrgTeamRow {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  orgId: string | null;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  workspaceCount: number;
  collectionCount: number;
}

/** GET /api/v1/orgs/:orgId/teams — 企业下所有团队（含统计） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id);

  const teamRows = await db
    .select()
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(desc(teams.createdAt));

  const result: OrgTeamRow[] = [];
  for (const t of teamRows) {
    const memberRows = await db
      .select({ c: count() })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, t.id));
    const memberCount = memberRows[0]?.c ?? 0;
    const wsRows = await db
      .select({ c: count() })
      .from(workspaces)
      .where(eq(workspaces.teamId, t.id));
    const workspaceCount = wsRows[0]?.c ?? 0;
    const colRows = await db
      .select({ c: count() })
      .from(collections)
      .innerJoin(workspaces, eq(collections.workspaceId, workspaces.id))
      .where(eq(workspaces.teamId, t.id));
    const collectionCount = colRows[0]?.c ?? 0;

    result.push({
      id: t.id,
      name: t.name,
      slug: t.slug,
      avatarUrl: t.avatarUrl,
      orgId: t.orgId,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
      memberCount: Number(memberCount),
      workspaceCount: Number(workspaceCount),
      collectionCount: Number(collectionCount),
    });
  }
  return ok(result);
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64)
    .optional(),
});

/** POST /api/v1/orgs/:orgId/teams — 在企业下创建团队（admin+），创建者自动成为团队 owner */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { orgId } = await ctx.params;
  await requireOrgRole(orgId, user.id, "admin");
  const body = createSchema.parse(await req.json());

  const [team] = await db
    .insert(teams)
    .values({
      name: body.name,
      slug: body.slug ?? slugifyOrg(body.name),
      orgId,
      createdBy: user.id,
    })
    .returning();
  if (!team) throw new Error("Failed to create team");

  await db.insert(teamMembers).values({
    teamId: team.id,
    userId: user.id,
    role: "owner",
  });

  await writeAuditLog({
    orgId,
    actorId: user.id,
    action: "team.create",
    targetType: "team",
    targetId: team.id,
    targetName: team.name,
  });

  // 通知企业管理员
  await notifyOrgAdmins({
    orgId,
    actorId: user.id,
    title: "新团队创建",
    body: `团队「${team.name}」已创建`,
    teamId: team.id,
  });

  return ok(
    {
      id: team.id,
      name: team.name,
      slug: team.slug,
      avatarUrl: team.avatarUrl,
      orgId: team.orgId,
      createdBy: team.createdBy,
      createdAt: team.createdAt.toISOString(),
      memberCount: 1,
      workspaceCount: 0,
      collectionCount: 0,
    } satisfies OrgTeamRow,
    { status: 201 },
  );
});

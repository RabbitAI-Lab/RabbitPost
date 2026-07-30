import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Team } from "@rabbitpost/shared";
import { db } from "../../../../db";
import { teamMembers, teams } from "../../../../db/schema";
import { handleRoute, ok } from "../../../../lib/http";

function toTeam(
  row: typeof teams.$inferSelect,
  role?: Team["role"],
): Team {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    role,
  };
}

/** GET /api/v1/teams — 当前用户加入的团队列表 */
export const GET = handleRoute(async (_req, _ctx, user) => {
  const rows = await db
    .select({ team: teams, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, user.id))
    .orderBy(desc(teams.createdAt));
  return ok(rows.map((r) => toTeam(r.team, r.role)));
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64)
    .optional(),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "team"}-${suffix}`;
}

/** POST /api/v1/teams — 创建团队，创建者自动成为 owner */
export const POST = handleRoute(async (req, _ctx, user) => {
  const body = createSchema.parse(await req.json());
  const [team] = await db
    .insert(teams)
    .values({
      name: body.name,
      slug: body.slug ?? slugify(body.name),
      createdBy: user.id,
    })
    .returning();
  if (!team) throw new Error("Failed to create team");
  await db.insert(teamMembers).values({
    teamId: team.id,
    userId: user.id,
    role: "owner",
  });
  return ok(toTeam(team, "owner"), { status: 201 });
});

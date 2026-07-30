import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { teams } from "../../../../../db/schema";
import { handleRoute, HttpError, ok, requireTeamRole } from "../../../../../lib/http";

type Ctx = { params: Promise<{ teamId: string }> };

/** GET /api/v1/teams/:teamId */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { teamId } = await ctx.params;
  const role = await requireTeamRole(teamId, user.id);
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) throw new HttpError(404, "NOT_FOUND", "Team not found");
  return ok({
    id: team.id,
    name: team.name,
    slug: team.slug,
    avatarUrl: team.avatarUrl,
    createdBy: team.createdBy,
    createdAt: team.createdAt.toISOString(),
    role,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

/** PATCH /api/v1/teams/:teamId — 需要 admin+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "admin");
  const body = patchSchema.parse(await req.json());
  const [team] = await db
    .update(teams)
    .set(body)
    .where(eq(teams.id, teamId))
    .returning();
  if (!team) throw new HttpError(404, "NOT_FOUND", "Team not found");
  return ok({ id: team.id, name: team.name, slug: team.slug });
});

/** DELETE /api/v1/teams/:teamId — 仅 owner */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { teamId } = await ctx.params;
  await requireTeamRole(teamId, user.id, "owner");
  await db.delete(teams).where(eq(teams.id, teamId));
  return ok({ deleted: true });
});

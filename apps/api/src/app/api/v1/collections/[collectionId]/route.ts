import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { collections } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireCollectionRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ collectionId: string }> };

/** GET /api/v1/collections/:collectionId */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id);
  const [col] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
  return ok({
    id: col.id,
    workspaceId: col.workspaceId,
    name: col.name,
    description: col.description,
    sortOrder: col.sortOrder,
    createdAt: col.createdAt.toISOString(),
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).nullable().optional(),
});

/** PATCH /api/v1/collections/:collectionId — editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [col] = await db
    .update(collections)
    .set(body)
    .where(eq(collections.id, collectionId))
    .returning();
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
  return ok({ id: col.id, name: col.name, description: col.description });
});

/** DELETE /api/v1/collections/:collectionId — editor+（级联删除 items） */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id, "editor");
  await db.delete(collections).where(eq(collections.id, collectionId));
  return ok({ deleted: true });
});

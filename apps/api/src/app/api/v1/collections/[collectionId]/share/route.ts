import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CollectionShare } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionShares } from "../../../../../../db/schema";
import {
  handleRoute,
  ok,
  requireCollectionRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ collectionId: string }> };

type ShareRow = typeof collectionShares.$inferSelect;

function toShare(row: ShareRow): CollectionShare {
  return { token: row.token, createdAt: row.createdAt.toISOString() };
}

async function findShare(collectionId: string): Promise<ShareRow | undefined> {
  const [row] = await db
    .select()
    .from(collectionShares)
    .where(eq(collectionShares.collectionId, collectionId))
    .limit(1);
  return row;
}

/** GET /api/v1/collections/:collectionId/share — 当前分享链接（未分享则为 null） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id);
  const row = await findShare(collectionId);
  return ok({ share: row ? toShare(row) : null });
});

/** POST /api/v1/collections/:collectionId/share — 生成分享链接（已存在则复用），editor+ */
export const POST = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id, "editor");
  const existing = await findShare(collectionId);
  if (existing) return ok({ share: toShare(existing) });
  const [row] = await db
    .insert(collectionShares)
    .values({
      collectionId,
      token: randomBytes(24).toString("base64url"),
      createdBy: user.id,
    })
    .returning();
  return ok({ share: toShare(row!) });
});

/** DELETE /api/v1/collections/:collectionId/share — 撤销分享链接，editor+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id, "editor");
  await db
    .delete(collectionShares)
    .where(eq(collectionShares.collectionId, collectionId));
  return ok({ revoked: true });
});

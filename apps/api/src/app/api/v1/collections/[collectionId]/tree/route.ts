import { asc, eq } from "drizzle-orm";
import type { CollectionItem } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems } from "../../../../../../db/schema";
import { handleRoute, ok, requireCollectionRole } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ collectionId: string }> };

type ItemRow = typeof collectionItems.$inferSelect;

function toItem(row: ItemRow): CollectionItem {
  return {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    type: row.type,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    request: row.request ?? undefined,
    children: [],
  };
}

/** GET /api/v1/collections/:collectionId/tree — 返回嵌套树（folder/request） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id);
  const rows = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId))
    .orderBy(asc(collectionItems.sortOrder), asc(collectionItems.createdAt));

  const byId = new Map<string, CollectionItem>();
  const roots: CollectionItem[] = [];
  for (const row of rows) byId.set(row.id, toItem(row));
  for (const item of byId.values()) {
    if (item.parentId && byId.has(item.parentId)) {
      byId.get(item.parentId)!.children!.push(item);
    } else {
      roots.push(item);
    }
  }
  return ok(roots);
});

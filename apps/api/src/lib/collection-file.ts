import { asc, eq } from "drizzle-orm";
import type { CollectionItem, RpCollectionFile } from "@rabbitpost/shared";
import { buildCollectionFile } from "@rabbitpost/shared";
import { db } from "../db";
import { collectionItems, collections } from "../db/schema";
import { HttpError } from "./http";

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

/** 读取 Collection 的嵌套树（与 /tree 接口同序：sortOrder + createdAt） */
export async function loadCollectionTree(
  collectionId: string,
): Promise<CollectionItem[]> {
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
  return roots;
}

/** 组装 RabbitPost Collection 导出文件（文件下载与公开分享链接共用） */
export async function exportCollectionFile(
  collectionId: string,
): Promise<RpCollectionFile> {
  const [col] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (!col) throw new HttpError(404, "NOT_FOUND", "Collection not found");
  return buildCollectionFile(col, await loadCollectionTree(collectionId));
}

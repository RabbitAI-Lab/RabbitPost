import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { collectionItems } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/v1/items/:itemId — 单个条目详情（含完整请求配置） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { itemId } = await ctx.params;
  await requireItemRole(itemId, user.id);
  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");
  return ok({
    id: item.id,
    collectionId: item.collectionId,
    parentId: item.parentId,
    type: item.type,
    name: item.name,
    description: item.description,
    sortOrder: item.sortOrder,
    request: item.request ?? undefined,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
  /** 文件夹 Overview 文档（Markdown） */
  description: z.string().nullable().optional(),
  /** 更新请求配置（整体替换） */
  request: z.record(z.string(), z.unknown()).optional(),
});

/** PATCH /api/v1/items/:itemId — 重命名 / 移动 / 排序 / 保存请求配置 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { itemId } = await ctx.params;
  await requireItemRole(itemId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [item] = await db
    .update(collectionItems)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.request !== undefined
        ? { request: body.request as never }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, itemId))
    .returning();
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");
  return ok({ id: item.id, name: item.name, updatedAt: item.updatedAt.toISOString() });
});

/** DELETE /api/v1/items/:itemId — editor+（folder 下子级一并删除） */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { itemId } = await ctx.params;
  const { collectionId } = await requireItemRole(itemId, user.id, "editor");

  // 收集整棵子树 id 后一次性删除
  const all = await db
    .select({ id: collectionItems.id, parentId: collectionItems.parentId })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId));
  const toDelete = new Set<string>([itemId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of all) {
      if (row.parentId && toDelete.has(row.parentId) && !toDelete.has(row.id)) {
        toDelete.add(row.id);
        grew = true;
      }
    }
  }
  for (const id of toDelete) {
    await db.delete(collectionItems).where(eq(collectionItems.id, id));
  }
  return ok({ deleted: true, count: toDelete.size });
});

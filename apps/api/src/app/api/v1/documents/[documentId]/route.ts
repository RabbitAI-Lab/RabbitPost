import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { documentItems } from "../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireDocumentRole,
} from "../../../../../lib/http";

type Ctx = { params: Promise<{ documentId: string }> };

/** GET /api/v1/documents/:documentId — 单个条目详情（含正文） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { documentId } = await ctx.params;
  await requireDocumentRole(documentId, user.id);
  const [item] = await db
    .select()
    .from(documentItems)
    .where(eq(documentItems.id, documentId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Document item not found");
  return ok({
    id: item.id,
    workspaceId: item.workspaceId,
    parentId: item.parentId,
    type: item.type,
    name: item.name,
    content: item.content,
    sortOrder: item.sortOrder,
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
  /** 文档正文（Markdown） */
  content: z.string().nullable().optional(),
});

/** PATCH /api/v1/documents/:documentId — 重命名 / 移动 / 排序 / 保存正文 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { documentId } = await ctx.params;
  await requireDocumentRole(documentId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [item] = await db
    .update(documentItems)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      updatedAt: new Date(),
    })
    .where(eq(documentItems.id, documentId))
    .returning();
  if (!item) throw new HttpError(404, "NOT_FOUND", "Document item not found");
  return ok({ id: item.id, name: item.name, updatedAt: item.updatedAt.toISOString() });
});

/** DELETE /api/v1/documents/:documentId — editor+（folder 下子级一并删除） */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { documentId } = await ctx.params;
  const { workspaceId } = await requireDocumentRole(documentId, user.id, "editor");

  // 收集整棵子树 id 后一次性删除
  const all = await db
    .select({ id: documentItems.id, parentId: documentItems.parentId })
    .from(documentItems)
    .where(eq(documentItems.workspaceId, workspaceId));
  const toDelete = new Set<string>([documentId]);
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
    await db.delete(documentItems).where(eq(documentItems.id, id));
  }
  return ok({ deleted: true, count: toDelete.size });
});

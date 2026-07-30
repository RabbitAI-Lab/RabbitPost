import { and, asc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import type { DocumentItem } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { documentItems } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireWorkspaceRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ workspaceId: string }> };

type ItemRow = typeof documentItems.$inferSelect;

function toItem(row: ItemRow): DocumentItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    type: row.type,
    name: row.name,
    content: row.content,
    sortOrder: row.sortOrder,
    children: [],
  };
}

/** GET /api/v1/workspaces/:workspaceId/documents — 返回嵌套树（folder/document） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const rows = await db
    .select()
    .from(documentItems)
    .where(eq(documentItems.workspaceId, workspaceId))
    .orderBy(asc(documentItems.sortOrder), asc(documentItems.createdAt));

  const byId = new Map<string, DocumentItem>();
  const roots: DocumentItem[] = [];
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

const createSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  type: z.enum(["folder", "document"]),
  name: z.string().min(1).max(256),
  content: z.string().optional(),
});

/** POST /api/v1/workspaces/:workspaceId/documents — 新建目录或文档，editor+ */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = createSchema.parse(await req.json());

  // 校验父节点存在且是 folder
  if (body.parentId) {
    const [parent] = await db
      .select()
      .from(documentItems)
      .where(
        and(
          eq(documentItems.id, body.parentId),
          eq(documentItems.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!parent) throw new HttpError(404, "NOT_FOUND", "Parent item not found");
    if (parent.type !== "folder") {
      throw new HttpError(400, "INVALID_PARENT", "Parent must be a folder");
    }
  }

  // sortOrder 取同层最大值 + 1
  const [maxRow] = await db
    .select({ value: max(documentItems.sortOrder) })
    .from(documentItems)
    .where(
      and(
        eq(documentItems.workspaceId, workspaceId),
        body.parentId
          ? eq(documentItems.parentId, body.parentId)
          : isNull(documentItems.parentId),
      ),
    );
  const maxOrder = maxRow?.value ?? null;

  const [item] = await db
    .insert(documentItems)
    .values({
      workspaceId,
      parentId: body.parentId ?? null,
      type: body.type,
      name: body.name,
      content: body.type === "document" ? (body.content ?? "") : null,
      sortOrder: (maxOrder ?? -1) + 1,
    })
    .returning();
  if (!item) throw new Error("Failed to create document item");
  return ok(toItem(item), { status: 201 });
});

const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        parentId: z.string().uuid().nullable(),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1),
});

/** PATCH /api/v1/workspaces/:workspaceId/documents — 拖拽后全量重排（parentId + sortOrder），editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = reorderSchema.parse(await req.json());

  const rows = await db
    .select({ id: documentItems.id, type: documentItems.type })
    .from(documentItems)
    .where(eq(documentItems.workspaceId, workspaceId));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 校验：id 均属于该 workspace 且不重复；父节点必须同 workspace 且是 folder
  const seen = new Set<string>();
  for (const item of body.items) {
    if (!byId.has(item.id)) {
      throw new HttpError(404, "NOT_FOUND", "Document item not found");
    }
    if (seen.has(item.id)) {
      throw new HttpError(400, "DUPLICATE_ITEM", "Duplicate item id");
    }
    seen.add(item.id);
    if (item.parentId) {
      const parent = byId.get(item.parentId);
      if (!parent) {
        throw new HttpError(400, "INVALID_PARENT", "Parent must be in the same workspace");
      }
      if (parent.type !== "folder") {
        throw new HttpError(400, "INVALID_PARENT", "Parent must be a folder");
      }
    }
  }

  // 环检测：沿 parentId 上溯不能回到自身
  const parentOf = new Map(body.items.map((i) => [i.id, i.parentId]));
  for (const item of body.items) {
    const chain = new Set<string>([item.id]);
    let cur = item.parentId;
    while (cur) {
      if (chain.has(cur)) {
        throw new HttpError(400, "INVALID_PARENT", "Folder nesting cycle detected");
      }
      chain.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  for (const item of body.items) {
    await db
      .update(documentItems)
      .set({ parentId: item.parentId, sortOrder: item.sortOrder, updatedAt: new Date() })
      .where(eq(documentItems.id, item.id));
  }
  return ok({ updated: body.items.length });
});

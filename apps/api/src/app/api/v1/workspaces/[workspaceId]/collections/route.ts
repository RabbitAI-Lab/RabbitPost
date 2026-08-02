import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Collection } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collections, collectionItems } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireWorkspaceRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ workspaceId: string }> };

function toCollection(row: typeof collections.$inferSelect): Collection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /api/v1/workspaces/:workspaceId/collections */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const rows = await db
    .select()
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId))
    .orderBy(asc(collections.sortOrder), asc(collections.createdAt));
  return ok(rows.map(toCollection));
});

const createSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
});

/** POST /api/v1/workspaces/:workspaceId/collections — editor+ */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = createSchema.parse(await req.json());
  // 新建排在末尾：sortOrder = 当前最大值 + 1
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${collections.sortOrder}), -1)` })
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId));
  const [col] = await db
    .insert(collections)
    .values({
      workspaceId,
      name: body.name,
      description: body.description ?? null,
      sortOrder: Number(maxRow?.max ?? -1) + 1,
    })
    .returning();
  if (!col) throw new Error("Failed to create collection");
  // 自动创建「场景测试」根目录（isScenarioRoot=true，不可删除/移出）
  await db.insert(collectionItems).values({
    collectionId: col.id,
    parentId: null,
    type: "folder",
    name: "场景测试",
    sortOrder: -1,
    isScenarioRoot: true,
  });
  return ok(toCollection(col), { status: 201 });
});

const reorderSchema = z.object({
  /** 完整的 Collection id 新顺序（按数组下标重新编号 sortOrder） */
  orderedIds: z.array(z.string().uuid()).min(1),
});

/** PATCH /api/v1/workspaces/:workspaceId/collections — editor+，拖拽排序 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = reorderSchema.parse(await req.json());
  // 校验 id 均属于该 workspace，防止跨空间改写
  const rows = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId));
  const valid = new Set(rows.map((r) => r.id));
  for (const id of body.orderedIds) {
    if (!valid.has(id)) {
      throw new HttpError(400, "BAD_REQUEST", `Collection ${id} not in workspace`);
    }
  }
  for (let i = 0; i < body.orderedIds.length; i++) {
    await db
      .update(collections)
      .set({ sortOrder: i })
      .where(eq(collections.id, body.orderedIds[i]!));
  }
  return ok({ reordered: true, count: body.orderedIds.length });
});

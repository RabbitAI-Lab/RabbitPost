import { asc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems, requestCases } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../../lib/http";
import { toRequestCase } from "../../../../../../lib/request-case";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/v1/items/:itemId/cases — 接口的用例列表（按 sortOrder + createdAt 排序） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { itemId } = await ctx.params;
  await requireItemRole(itemId, user.id);
  const rows = await db
    .select()
    .from(requestCases)
    .where(eq(requestCases.itemId, itemId))
    .orderBy(asc(requestCases.sortOrder), asc(requestCases.createdAt));
  return ok(rows.map(toRequestCase));
});

const createSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2000).optional(),
  /** 复制已有用例时传入其配置；缺省继承接口当前配置（快照） */
  request: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/v1/items/:itemId/cases — 新建用例：深拷贝接口当前配置作为初始快照 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { itemId } = await ctx.params;
  await requireItemRole(itemId, user.id, "editor");
  const body = createSchema.parse(await req.json().catch(() => ({})));

  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");
  if (item.type !== "request") {
    throw new HttpError(400, "INVALID_ITEM_TYPE", "Cases can only be added to a request");
  }

  // 名称缺省为 Case N（按现有数量递增）；sortOrder 取最大值 + 1
  const [stats] = await db
    .select({ value: max(requestCases.sortOrder) })
    .from(requestCases)
    .where(eq(requestCases.itemId, itemId));
  const maxOrder = stats?.value ?? null;

  const existing = await db
    .select({ id: requestCases.id })
    .from(requestCases)
    .where(eq(requestCases.itemId, itemId));

  const [row] = await db
    .insert(requestCases)
    .values({
      itemId,
      name: body.name ?? `Case ${existing.length + 1}`,
      description: body.description ?? null,
      sortOrder: (maxOrder ?? -1) + 1,
      request:
        (body.request as never) ?? item.request ?? createEmptyRequestConfig(),
    })
    .returning();
  if (!row) throw new Error("Failed to create case");
  return ok(toRequestCase(row), { status: 201 });
});

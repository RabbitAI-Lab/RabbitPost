import { and, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { createEmptyRequestConfig, HTTP_METHODS } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireCollectionRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ collectionId: string }> };

const createSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  type: z.enum(["folder", "request", "scenario"]),
  name: z.string().min(1).max(256),
  request: z
    .object({
      method: z.enum(HTTP_METHODS),
      url: z.string(),
    })
    .passthrough()
    .optional(),
});

/** POST /api/v1/collections/:collectionId/items — 新建文件夹、请求或场景 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id, "editor");
  const body = createSchema.parse(await req.json());

  // 校验父节点存在且是 folder
  if (body.parentId) {
    const [parent] = await db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.id, body.parentId),
          eq(collectionItems.collectionId, collectionId),
        ),
      )
      .limit(1);
    if (!parent) throw new HttpError(404, "NOT_FOUND", "Parent item not found");
    if (parent.type !== "folder") {
      throw new HttpError(400, "INVALID_PARENT", "Parent must be a folder");
    }
  }

  // 创建 scenario 时，校验父级必须位于场景测试目录子树内
  if (body.type === "scenario") {
    if (!body.parentId) {
      throw new HttpError(400, "INVALID_PARENT", "Scenario must be created inside the scenario root folder");
    }
    // 沿 parentId 链向上查找，确认存在 isScenarioRoot=true 的祖先
    const allItems = await db
      .select({ id: collectionItems.id, parentId: collectionItems.parentId, isScenarioRoot: collectionItems.isScenarioRoot })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, collectionId));
    const itemMap = new Map(allItems.map((i) => [i.id, i]));
    let currentId: string | null = body.parentId;
    let foundScenarioRoot = false;
    while (currentId) {
      const item = itemMap.get(currentId);
      if (!item) break;
      if (item.isScenarioRoot) {
        foundScenarioRoot = true;
        break;
      }
      currentId = item.parentId;
    }
    if (!foundScenarioRoot) {
      throw new HttpError(400, "INVALID_PARENT", "Scenario must be created inside the scenario root folder");
    }
  }

  // sortOrder 取同层最大值 + 1
  const [maxRow] = await db
    .select({ value: max(collectionItems.sortOrder) })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        body.parentId
          ? eq(collectionItems.parentId, body.parentId)
          : isNull(collectionItems.parentId),
      ),
    );
  const maxOrder = maxRow?.value ?? null;

  const [item] = await db
    .insert(collectionItems)
    .values({
      collectionId,
      parentId: body.parentId ?? null,
      type: body.type,
      name: body.name,
      sortOrder: (maxOrder ?? -1) + 1,
      request:
        body.type === "request"
          ? { ...createEmptyRequestConfig(), ...body.request }
          : null,
    })
    .returning();
  if (!item) throw new Error("Failed to create item");
  return ok(
    {
      id: item.id,
      collectionId: item.collectionId,
      parentId: item.parentId,
      type: item.type,
      name: item.name,
      sortOrder: item.sortOrder,
      request: item.request ?? undefined,
      isScenarioRoot: item.isScenarioRoot,
    },
    { status: 201 },
  );
});

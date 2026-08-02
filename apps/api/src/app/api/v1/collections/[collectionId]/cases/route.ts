import { asc, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { collectionItems, requestCases } from "../../../../../../db/schema";
import { handleRoute, ok, requireCollectionRole } from "../../../../../../lib/http";
import { toRequestCase } from "../../../../../../lib/request-case";

type Ctx = { params: Promise<{ collectionId: string }> };

/**
 * GET /api/v1/collections/:collectionId/cases
 * 一次取出该 Collection 下所有请求条目的用例（扁平列表，含 itemId）；
 * 供 CLI 本地展开执行计划时批量拉取，避免逐请求查询。
 */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { collectionId } = await ctx.params;
  await requireCollectionRole(collectionId, user.id);
  const rows = await db
    .select({ caseRow: requestCases })
    .from(requestCases)
    .innerJoin(collectionItems, eq(requestCases.itemId, collectionItems.id))
    .where(eq(collectionItems.collectionId, collectionId))
    .orderBy(asc(requestCases.sortOrder), asc(requestCases.createdAt));
  return ok(rows.map((r) => toRequestCase(r.caseRow)));
});

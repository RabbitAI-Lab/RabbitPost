import { eq } from "drizzle-orm";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems, requestCases } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireCaseRole,
} from "../../../../../../lib/http";
import { toRequestCase } from "../../../../../../lib/request-case";

type Ctx = { params: Promise<{ caseId: string }> };

/** POST /api/v1/cases/:caseId/reset — 从接口当前配置重新继承（覆盖用例快照） */
export const POST = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { caseId } = await ctx.params;
  const { itemId } = await requireCaseRole(caseId, user.id, "editor");

  const [item] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) throw new HttpError(404, "NOT_FOUND", "Collection item not found");

  const [row] = await db
    .update(requestCases)
    .set({
      request: item.request ?? createEmptyRequestConfig(),
      updatedAt: new Date(),
    })
    .where(eq(requestCases.id, caseId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Request case not found");
  return ok(toRequestCase(row));
});

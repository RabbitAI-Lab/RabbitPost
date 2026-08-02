import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { collectionItems, scenarioSteps } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ stepId: string }> };

/** POST /api/v1/scenario-steps/:stepId/sync — 同步源接口最新配置到步骤快照 */
export const POST = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { stepId } = await ctx.params;

  const [step] = await db
    .select()
    .from(scenarioSteps)
    .where(eq(scenarioSteps.id, stepId))
    .limit(1);
  if (!step) throw new HttpError(404, "NOT_FOUND", "Scenario step not found");
  await requireItemRole(step.scenarioId, user.id, "editor");

  if (!step.sourceItemId) {
    throw new HttpError(400, "NO_SOURCE", "Step has no source item to sync from");
  }

  // 读取源接口当前配置
  const [source] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, step.sourceItemId))
    .limit(1);
  if (!source) {
    throw new HttpError(410, "SOURCE_GONE", "Source item has been deleted");
  }
  if (!source.request) {
    throw new HttpError(400, "EMPTY_REQUEST", "Source item has no request config");
  }

  // 覆盖步骤快照 + 更新 sourceSnapshotAt
  const [updated] = await db
    .update(scenarioSteps)
    .set({
      request: source.request as never,
      sourceSnapshotAt: source.updatedAt,
      updatedAt: new Date(),
    })
    .where(eq(scenarioSteps.id, stepId))
    .returning();

  if (!updated) throw new HttpError(404, "NOT_FOUND", "Scenario step not found");
  return ok({
    id: updated.id,
    name: updated.name,
    sourceSnapshotAt: updated.sourceSnapshotAt?.toISOString() ?? null,
    updatedAt: updated.updatedAt.toISOString(),
  });
});

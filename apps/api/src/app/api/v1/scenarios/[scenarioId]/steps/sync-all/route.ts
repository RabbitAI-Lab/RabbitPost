import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../../db";
import { collectionItems, scenarioSteps } from "../../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../../../lib/http";

type Ctx = { params: Promise<{ scenarioId: string }> };

const syncAllSchema = z.object({
  /** 要同步的步骤 id 列表（前端二次确认后传入） */
  stepIds: z.array(z.string().uuid()).min(1),
});

/** POST /api/v1/scenarios/:scenarioId/steps/sync-all — 批量同步 outdated 步骤 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { scenarioId } = await ctx.params;
  await requireItemRole(scenarioId, user.id, "editor");
  const body = syncAllSchema.parse(await req.json());

  // 批量查询步骤
  const steps = await db
    .select()
    .from(scenarioSteps)
    .where(inArray(scenarioSteps.id, body.stepIds));

  // 校验所有步骤都属于该场景
  for (const step of steps) {
    if (step.scenarioId !== scenarioId) {
      throw new HttpError(400, "BAD_REQUEST", `Step ${step.id} not in scenario`);
    }
  }

  const synced: string[] = [];
  const failed: { stepId: string; error: string }[] = [];

  for (const step of steps) {
    if (!step.sourceItemId) {
      failed.push({ stepId: step.id, error: "No source item" });
      continue;
    }

    try {
      const [source] = await db
        .select()
        .from(collectionItems)
        .where(eq(collectionItems.id, step.sourceItemId))
        .limit(1);

      if (!source) {
        failed.push({ stepId: step.id, error: "Source item has been deleted" });
        continue;
      }
      if (!source.request) {
        failed.push({ stepId: step.id, error: "Source item has no request config" });
        continue;
      }

      await db
        .update(scenarioSteps)
        .set({
          request: source.request as never,
          sourceSnapshotAt: source.updatedAt,
          updatedAt: new Date(),
        })
        .where(eq(scenarioSteps.id, step.id));

      synced.push(step.id);
    } catch (e) {
      failed.push({
        stepId: step.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return ok({ synced, failed });
});

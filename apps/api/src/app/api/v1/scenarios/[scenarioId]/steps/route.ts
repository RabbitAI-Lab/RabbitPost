import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ScenarioStep, ScenarioStepWithDiff, StepDiffStatus } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems, scenarioSteps } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireItemRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ scenarioId: string }> };

type StepRow = typeof scenarioSteps.$inferSelect;

function toStep(row: StepRow): ScenarioStep {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    name: row.name,
    sortOrder: row.sortOrder,
    request: row.request,
    sourceItemId: row.sourceItemId,
    sourceSnapshotAt: row.sourceSnapshotAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/v1/scenarios/:scenarioId/steps — 获取步骤列表（含差异状态） */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { scenarioId } = await ctx.params;
  await requireItemRole(scenarioId, user.id);

  // 1. 查询该场景下所有步骤（按 sortOrder 排序）
  const steps = await db
    .select()
    .from(scenarioSteps)
    .where(eq(scenarioSteps.scenarioId, scenarioId))
    .orderBy(asc(scenarioSteps.sortOrder), asc(scenarioSteps.createdAt));

  // 2. 收集所有有 sourceItemId 的步骤
  const sourceIds = steps
    .filter((s) => s.sourceItemId)
    .map((s) => s.sourceItemId!);

  // 3. 批量查询源接口的 id, name, updatedAt, request（outdated 步骤需要 request 做字段级 diff）
  const sourceItems =
    sourceIds.length > 0
      ? await db
          .select({
            id: collectionItems.id,
            name: collectionItems.name,
            updatedAt: collectionItems.updatedAt,
            request: collectionItems.request,
          })
          .from(collectionItems)
          .where(inArray(collectionItems.id, sourceIds))
      : [];
  const sourceMap = new Map(sourceItems.map((i) => [i.id, i]));

  // 4. 组装差异状态
  const result: ScenarioStepWithDiff[] = steps.map((step) => {
    const base = toStep(step);
    if (!step.sourceItemId) {
      return { ...base, diffStatus: "synced" as StepDiffStatus };
    }
    const source = sourceMap.get(step.sourceItemId);
    if (!source) {
      return { ...base, diffStatus: "orphaned" as StepDiffStatus };
    }
    // 差异检测：时间戳不同 或 内容不同（用户可能直接编辑了步骤副本）
    const timeDiff =
      step.sourceSnapshotAt &&
      new Date(source.updatedAt) > new Date(step.sourceSnapshotAt);
    const contentDiff =
      source.request && step.request &&
      JSON.stringify(step.request) !== JSON.stringify(source.request);
    const outdated = timeDiff || contentDiff;
    return {
      ...base,
      diffStatus: (outdated ? "outdated" : "synced") as StepDiffStatus,
      sourceItemName: source.name,
      // outdated 步骤附带源接口当前配置，前端用于字段级 diff 展示
      ...(outdated && source.request ? { sourceRequest: source.request } : {}),
    };
  });

  return ok(result);
});

const addStepSchema = z.object({
  /** 从已有接口导入快照 */
  sourceItemId: z.string().uuid().optional(),
  /** 直接创建空步骤 */
  name: z.string().min(1).max(256).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/v1/scenarios/:scenarioId/steps — 添加步骤（导入快照或新建空步骤） */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { scenarioId } = await ctx.params;
  await requireItemRole(scenarioId, user.id, "editor");
  const body = addStepSchema.parse(await req.json());

  // 校验场景存在且 type = scenario
  const [scenario] = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, scenarioId))
    .limit(1);
  if (!scenario || scenario.type !== "scenario") {
    throw new HttpError(404, "NOT_FOUND", "Scenario not found");
  }

  let name: string;
  let request: Record<string, unknown>;
  let sourceItemId: string | null = null;
  let sourceSnapshotAt: Date | null = null;

  if (body.sourceItemId) {
    // 从已有接口导入快照
    const [source] = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.id, body.sourceItemId))
      .limit(1);
    if (!source || source.type !== "request") {
      throw new HttpError(404, "NOT_FOUND", "Source request item not found");
    }
    if (!source.request) {
      throw new HttpError(400, "EMPTY_REQUEST", "Source item has no request config");
    }
    name = source.name;
    request = source.request as unknown as Record<string, unknown>;
    sourceItemId = source.id;
    sourceSnapshotAt = source.updatedAt;
  } else {
    // 直接创建空步骤
    name = body.name ?? "New Step";
    request = body.request ?? {};
  }

  // 新步骤排在末尾
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${scenarioSteps.sortOrder}), -1)` })
    .from(scenarioSteps)
    .where(eq(scenarioSteps.scenarioId, scenarioId));

  const [step] = await db
    .insert(scenarioSteps)
    .values({
      scenarioId,
      name,
      sortOrder: Number(maxRow?.max ?? -1) + 1,
      request: request as never,
      sourceItemId,
      sourceSnapshotAt,
    })
    .returning();

  if (!step) throw new Error("Failed to create scenario step");
  return ok(toStep(step), { status: 201 });
});

const reorderSchema = z.object({
  /** 完整的步骤 id 新顺序（按数组下标重新编号 sortOrder） */
  orderedIds: z.array(z.string().uuid()).min(1),
});

/** PATCH /api/v1/scenarios/:scenarioId/steps — 批量重排步骤 */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { scenarioId } = await ctx.params;
  await requireItemRole(scenarioId, user.id, "editor");
  const body = reorderSchema.parse(await req.json());

  // 校验 id 均属于该场景
  const rows = await db
    .select({ id: scenarioSteps.id })
    .from(scenarioSteps)
    .where(eq(scenarioSteps.scenarioId, scenarioId));
  const valid = new Set(rows.map((r) => r.id));
  for (const id of body.orderedIds) {
    if (!valid.has(id)) {
      throw new HttpError(400, "BAD_REQUEST", `Step ${id} not in scenario`);
    }
  }

  for (let i = 0; i < body.orderedIds.length; i++) {
    await db
      .update(scenarioSteps)
      .set({ sortOrder: i })
      .where(eq(scenarioSteps.id, body.orderedIds[i]!));
  }

  return ok({ reordered: true, count: body.orderedIds.length });
});

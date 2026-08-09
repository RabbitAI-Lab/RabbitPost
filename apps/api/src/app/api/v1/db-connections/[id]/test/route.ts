import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../db";
import { dbConnections } from "../../../../../../db/schema";
import { pingDbConnection } from "../../../../../../lib/db-client";
import { resolveDbConnection } from "../../../../../../lib/db-connections";
import { handleRoute, HttpError, ok, requireWorkspaceRole } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ id: string }> };

const testSchema = z
  .object({ environmentId: z.string().uuid().nullable().optional() })
  .optional();

/**
 * POST /api/v1/db-connections/:id/test — 连通性测试（viewer+）。
 * 应用 envOverrides 后做真实连接：SQL 类执行 SELECT 1（oracle 加 FROM DUAL），
 * redis 执行 PING，mongodb 执行 { ping: 1 }。
 * 连接失败返回 200 + { success: false, error }（业务结果而非接口错误）。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const [row] = await db
    .select()
    .from(dbConnections)
    .where(eq(dbConnections.id, id))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "DB connection not found");
  await requireWorkspaceRole(row.workspaceId, user.id);
  const body = testSchema.parse(await req.json().catch(() => undefined));

  const resolved = resolveDbConnection(row, body?.environmentId);
  const startedAt = Date.now();
  try {
    await pingDbConnection(resolved);
    return ok({ success: true as const, latencyMs: Date.now() - startedAt });
  } catch (e) {
    return ok({
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

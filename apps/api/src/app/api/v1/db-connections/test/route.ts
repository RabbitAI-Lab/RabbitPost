import { z } from "zod";
import { pingDbConnection } from "../../../../../lib/db-client";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../lib/http";
import { dbConnectionConfigSchema } from "../route";

/**
 * POST /api/v1/db-connections/test — 不落库的内联连通性测试（editor+）。
 * body: { workspaceId, type, config, password? }；直接建临时连接测试后关闭。
 * 连接失败返回 200 + { success: false, error }（与 :id/test 语义一致）。
 */
const inlineTestSchema = z.object({
  workspaceId: z.string().uuid(),
  type: z.enum([
    "mysql",
    "postgres",
    "sqlserver",
    "oracle",
    "clickhouse",
    "mongodb",
    "redis",
    "sqlite",
  ]),
  config: dbConnectionConfigSchema,
  password: z.string().optional(),
});

export const POST = handleRoute(async (req, _ctx, user) => {
  const body = inlineTestSchema.parse(await req.json());
  await requireWorkspaceRole(body.workspaceId, user.id, "editor");
  const startedAt = Date.now();
  try {
    await pingDbConnection({
      name: "__inline_test__",
      config: { ...body.config, type: body.type },
      password: body.password,
    });
    return ok({ success: true as const, latencyMs: Date.now() - startedAt });
  } catch (e) {
    return ok({
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

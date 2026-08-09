import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { dbConnections } from "../../../../../db/schema";
import {
  encryptEnvOverrides,
  serializeDbConnection,
} from "../../../../../lib/db-connections";
import { encryptSecret } from "../../../../../lib/crypto";
import { handleRoute, HttpError, ok, requireWorkspaceRole } from "../../../../../lib/http";
import { dbConnectionConfigSchema, envOverridesSchema } from "../route";

type Ctx = { params: Promise<{ id: string }> };

async function loadRow(id: string) {
  const [row] = await db.select().from(dbConnections).where(eq(dbConnections.id, id)).limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "DB connection not found");
  return row;
}

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  type: z
    .enum([
      "mysql",
      "postgres",
      "sqlserver",
      "oracle",
      "clickhouse",
      "mongodb",
      "redis",
      "sqlite",
    ])
    .optional(),
  config: dbConnectionConfigSchema.optional(),
  /** 非空 → 重新加密；空字符串 → 清除密码；缺省 → 保持不变 */
  password: z.string().optional(),
  /** 整体替换；各环境内 password 缺省时保留已有密文 */
  envOverrides: envOverridesSchema.optional(),
});

/** PATCH /api/v1/db-connections/:id — editor+ */
export const PATCH = handleRoute<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const existing = await loadRow(id);
  await requireWorkspaceRole(existing.workspaceId, user.id, "editor");
  const body = patchSchema.parse(await req.json());
  const [row] = await db
    .update(dbConnections)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.config !== undefined
        ? { config: { ...body.config, type: body.type ?? existing.type } as typeof existing.config }
        : {}),
      ...(body.password !== undefined
        ? { passwordEnc: body.password === "" ? null : encryptSecret(body.password) }
        : {}),
      ...(body.envOverrides !== undefined
        ? { envOverrides: encryptEnvOverrides(body.envOverrides, existing.envOverrides) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(dbConnections.id, id))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "DB connection not found");
  return ok(serializeDbConnection(row));
});

/** DELETE /api/v1/db-connections/:id — editor+ */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  const existing = await loadRow(id);
  await requireWorkspaceRole(existing.workspaceId, user.id, "editor");
  await db.delete(dbConnections).where(eq(dbConnections.id, id));
  return ok({ deleted: true });
});

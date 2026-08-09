import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../db";
import { dbConnections } from "../../../../db/schema";
import {
  encryptEnvOverrides,
  serializeDbConnection,
} from "../../../../lib/db-connections";
import { encryptSecret } from "../../../../lib/crypto";
import { handleRoute, HttpError, ok, requireWorkspaceRole } from "../../../../lib/http";

export const dbConnectionConfigSchema = z
  .object({
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
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    database: z.string().optional(),
    username: z.string().optional(),
    filepath: z.string().optional(),
    connectionString: z.string().optional(),
    ssl: z.boolean().optional(),
    sslMode: z.enum(["prefer", "require", "verify-ca", "verify-full"]).optional(),
    sslCa: z.string().optional(),
    sslCert: z.string().optional(),
    sslKey: z.string().optional(),
    connectTimeoutMs: z.number().int().min(0).optional(),
    readOnly: z.boolean().optional(),
  })
  .passthrough();

export const envOverridesSchema = z.record(
  z.string(),
  z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(0).max(65535).optional(),
      database: z.string().optional(),
      username: z.string().optional(),
      connectionString: z.string().optional(),
      password: z.string().optional(),
    })
    .passthrough(),
);

/** GET /api/v1/db-connections?workspaceId=... — 列表（viewer+；密码密文不回传） */
export const GET = handleRoute(async (req, _ctx, user) => {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "BAD_REQUEST", "workspaceId is required");
  await requireWorkspaceRole(workspaceId, user.id);
  const rows = await db
    .select()
    .from(dbConnections)
    .where(eq(dbConnections.workspaceId, workspaceId))
    .orderBy(asc(dbConnections.createdAt));
  return ok(rows.map(serializeDbConnection));
});

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(64),
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
  envOverrides: envOverridesSchema.optional(),
});

/** POST /api/v1/db-connections — 创建（editor+） */
export const POST = handleRoute(async (req, _ctx, user) => {
  const body = createSchema.parse(await req.json());
  await requireWorkspaceRole(body.workspaceId, user.id, "editor");
  const [row] = await db
    .insert(dbConnections)
    .values({
      workspaceId: body.workspaceId,
      name: body.name,
      type: body.type,
      config: { ...body.config, type: body.type },
      passwordEnc: body.password ? encryptSecret(body.password) : null,
      envOverrides: body.envOverrides ? encryptEnvOverrides(body.envOverrides) : null,
    })
    .returning();
  if (!row) throw new Error("Failed to create db connection");
  return ok(serializeDbConnection(row), { status: 201 });
});

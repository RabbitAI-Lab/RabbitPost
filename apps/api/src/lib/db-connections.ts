/**
 * db_connections 表的序列化 / 解密 / envOverrides 处理。
 * 规则：passwordEnc 与 envOverrides 内的密码密文一律不回传；
 * 返回时以 hasPassword 指示是否已设置密码。
 */
import { eq } from "drizzle-orm";
import type {
  DbConnectionConfig,
  DbConnectionEnvOverrides,
  DbConnectionType,
  ResolvedDbConnection,
} from "@rabbitpost/shared";
import { db } from "../db";
import { dbConnections } from "../db/schema";
import { decryptSecret, encryptSecret } from "./crypto";

export type DbConnectionRow = typeof dbConnections.$inferSelect;

/** 回传前剥离 envOverrides 中的密码密文 */
function stripOverridePasswords(overrides: DbConnectionEnvOverrides | null) {
  if (!overrides) return null;
  return Object.fromEntries(
    Object.entries(overrides).map(([envId, o]) => {
      const { password, ...rest } = o;
      return [envId, { ...rest, hasPassword: Boolean(password) }];
    }),
  );
}

export function serializeDbConnection(row: DbConnectionRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    type: row.type,
    config: row.config,
    hasPassword: Boolean(row.passwordEnc),
    envOverrides: stripOverridePasswords(row.envOverrides),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 解密为执行期连接：按 environmentId 应用 envOverrides（含覆盖密码） */
export function resolveDbConnection(
  row: DbConnectionRow,
  environmentId?: string | null,
): ResolvedDbConnection {
  const config: DbConnectionConfig = {
    ...row.config,
    type: row.type as DbConnectionType,
  };
  let password = row.passwordEnc ? decryptSecret(row.passwordEnc) : undefined;
  const override = environmentId ? row.envOverrides?.[environmentId] : undefined;
  if (override) {
    const { password: encPassword, ...fields } = override;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        (config as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (encPassword) password = decryptSecret(encPassword);
  }
  return { name: row.name, config, password };
}

/**
 * 存储前加密 envOverrides 内的明文密码：
 * password 非空 → 加密；空字符串 → 清除；缺省 → 保留该环境已有密文。
 */
export function encryptEnvOverrides(
  input: DbConnectionEnvOverrides,
  existing?: DbConnectionEnvOverrides | null,
): DbConnectionEnvOverrides {
  const out: DbConnectionEnvOverrides = {};
  for (const [envId, o] of Object.entries(input)) {
    const { password, ...rest } = o;
    let enc: string | undefined;
    if (password === undefined) {
      enc = existing?.[envId]?.password;
    } else if (password !== "") {
      enc = encryptSecret(password);
    }
    out[envId] = { ...rest, ...(enc ? { password: enc } : {}) };
  }
  return out;
}

/** 加载 workspace 全部连接并解密（执行链路使用，明文不离开服务端/本机 runner） */
export async function loadWorkspaceDbConnections(
  workspaceId: string,
  environmentId?: string | null,
): Promise<ResolvedDbConnection[]> {
  const rows = await db
    .select()
    .from(dbConnections)
    .where(eq(dbConnections.workspaceId, workspaceId));
  return rows.map((row) => resolveDbConnection(row, environmentId));
}

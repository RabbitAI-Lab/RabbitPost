import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// 依次加载：仓库根 .env -> apps/api/.env -> apps/api/.env.local（后者优先已存在则不覆盖）
const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
loadEnv({
  path: [
    path.join(apiRoot, ".env.local"),
    path.join(apiRoot, ".env"),
    path.join(repoRoot, ".env"),
  ],
  override: false,
});

const schema = z.object({
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

  DATABASE_URL: z.string().optional().default(""),
  EMBEDDED_PG_PORT: z.coerce.number().int().default(5433),
  EMBEDDED_PG_DIR: z.string().default(".pgdata"),

  CASDOOR_ENDPOINT: z.string().url().optional(),
  CASDOOR_CLIENT_ID: z.string().optional(),
  CASDOOR_CLIENT_SECRET: z.string().optional(),
  CASDOOR_ORGANIZATION: z.string().optional(),
  CASDOOR_APPLICATION: z.string().optional(),
  CASDOOR_CERT: z.string().optional(),

  APP_SESSION_SECRET: z.string().default("rabbitpost-dev-secret"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] invalid environment:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

/** 解析后的数据库连接串：优先 DATABASE_URL，否则指向本地 embedded-postgres */
export function resolveDatabaseUrl(): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  return `postgres://postgres:postgres@localhost:${env.EMBEDDED_PG_PORT}/rabbitpost`;
}

/** Casdoor 配置是否完整（不完整时 auth 接口返回 503 提示） */
export function isCasdoorConfigured(): boolean {
  return Boolean(
    env.CASDOOR_ENDPOINT &&
      env.CASDOOR_CLIENT_ID &&
      env.CASDOOR_CLIENT_SECRET &&
      env.CASDOOR_CERT,
  );
}

export function casdoorConfig() {
  if (!isCasdoorConfigured()) {
    throw new Error(
      "Casdoor is not configured. Please set CASDOOR_* variables (see .env.example).",
    );
  }
  return {
    endpoint: env.CASDOOR_ENDPOINT!.replace(/\/$/, ""),
    clientId: env.CASDOOR_CLIENT_ID!,
    clientSecret: env.CASDOOR_CLIENT_SECRET!,
    organization: env.CASDOOR_ORGANIZATION ?? "",
    application: env.CASDOOR_APPLICATION ?? "",
    cert: env.CASDOOR_CERT!.replace(/\\n/g, "\n"),
  };
}

/**
 * 真实数据库集成测试（环境变量门控，未配置对应变量则 skip）：
 *   RP_LIVE_MYSQL      = host:port:user:pass:db
 *   RP_LIVE_POSTGRES   = host:port:user:pass:db
 *   RP_LIVE_SQLSERVER  = host:port:user:pass:db
 *   RP_LIVE_ORACLE     = host:port:user:pass:serviceName
 *   RP_LIVE_CLICKHOUSE = host:port:user:pass:db     （HTTP 端口，默认 8123）
 *   RP_LIVE_MONGO      = host:port:user:pass:db     （user:pass 可为空）
 *   RP_LIVE_REDIS      = host:port[:password[:dbIndex]]
 * 每类型验证与 test 路由同款的 ping 语句，外加 query/exec/mongo command 的真实往返。
 * 用法示例：RP_LIVE_MYSQL=127.0.0.1:3306:root:root:test pnpm vitest run test/db-drivers-live.test.ts
 */
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedDbConnection } from "@rabbitpost/shared";
import { createDbExecutor, pingDbConnection } from "../src/lib/db-client";

beforeAll(() => {
  process.env.DB_SECRET_KEY ??= crypto.randomBytes(32).toString("base64");
});

/** 解析 host:port:user:pass:db 格式的环境变量；未设置返回 undefined */
function parseLive(env: string | undefined):
  | { host: string; port: number; user: string; pass: string; db: string }
  | undefined {
  if (!env) return undefined;
  const [host, port, user, pass, ...rest] = env.split(":");
  if (!host || !port) throw new Error(`bad live env format: ${env}`);
  return { host, port: Number(port), user: user ?? "", pass: pass ?? "", db: rest.join(":") };
}

function conn(
  type: ResolvedDbConnection["config"]["type"],
  env: string | undefined,
  extra: Record<string, unknown> = {},
): ResolvedDbConnection | undefined {
  const parsed = parseLive(env);
  if (!parsed) return undefined;
  return {
    name: `live-${type}`,
    config: {
      type,
      host: parsed.host,
      port: parsed.port,
      database: parsed.db || undefined,
      username: parsed.user || undefined,
      connectTimeoutMs: 8000,
      ...extra,
    } as ResolvedDbConnection["config"],
    password: parsed.pass || undefined,
  };
}

const mysqlConn = conn("mysql", process.env.RP_LIVE_MYSQL);
const postgresConn = conn("postgres", process.env.RP_LIVE_POSTGRES);
const sqlserverConn = conn("sqlserver", process.env.RP_LIVE_SQLSERVER);
const oracleConn = conn("oracle", process.env.RP_LIVE_ORACLE);
const clickhouseConn = conn("clickhouse", process.env.RP_LIVE_CLICKHOUSE);
const mongoConn = conn("mongodb", process.env.RP_LIVE_MONGO);

const redisEnv = process.env.RP_LIVE_REDIS;
const redisConn: ResolvedDbConnection | undefined = redisEnv
  ? (() => {
      const [host, port, pass, dbIndex] = redisEnv.split(":");
      return {
        name: "live-redis",
        config: {
          type: "redis",
          host,
          port: Number(port ?? 6379),
          database: dbIndex,
          connectTimeoutMs: 8000,
        },
        password: pass || undefined,
      } as ResolvedDbConnection;
    })()
  : undefined;

describe.skipIf(!mysqlConn)("live: mysql", () => {
  it("ping（SELECT 1）+ query/exec 往返", async () => {
    await pingDbConnection(mysqlConn!);
    const executor = createDbExecutor([mysqlConn!]);
    try {
      const res = await executor.query("live-mysql", "SELECT ? AS v", [42]);
      expect(Number(res.rows[0]!.v)).toBe(42);
      await executor.exec("live-mysql", "CREATE TEMPORARY TABLE IF NOT EXISTS rp_live (id INT)");
      const wr = await executor.exec("live-mysql", "INSERT INTO rp_live (id) VALUES (?)", [1]);
      expect(wr.affectedRows).toBe(1);
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!postgresConn)("live: postgres", () => {
  it("ping（SELECT 1）+ query/exec 往返（? → $n）", async () => {
    await pingDbConnection(postgresConn!);
    const executor = createDbExecutor([postgresConn!]);
    try {
      const res = await executor.query("live-postgres", "SELECT ?::int AS v", [42]);
      expect(Number(res.rows[0]!.v)).toBe(42);
      await executor.exec("live-postgres", "CREATE TEMP TABLE IF NOT EXISTS rp_live (id INT)");
      const wr = await executor.exec("live-postgres", "INSERT INTO rp_live (id) VALUES (?)", [1]);
      expect(wr.affectedRows).toBe(1);
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!sqlserverConn)("live: sqlserver", () => {
  it("ping（SELECT 1）+ query/exec 往返（? → @pN）", async () => {
    await pingDbConnection(sqlserverConn!);
    const executor = createDbExecutor([sqlserverConn!]);
    try {
      const res = await executor.query("live-sqlserver", "SELECT ? AS v", [42]);
      expect(Number(res.rows[0]!.v)).toBe(42);
      const wr = await executor.exec(
        "live-sqlserver",
        "CREATE TABLE #rp_live (id INT); INSERT INTO #rp_live (id) VALUES (?)",
        [1],
      );
      expect(wr.affectedRows).toBeGreaterThanOrEqual(1);
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!oracleConn)("live: oracle", () => {
  it("ping（SELECT 1 FROM DUAL）+ query/exec 往返（? → :N）", async () => {
    await pingDbConnection(oracleConn!);
    const executor = createDbExecutor([oracleConn!]);
    try {
      const res = await executor.query("live-oracle", "SELECT ? AS v FROM DUAL", [42]);
      expect(Number(res.rows[0]!.V ?? res.rows[0]!.v)).toBe(42);
      await executor.exec("live-oracle", "CREATE TABLE rp_live (id NUMBER)");
      const wr = await executor.exec("live-oracle", "INSERT INTO rp_live (id) VALUES (?)", [1]);
      expect(wr.affectedRows).toBe(1);
      await executor.exec("live-oracle", "DROP TABLE rp_live");
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!clickhouseConn)("live: clickhouse", () => {
  it("ping（SELECT 1）+ query/insert 往返（字面量内联）", async () => {
    await pingDbConnection(clickhouseConn!);
    const executor = createDbExecutor([clickhouseConn!]);
    try {
      const res = await executor.query("live-clickhouse", "SELECT ? AS v, ? AS s", [42, "it's"]);
      expect(Number(res.rows[0]!.v)).toBe(42);
      expect(res.rows[0]!.s).toBe("it's");
      await executor.exec(
        "live-clickhouse",
        "CREATE TABLE IF NOT EXISTS rp_live (id UInt32, s String) ENGINE = Memory",
      );
      await executor.exec("live-clickhouse", "INSERT INTO rp_live (id, s) VALUES (?, ?)", [
        1,
        "a\\b",
      ]);
      const rows = await executor.query("live-clickhouse", "SELECT s FROM rp_live WHERE id = ?", [
        1,
      ]);
      expect(rows.rows.some((r) => r.s === "a\\b")).toBe(true);
      await executor.exec("live-clickhouse", "DROP TABLE rp_live");
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!mongoConn)("live: mongodb", () => {
  it("ping（{ ping: 1 }）+ runCommand 往返；query/exec 抛明确错误", async () => {
    await pingDbConnection(mongoConn!);
    const executor = createDbExecutor([mongoConn!]);
    try {
      const pong = (await executor.mongo("live-mongodb", { ping: 1 })) as { ok: number };
      expect(pong.ok).toBe(1);
      await executor.mongo("live-mongodb", {
        insert: "rp_live",
        documents: [{ _id: "rp-live-1", v: 42 }],
      });
      const found = (await executor.mongo("live-mongodb", {
        find: "rp_live",
        filter: { _id: "rp-live-1" },
      })) as { cursor: { firstBatch: { v: number }[] } };
      expect(found.cursor.firstBatch[0]!.v).toBe(42);
      await executor.mongo("live-mongodb", { drop: "rp_live" });
      await expect(executor.query("live-mongodb", "SELECT 1")).rejects.toThrow(/mongo/);
    } finally {
      await executor.close();
    }
  });
});

describe.skipIf(!redisConn)("live: redis", () => {
  it("ping（PING）+ SET/GET 往返", async () => {
    await pingDbConnection(redisConn!);
    const executor = createDbExecutor([redisConn!]);
    try {
      expect(await executor.redis("live-redis", "PING")).toBe("PONG");
      await executor.redis("live-redis", "SET", ["rp_live", "hello"]);
      expect(await executor.redis("live-redis", "GET", ["rp_live"])).toBe("hello");
      await executor.redis("live-redis", "DEL", ["rp_live"]);
    } finally {
      await executor.close();
    }
  });
});

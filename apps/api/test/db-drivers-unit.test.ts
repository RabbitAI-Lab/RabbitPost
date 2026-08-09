/**
 * 新数据库驱动（sqlserver / oracle / clickhouse / mongodb）与 SSL 模式的纯单测：
 * - 占位符方言转换（@pN / :N）
 * - clickhouse 字面量内联转义
 * - mongo 连接串构造
 * - sslMode → 各驱动 ssl 选项映射
 * - POST /api/v1/db-connections/test（内联测试路由）的请求校验与鉴权
 * 不连真实数据库。
 */
import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST as inlineTestConnection } from "../src/app/api/v1/db-connections/test/route";
import {
  convertPlaceholders,
  inlineClickHouseParams,
  mongoConnectionString,
  mysqlSslOptions,
  pgSslOptions,
  resolveSslMode,
} from "../src/lib/db-client";
import { authed, envelope, seedBasic, seedOutsiderToken } from "./helpers";

// 与 db-connections.test.ts 一致：测试环境无 cookie 上下文，会话路径固定返回 null
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

beforeAll(() => {
  process.env.DB_SECRET_KEY = crypto.randomBytes(32).toString("base64");
});

describe("占位符方言转换", () => {
  it("sqlserver：? → @p1..@pN", () => {
    expect(convertPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", "sqlserver")).toBe(
      "SELECT * FROM t WHERE a = @p1 AND b = @p2",
    );
  });

  it("oracle：? → :1..:N", () => {
    expect(convertPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", "oracle")).toBe(
      "SELECT * FROM t WHERE a = :1 AND b = :2",
    );
  });

  it("字符串字面量与 ?? 不转换（各方言一致）", () => {
    for (const dialect of ["postgres", "sqlserver", "oracle"] as const) {
      const out = convertPlaceholders("SELECT '?' AS q, 'it''s ?' FROM ?? WHERE a = ?", dialect);
      const tail = dialect === "postgres" ? "$1" : dialect === "sqlserver" ? "@p1" : ":1";
      expect(out).toBe(`SELECT '?' AS q, 'it''s ?' FROM ?? WHERE a = ${tail}`);
    }
  });
});

describe("clickhouse 字面量内联", () => {
  it("string/number/boolean/null 内联为字面量", () => {
    expect(inlineClickHouseParams("SELECT ? AS a, ? AS b, ? AS c, ? AS d", ["x", 42, true, null])).toBe(
      "SELECT 'x' AS a, 42 AS b, 1 AS c, NULL AS d",
    );
  });

  it("字符串单引号双写 + 反斜杠转义", () => {
    expect(inlineClickHouseParams("SELECT ?", ["it's a \\ path"])).toBe(
      "SELECT 'it''s a \\\\ path'",
    );
  });

  it("字符串字面量内的 ? 不替换", () => {
    expect(inlineClickHouseParams("SELECT '?' AS q WHERE a = ?", [7])).toBe(
      "SELECT '?' AS q WHERE a = 7",
    );
  });

  it("参数个数不足 / 不支持的类型直接抛错", () => {
    expect(() => inlineClickHouseParams("SELECT ?, ?", [1])).toThrow(/params count/);
    expect(() => inlineClickHouseParams("SELECT ?", [{ a: 1 }])).toThrow(/unsupported param type/);
    expect(() => inlineClickHouseParams("SELECT ?", [Number.NaN])).toThrow(/non-finite/);
  });
});

describe("mongo 连接串构造", () => {
  it("connectionString 优先", () => {
    expect(
      mongoConnectionString(
        { type: "mongodb", connectionString: "mongodb://other:27018/db2", host: "h" },
        "pw",
      ),
    ).toBe("mongodb://other:27018/db2");
  });

  it("离散字段拼装：user/pass 需转义，缺省 host/port", () => {
    expect(
      mongoConnectionString({ type: "mongodb", username: "u@x", database: "mydb" }, "p@ss"),
    ).toBe("mongodb://u%40x:p%40ss@localhost:27017/mydb");
  });

  it("无用户名时不带认证段；无 database 时不带路径", () => {
    expect(mongoConnectionString({ type: "mongodb", host: "db.internal", port: 27018 })).toBe(
      "mongodb://db.internal:27018",
    );
  });
});

describe("sslMode 解析", () => {
  it("显式 sslMode 优先；ssl:true 等价 require；都缺省则不启用", () => {
    expect(resolveSslMode({ type: "postgres", sslMode: "verify-full", ssl: false })).toBe(
      "verify-full",
    );
    expect(resolveSslMode({ type: "postgres", ssl: true })).toBe("require");
    expect(resolveSslMode({ type: "postgres" })).toBeUndefined();
  });
});

describe("sslMode → pg ssl 选项", () => {
  const certs = { sslCa: "CA-PEM", sslCert: "CERT-PEM", sslKey: "KEY-PEM" };

  it("未配置时返回 undefined", () => {
    expect(pgSslOptions({ type: "postgres" })).toBeUndefined();
  });

  it("prefer/require：不校验证书链", () => {
    for (const sslMode of ["prefer", "require"] as const) {
      expect(pgSslOptions({ type: "postgres", sslMode })).toEqual({ rejectUnauthorized: false });
    }
  });

  it("verify-ca：校验 CA、关掉主机名校验、带证书字段", () => {
    const ssl = pgSslOptions({ type: "postgres", sslMode: "verify-ca", ...certs }) as Record<
      string,
      unknown
    >;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe("CA-PEM");
    expect(ssl.cert).toBe("CERT-PEM");
    expect(ssl.key).toBe("KEY-PEM");
    // checkServerIdentity 返回 undefined 表示跳过主机名校验
    expect((ssl.checkServerIdentity as () => unknown)()).toBeUndefined();
  });

  it("verify-full：CA + 主机名全量校验", () => {
    const ssl = pgSslOptions({ type: "postgres", sslMode: "verify-full", sslCa: "CA-PEM" });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: "CA-PEM" });
  });
});

describe("sslMode → mysql2 ssl 选项", () => {
  it("prefer/require：不校验证书链", () => {
    for (const sslMode of ["prefer", "require"] as const) {
      expect(mysqlSslOptions({ type: "mysql", sslMode })).toEqual({ rejectUnauthorized: false });
    }
    expect(mysqlSslOptions({ type: "mysql" })).toBeUndefined();
  });

  it("verify-ca 带 CA 并关主机名校验；verify-full 全量校验", () => {
    const ca = mysqlSslOptions({ type: "mysql", sslMode: "verify-ca", sslCa: "CA-PEM" }) as Record<
      string,
      unknown
    >;
    expect(ca.rejectUnauthorized).toBe(true);
    expect(ca.ca).toBe("CA-PEM");
    expect((ca.checkServerIdentity as () => unknown)()).toBeUndefined();

    const full = mysqlSslOptions({ type: "mysql", sslMode: "verify-full", sslCa: "CA-PEM" });
    expect(full).toEqual({ rejectUnauthorized: true, ca: "CA-PEM" });
  });
});

describe("POST /api/v1/db-connections/test（内联连通性测试）", () => {
  it("sqlite 内联测试成功（不落库）", async () => {
    const s = await seedBasic();
    const resp = await inlineTestConnection(
      authed("/api/v1/db-connections/test", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          type: "sqlite",
          config: { type: "sqlite", filepath: ":memory:" },
        },
      }),
      {},
    );
    const res = await envelope<{ success: boolean; latencyMs?: number }>(resp);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("连接失败返回 success:false 而非接口错误", async () => {
    const s = await seedBasic();
    const resp = await inlineTestConnection(
      authed("/api/v1/db-connections/test", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          type: "mongodb",
          config: {
            type: "mongodb",
            host: "127.0.0.1",
            port: 59998,
            connectTimeoutMs: 500,
          },
        },
      }),
      {},
    );
    const res = await envelope<{ success: boolean; error?: string }>(resp);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(false);
    expect(res.data.error).toBeTruthy();
  });

  it("新类型通过校验；未知类型被拒；越权 403；未认证 401", async () => {
    const s = await seedBasic();
    const outsider = await seedOutsiderToken();

    // 未认证
    const unauth = await inlineTestConnection(
      authed("/api/v1/db-connections/test", null, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          type: "sqlite",
          config: { type: "sqlite", filepath: ":memory:" },
        },
      }),
      {},
    );
    expect(unauth.status).toBe(401);

    // 越权（非本 workspace 成员）
    const forbidden = await inlineTestConnection(
      authed("/api/v1/db-connections/test", outsider, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          type: "sqlite",
          config: { type: "sqlite", filepath: ":memory:" },
        },
      }),
      {},
    );
    expect(forbidden.status).toBe(403);

    // 未知类型被 zod 拒绝（handleRoute 未特判 ZodError，统一落 500 通道）
    const bad = await inlineTestConnection(
      authed("/api/v1/db-connections/test", s.apiToken, {
        method: "POST",
        json: { workspaceId: s.workspaceId, type: "db2", config: { type: "db2" } },
      }),
      {},
    );
    expect(bad.status).toBe(500);

    // 新类型（sqlserver）能通过 zod 校验（连不上走 success:false 分支）
    const mssqlResp = await inlineTestConnection(
      authed("/api/v1/db-connections/test", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          type: "sqlserver",
          config: { type: "sqlserver", host: "127.0.0.1", port: 59997, connectTimeoutMs: 500 },
        },
      }),
      {},
    );
    const mssqlRes = await envelope<{ success: boolean }>(mssqlResp);
    expect(mssqlRes.status).toBe(200);
    expect(mssqlRes.data.success).toBe(false);
  });
});

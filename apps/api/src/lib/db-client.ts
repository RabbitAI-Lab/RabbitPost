/**
 * 数据库驱动统一封装：pg / mysql2 / better-sqlite3 / node-redis /
 * mssql(SQL Server) / oracledb(thin) / @clickhouse/client / mongodb。
 * 按连接名惰性建池（每次请求执行创建一个 DbExecutor，结束后 close 全部关闭）。
 * 护栏：连接超时 5s（connectTimeoutMs 可覆盖）、单条语句 10s、maxRows 1000 截断、
 * readOnly 拒绝非 SELECT。脚本统一使用 `?` 占位符，驱动层按方言转换：
 * postgres → `$n`，sqlserver → `@pN`，oracle → `:N`，clickhouse → 安全字面量内联。
 */
import { createClient as createClickHouseClient, type ClickHouseClient } from "@clickhouse/client";
import Database from "better-sqlite3";
import { MongoClient } from "mongodb";
import mssql from "mssql";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import pg from "pg";
import { createClient, type RedisClientType } from "redis";
import type {
  DbConnectionConfig,
  DbExecResult,
  DbQueryResult,
  DbSslMode,
  ResolvedDbConnection,
} from "@rabbitpost/shared";

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_ROWS = 1000;

export interface DbExecutor {
  query(name: string, sql: string, params?: unknown[]): Promise<DbQueryResult>;
  exec(name: string, sql: string, params?: unknown[]): Promise<DbExecResult>;
  redis(name: string, command: string, args?: string[]): Promise<unknown>;
  /** MongoDB runCommand（对标 Apifox 的“运行数据库命令”），command 为命令对象 */
  mongo(name: string, command: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** readOnly 模式下只允许 SELECT / WITH ... SELECT（大小写不敏感） */
export function isSelectStatement(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql);
}

/** 占位符方言：postgres `$n` / sqlserver `@pN` / oracle `:N` */
export type SqlPlaceholderDialect = "postgres" | "sqlserver" | "oracle";

/**
 * 把脚本侧统一的 `?` 占位符按方言转换，replace(n) 返回第 n 个占位符文本。
 * 跳过字符串字面量（单/双引号、dollar-quoted）与 `??`（mysql 风格标识符占位符）。
 */
function replaceQuestionPlaceholders(sql: string, replace: (n: number) => string): string {
  let out = "";
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // 单引号字符串：'' 为转义
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += sql.slice(start, i);
      continue;
    }
    // 双引号标识符/字符串："" 为转义
    if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += sql.slice(start, i);
      continue;
    }
    // dollar-quoted 字符串（$tag$ ... $tag$）
    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "?") {
      if (sql[i + 1] === "?") {
        out += "??";
        i += 2;
        continue;
      }
      n++;
      out += replace(n);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `?` 占位符按方言转换：postgres `$n` / sqlserver `@pN` / oracle `:N` */
export function convertPlaceholders(sql: string, dialect: SqlPlaceholderDialect): string {
  return replaceQuestionPlaceholders(sql, (n) =>
    dialect === "postgres" ? `$${n}` : dialect === "sqlserver" ? `@p${n}` : `:${n}`,
  );
}

/** 兼容别名：`?` → postgres `$1..$n` */
export function questionToDollarPlaceholders(sql: string): string {
  return convertPlaceholders(sql, "postgres");
}

/**
 * clickhouse 参数内联：官方客户端的 `{p:String}` 占位符需类型标注，无法承接统一的 `?`，
 * 这里把参数安全地内联为 SQL 字面量。仅接受 string/number/boolean/null，
 * 字符串单引号双写 + 反斜杠转义；其它类型（数组/对象/Date 等）直接抛错。
 */
export function inlineClickHouseParams(sql: string, params: unknown[]): string {
  let index = 0;
  return replaceQuestionPlaceholders(sql, () => {
    if (index >= params.length) {
      throw new Error("clickhouse: params count is less than ? placeholders");
    }
    return clickHouseLiteral(params[index++]);
  });
}

function clickHouseLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("clickhouse: non-finite number param is not supported");
    }
    return String(value);
  }
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  throw new Error(
    `clickhouse: unsupported param type "${typeof value}" (only string/number/boolean/null)`,
  );
}

/** sslMode 解析：显式 sslMode 优先；ssl:true 等价 require；都未给则不启用 SSL */
export function resolveSslMode(config: DbConnectionConfig): DbSslMode | undefined {
  if (config.sslMode) return config.sslMode;
  if (config.ssl === true) return "require";
  return undefined;
}

/** postgres 的 ssl 选项（传入 pg.Pool/Client 的 ssl 字段） */
export function pgSslOptions(config: DbConnectionConfig): pg.ConnectionConfig["ssl"] {
  const mode = resolveSslMode(config);
  if (!mode) return undefined;
  const certs = {
    ...(config.sslCa ? { ca: config.sslCa } : {}),
    ...(config.sslCert ? { cert: config.sslCert } : {}),
    ...(config.sslKey ? { key: config.sslKey } : {}),
  };
  switch (mode) {
    // prefer/require 都不校验证书链（内网自签名常见；prefer 不做明文回退）
    case "prefer":
    case "require":
      return { rejectUnauthorized: false, ...certs };
    // verify-ca：校验 CA 但关掉主机名校验（checkServerIdentity 属 tls 选项，pg 类型未收录）
    case "verify-ca":
      return {
        rejectUnauthorized: true,
        ...certs,
        checkServerIdentity: () => undefined,
      } as pg.ConnectionConfig["ssl"];
    // verify-full：CA + 主机名全量校验
    case "verify-full":
      return { rejectUnauthorized: true, ...certs };
  }
}

/** mysql2 的 ssl 选项（传入 createPool 的 ssl 字段） */
export function mysqlSslOptions(config: DbConnectionConfig): mysql.PoolOptions["ssl"] {
  const mode = resolveSslMode(config);
  if (!mode) return undefined;
  const certs = {
    ...(config.sslCa ? { ca: config.sslCa } : {}),
    ...(config.sslCert ? { cert: config.sslCert } : {}),
    ...(config.sslKey ? { key: config.sslKey } : {}),
  };
  switch (mode) {
    case "prefer":
    case "require":
      return { rejectUnauthorized: false, ...certs };
    case "verify-ca":
      // checkServerIdentity 属 tls 选项，mysql2 的 SslOptions 类型未收录，断言放行
      return {
        rejectUnauthorized: true,
        ...certs,
        checkServerIdentity: () => undefined,
      } as mysql.PoolOptions["ssl"];
    case "verify-full":
      return { rejectUnauthorized: true, ...certs };
  }
}

/** mongodb 连接串：connectionString 优先，否则由离散字段拼装 */
export function mongoConnectionString(config: DbConnectionConfig, password?: string): string {
  if (config.connectionString && config.connectionString.trim()) {
    return config.connectionString;
  }
  const host = config.host ?? "localhost";
  const port = config.port ?? 27017;
  let auth = "";
  if (config.username) {
    auth = encodeURIComponent(config.username);
    if (password) auth += `:${encodeURIComponent(password)}`;
    auth += "@";
  }
  const db = config.database ? `/${encodeURIComponent(config.database)}` : "";
  return `mongodb://${auth}${host}:${port}${db}`;
}

/** redis 回复规范化：Buffer → utf8 字符串，数组/对象递归处理 */
function normalizeRedisReply(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(normalizeRedisReply);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeRedisReply(v),
      ]),
    );
  }
  return value;
}

async function withStatementTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`statement timed out after ${STATEMENT_TIMEOUT_MS}ms`)),
      STATEMENT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// createClient 无参调用时推断出的具体客户端类型（泛型全为默认空类型）
type RedisClient = RedisClientType<{}, {}, {}, 3, {}>;

type Handle =
  | { kind: "postgres"; pool: pg.Pool }
  | { kind: "mysql"; pool: mysql.Pool }
  | { kind: "sqlite"; db: Database.Database }
  | { kind: "redis"; client: RedisClient }
  | { kind: "sqlserver"; pool: mssql.ConnectionPool }
  | { kind: "oracle"; pool: oracledb.Pool }
  | { kind: "clickhouse"; client: ClickHouseClient }
  | { kind: "mongodb"; client: MongoClient };

function truncateRows(rows: Record<string, unknown>[]): DbQueryResult {
  if (rows.length > MAX_ROWS) {
    return { rows: rows.slice(0, MAX_ROWS), rowCount: MAX_ROWS, truncated: true };
  }
  return { rows, rowCount: rows.length };
}

export function createDbExecutor(connections: ResolvedDbConnection[]): DbExecutor {
  const byName = new Map(connections.map((c) => [c.name, c]));
  const handles = new Map<string, Handle>();
  let closed = false;

  function getConnection(name: string): ResolvedDbConnection {
    const conn = byName.get(name);
    if (!conn) {
      throw new Error(
        `unknown database connection "${name}" (configured: ${[...byName.keys()].join(", ") || "none"})`,
      );
    }
    return conn;
  }

  function assertOpen() {
    if (closed) throw new Error("db executor is already closed");
  }

  async function getHandle(name: string): Promise<Handle> {
    assertOpen();
    const conn = getConnection(name);
    const cached = handles.get(name);
    if (cached) return cached;
    const { config } = conn;
    const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let handle: Handle;
    switch (config.type) {
      case "postgres": {
        const pool = new pg.Pool({
          connectionString: config.connectionString,
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.username,
          password: conn.password,
          ssl: pgSslOptions(config),
          connectionTimeoutMillis: connectTimeoutMs,
          max: 4,
        });
        handle = { kind: "postgres", pool };
        break;
      }
      case "mysql": {
        const base: mysql.PoolOptions = {
          port: config.port,
          database: config.database,
          user: config.username,
          password: conn.password,
          connectTimeout: connectTimeoutMs,
          connectionLimit: 4,
          ssl: mysqlSslOptions(config),
        };
        // mysql2 不直接吃 connectionString，这里仅支持离散字段（connectionString 属 pg 风格用法）
        const pool = mysql.createPool({ ...base, host: config.host ?? "localhost" });
        handle = { kind: "mysql", pool };
        break;
      }
      case "sqlite": {
        const filepath = config.filepath ?? config.connectionString;
        if (!filepath) {
          throw new Error(`sqlite connection "${name}" requires config.filepath`);
        }
        const db = new Database(filepath, {
          readonly: config.readOnly ?? false,
          timeout: connectTimeoutMs,
        });
        handle = { kind: "sqlite", db };
        break;
      }
      case "redis": {
        const dbIndex =
          config.database && /^\d+$/.test(config.database) ? Number(config.database) : 0;
        const client = createClient({
          url: config.connectionString,
          socket: config.connectionString
            ? undefined
            : {
                host: config.host ?? "localhost",
                port: config.port ?? 6379,
                connectTimeout: connectTimeoutMs,
                tls: config.ssl ? true : undefined,
              },
          username: config.username,
          password: conn.password,
          database: dbIndex,
        });
        await client.connect();
        handle = { kind: "redis", client };
        break;
      }
      case "sqlserver": {
        const pool = new mssql.ConnectionPool({
          // @types/mssql 未收录 connectionString，这里断言放行（驱动本身支持）
          ...(config.connectionString
            ? { connectionString: config.connectionString }
            : {
                server: config.host ?? "localhost",
                port: config.port ?? 1433,
                database: config.database,
                user: config.username,
                password: conn.password,
              }),
          connectionTimeout: connectTimeoutMs,
          requestTimeout: STATEMENT_TIMEOUT_MS,
          // ssl=true 映射驱动的 encrypt；内网自签名常见，不校验证书
          options: {
            encrypt: config.ssl === true,
            trustServerCertificate: true,
          },
          pool: { max: 4 },
        } as mssql.config);
        await pool.connect();
        handle = { kind: "sqlserver", pool };
        break;
      }
      case "oracle": {
        // thin 模式（默认，纯 JS）：connectString 为 host:port/serviceName，
        // serviceName 取 config.database；connectionString 给出时优先
        const connectString =
          config.connectionString ??
          `${config.host ?? "localhost"}:${config.port ?? 1521}/${config.database ?? ""}`;
        const pool = await oracledb.createPool({
          user: config.username,
          password: conn.password,
          connectString,
          // thin 模式 connectTimeout 单位为秒
          connectTimeout: Math.max(1, Math.ceil(connectTimeoutMs / 1000)),
          poolMin: 0,
          poolMax: 4,
        });
        handle = { kind: "oracle", pool };
        break;
      }
      case "clickhouse": {
        const client = createClickHouseClient({
          url:
            config.connectionString ??
            `http://${config.host ?? "localhost"}:${config.port ?? 8123}`,
          database: config.database,
          username: config.username ?? "default",
          password: conn.password,
          request_timeout: STATEMENT_TIMEOUT_MS,
          max_open_connections: 4,
        });
        handle = { kind: "clickhouse", client };
        break;
      }
      case "mongodb": {
        const client = new MongoClient(mongoConnectionString(config, conn.password), {
          connectTimeoutMS: connectTimeoutMs,
          serverSelectionTimeoutMS: connectTimeoutMs,
          maxPoolSize: 4,
        });
        await client.connect();
        handle = { kind: "mongodb", client };
        break;
      }
      default:
        throw new Error(`unsupported db connection type "${(config as { type: string }).type}"`);
    }
    handles.set(name, handle);
    return handle;
  }

  function assertSqlAllowed(conn: ResolvedDbConnection, sql: string) {
    if (conn.config.readOnly && !isSelectStatement(sql)) {
      throw new Error(
        `connection "${conn.name}" is read-only: only SELECT statements are allowed`,
      );
    }
  }

  return {
    async query(name, sql, params = []) {
      const conn = getConnection(name);
      if (conn.config.type === "redis") {
        throw new Error(`connection "${name}" is redis: use rp.db.redis() instead of query()`);
      }
      if (conn.config.type === "mongodb") {
        throw new Error(`connection "${name}" is mongodb: use rp.db.mongo() instead of query()`);
      }
      assertSqlAllowed(conn, sql);
      const handle = await getHandle(name);
      switch (handle.kind) {
        case "postgres": {
          const text = convertPlaceholders(sql, "postgres");
          const res = await withStatementTimeout(handle.pool.query(text, params));
          return truncateRows(res.rows as Record<string, unknown>[]);
        }
        case "mysql": {
          const [rows] = await withStatementTimeout(handle.pool.query(sql, params));
          const list = (rows as Record<string, unknown>[]).map((r) => ({ ...r }));
          return truncateRows(list);
        }
        case "sqlite": {
          const rows = handle.db.prepare(sql).all(...params) as Record<string, unknown>[];
          return truncateRows(rows.map((r) => ({ ...r })));
        }
        case "sqlserver": {
          const request = handle.pool.request();
          const text = convertPlaceholders(sql, "sqlserver");
          params.forEach((value, i) => request.input(`p${i + 1}`, value));
          const res = await withStatementTimeout(request.query(text));
          const rows = (res.recordset ?? []).map((r) => ({ ...r }) as Record<string, unknown>);
          return truncateRows(rows);
        }
        case "oracle": {
          const text = convertPlaceholders(sql, "oracle");
          const connection = await handle.pool.getConnection();
          try {
            const res = await withStatementTimeout(
              connection.execute(text, params, { outFormat: oracledb.OUT_FORMAT_OBJECT }),
            );
            const rows = ((res.rows ?? []) as Record<string, unknown>[]).map((r) => ({ ...r }));
            return truncateRows(rows);
          } finally {
            await connection.close().catch(() => {});
          }
        }
        case "clickhouse": {
          const text = inlineClickHouseParams(sql, params);
          const resultSet = await withStatementTimeout(
            handle.client.query({ query: text, format: "JSONEachRow" }),
          );
          const rows = await resultSet.json<Record<string, unknown>>();
          return truncateRows(rows.map((r) => ({ ...r })));
        }
        default:
          throw new Error(`connection "${name}" does not support SQL query`);
      }
    },

    async exec(name, sql, params = []) {
      const conn = getConnection(name);
      if (conn.config.type === "redis") {
        throw new Error(`connection "${name}" is redis: use rp.db.redis() instead of exec()`);
      }
      if (conn.config.type === "mongodb") {
        throw new Error(`connection "${name}" is mongodb: use rp.db.mongo() instead of exec()`);
      }
      assertSqlAllowed(conn, sql);
      const handle = await getHandle(name);
      switch (handle.kind) {
        case "postgres": {
          const text = convertPlaceholders(sql, "postgres");
          const res = await withStatementTimeout(handle.pool.query(text, params));
          return { affectedRows: res.rowCount ?? 0 };
        }
        case "mysql": {
          const [result] = await withStatementTimeout(handle.pool.query(sql, params));
          return { affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
        }
        case "sqlite": {
          const info = handle.db.prepare(sql).run(...params);
          return { affectedRows: Number(info.changes) };
        }
        case "sqlserver": {
          const request = handle.pool.request();
          const text = convertPlaceholders(sql, "sqlserver");
          params.forEach((value, i) => request.input(`p${i + 1}`, value));
          const res = await withStatementTimeout(request.query(text));
          const affected = (res.rowsAffected ?? []).reduce((sum, n) => sum + n, 0);
          return { affectedRows: affected };
        }
        case "oracle": {
          const text = convertPlaceholders(sql, "oracle");
          const connection = await handle.pool.getConnection();
          try {
            const res = await withStatementTimeout(
              connection.execute(text, params, {
                outFormat: oracledb.OUT_FORMAT_OBJECT,
                autoCommit: true,
              }),
            );
            return { affectedRows: res.rowsAffected ?? 0 };
          } finally {
            await connection.close().catch(() => {});
          }
        }
        case "clickhouse": {
          // clickhouse 无 affectedRows 语义（HTTP 协议不返回行数），写入成功即返回 0
          const text = inlineClickHouseParams(sql, params);
          await withStatementTimeout(handle.client.command({ query: text }));
          return { affectedRows: 0 };
        }
        default:
          throw new Error(`connection "${name}" does not support SQL exec`);
      }
    },

    async redis(name, command, args = []) {
      const conn = getConnection(name);
      if (conn.config.type !== "redis") {
        throw new Error(`connection "${name}" is not redis (type: ${conn.config.type})`);
      }
      const handle = await getHandle(name);
      if (handle.kind !== "redis") throw new Error(`connection "${name}" is not redis`);
      const reply = await withStatementTimeout(
        handle.client.sendCommand([command.toUpperCase(), ...args.map(String)]),
      );
      return normalizeRedisReply(reply);
    },

    async mongo(name, command) {
      const conn = getConnection(name);
      if (conn.config.type !== "mongodb") {
        throw new Error(`connection "${name}" is not mongodb (type: ${conn.config.type})`);
      }
      const handle = await getHandle(name);
      if (handle.kind !== "mongodb") throw new Error(`connection "${name}" is not mongodb`);
      // database 未配置时使用连接串里的默认库
      const db = conn.config.database
        ? handle.client.db(conn.config.database)
        : handle.client.db();
      return withStatementTimeout(db.command(command));
    },

    async close() {
      if (closed) return;
      closed = true;
      const closers = [...handles.values()].map(async (handle) => {
        try {
          switch (handle.kind) {
            case "postgres":
              await handle.pool.end();
              break;
            case "mysql":
              await handle.pool.end();
              break;
            case "sqlite":
              handle.db.close();
              break;
            case "redis":
              if (handle.client.isOpen) await handle.client.quit();
              break;
            case "sqlserver":
              await handle.pool.close();
              break;
            case "oracle":
              await handle.pool.close(0);
              break;
            case "clickhouse":
              await handle.client.close();
              break;
            case "mongodb":
              await handle.client.close();
              break;
          }
        } catch {
          // 关闭失败不影响主流程
        }
      });
      await Promise.all(closers);
      handles.clear();
    },
  };
}

/**
 * 连通性测试：建临时连接执行最小语句后关闭。
 * 各类型语句：SQL 类 SELECT 1（oracle 加 FROM DUAL），redis PING，mongodb { ping: 1 }。
 */
export async function pingDbConnection(resolved: ResolvedDbConnection): Promise<void> {
  const executor = createDbExecutor([resolved]);
  try {
    switch (resolved.config.type) {
      case "redis":
        await executor.redis(resolved.name, "PING");
        break;
      case "mongodb":
        await executor.mongo(resolved.name, { ping: 1 });
        break;
      case "oracle":
        await executor.query(resolved.name, "SELECT 1 FROM DUAL");
        break;
      default:
        await executor.query(resolved.name, "SELECT 1");
    }
  } finally {
    await executor.close();
  }
}

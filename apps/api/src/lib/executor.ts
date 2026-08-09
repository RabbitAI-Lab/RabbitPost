/**
 * HTTP 请求执行引擎：变量替换 -> pre-request 脚本 -> 发送 -> test 脚本 -> 落历史。
 * 网络/上游错误一律原文透传，不封装为笼统提示。
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  ConsoleLogEntry,
  DbExtraction,
  DbOperation,
  DbQueryResult,
  EnvironmentVariable,
  ExecuteRequestInput,
  ExecuteResult,
  KeyValueItem,
  RequestConfig,
  ResolvedRequestSettings,
  ResponseCookie,
  TestResult,
  VariableMap,
} from "@rabbitpost/shared";
import { resolveRequestSettings, substituteVariables } from "@rabbitpost/shared";
import { normalizeRequestAuth } from "@rabbitpost/shared";
import { db } from "../db";
import { collectionItems, collections, environments, histories, workspaces } from "../db/schema";
import { createDbExecutor, isSelectStatement, type DbExecutor } from "./db-client";
import { loadWorkspaceDbConnections } from "./db-connections";
import { findHeader, sendRequest, type SendRequestOptions } from "./http-client";
import { runUserScript } from "./pm-sandbox";
import { applyAuth, parseDigestChallenge } from "./request-auth";

const MAX_BODY_CAPTURE_BYTES = 1024 * 1024; // 响应体最多回传 1MB

const TEXTUAL_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/problem+",
  "image/svg+xml",
  "+json",
  "+xml",
];

/** 展开网络错误的 cause 链（兼容 AggregateError，如多地址连接均失败） */
function formatNetworkError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [];
  const walk = (err: unknown): void => {
    if (err instanceof AggregateError) {
      for (const inner of err.errors) walk(inner);
      return;
    }
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code ? `${err.message} [${code}]` : err.message;
      if (msg) parts.push(msg);
      if (err.cause) walk(err.cause);
      return;
    }
    if (err !== undefined && err !== null) parts.push(String(err));
  };
  walk(e);
  return [...new Set(parts)].join(" -> ") || String(e);
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true; // 未声明时按文本处理，方便阅读
  const ct = contentType.toLowerCase();
  return TEXTUAL_CONTENT_TYPES.some((t) => ct.includes(t));
}

function enabledToMap(items: KeyValueItem[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of items) {
    if (item.enabled && item.key) map[item.key] = item.value;
  }
  return map;
}

/** 解析 Set-Cookie 头为结构化 cookie（属性名大小写不敏感） */
function parseSetCookies(setCookies: string[]): ResponseCookie[] {
  const cookies: ResponseCookie[] = [];
  for (const raw of setCookies) {
    const segments = raw.split(";").map((s) => s.trim());
    const first = segments.shift();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const cookie: ResponseCookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
    };
    for (const seg of segments) {
      const i = seg.indexOf("=");
      const attr = (i === -1 ? seg : seg.slice(0, i)).trim().toLowerCase();
      const val = i === -1 ? "" : seg.slice(i + 1).trim();
      switch (attr) {
        case "domain":
          cookie.domain = val;
          break;
        case "path":
          cookie.path = val;
          break;
        case "expires":
          cookie.expires = val;
          break;
        case "max-age": {
          const n = Number(val);
          if (Number.isFinite(n)) cookie.maxAge = n;
          break;
        }
        case "httponly":
          cookie.httpOnly = true;
          break;
        case "secure":
          cookie.secure = true;
          break;
        case "samesite":
          cookie.sameSite = val;
          break;
      }
    }
    cookies.push(cookie);
  }
  return cookies;
}

async function loadEnvironmentVariables(
  environmentId: string | null | undefined,
  workspaceId: string,
): Promise<VariableMap> {
  if (!environmentId) return {};
  const [envRow] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!envRow || envRow.workspaceId !== workspaceId) return {};
  const vars: VariableMap = {};
  for (const v of envRow.variables as EnvironmentVariable[]) {
    if (v.enabled && v.key) vars[v.key] = v.value;
  }
  return vars;
}

/** Workspace 级全局变量（优先级最低，Collection / Environment 同名覆盖） */
async function loadWorkspaceVariables(workspaceId: string): Promise<VariableMap> {
  const [ws] = await db
    .select({ variables: workspaces.variables })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws?.variables) return {};
  const vars: VariableMap = {};
  for (const v of ws.variables as KeyValueItem[]) {
    if (v.enabled && v.key) vars[v.key] = v.value;
  }
  return vars;
}

/** Collection 级变量（优先级低于 Environment）；itemId 为请求条目时自动定位所属 Collection */
async function loadCollectionVariables(itemId: string | undefined): Promise<VariableMap> {
  if (!itemId) return {};
  const [item] = await db
    .select({ collectionId: collectionItems.collectionId })
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .limit(1);
  if (!item) return {};
  const [col] = await db
    .select({ variables: collections.variables })
    .from(collections)
    .where(eq(collections.id, item.collectionId))
    .limit(1);
  if (!col?.variables) return {};
  const vars: VariableMap = {};
  for (const v of col.variables as EnvironmentVariable[]) {
    if (v.enabled && v.key) vars[v.key] = v.value;
  }
  return vars;
}

/** 递归替换对象内所有字符串中的 {{var}}（各 auth 类型字段结构不一，统一处理） */
function substituteDeep<T>(value: T, sub: (s: string) => string): T {
  if (typeof value === "string") return sub(value) as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, sub)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteDeep(v, sub),
      ]),
    ) as T;
  }
  return value;
}

function substituteConfig(config: RequestConfig, vars: VariableMap): RequestConfig {
  const sub = (s: string) => substituteVariables(s, vars);
  const subItems = (items: KeyValueItem[]) =>
    items.map((it) => ({ ...it, key: sub(it.key), value: sub(it.value) }));
  return {
    ...config,
    url: sub(config.url),
    params: subItems(config.params),
    headers: subItems(config.headers),
    body: {
      ...config.body,
      raw: config.body.raw !== undefined ? sub(config.body.raw) : undefined,
      formData: config.body.formData ? subItems(config.body.formData) : undefined,
      urlencoded: config.body.urlencoded
        ? subItems(config.body.urlencoded)
        : undefined,
      graphqlQuery:
        config.body.graphqlQuery !== undefined
          ? sub(config.body.graphqlQuery)
          : undefined,
      graphqlVariables:
        config.body.graphqlVariables !== undefined
          ? sub(config.body.graphqlVariables)
          : undefined,
    },
    // 旧版扁平 auth 字段先归一化为嵌套结构，再递归做变量替换
    auth: substituteDeep(normalizeRequestAuth(config.auth), sub),
  };
}

interface BuiltRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** encodeUrl=false 时按原文发送的 path?query */
  rawPath?: string;
  bodyPreview?: string;
  /** Digest 缺 realm/nonce：需先发一次请求取 401 挑战，再重签重发 */
  needsDigestChallenge: boolean;
}

/** 手工组装 multipart/form-data，以便拿到完整 body（签名与 Content-Length 均需） */
function buildMultipartBody(items: KeyValueItem[]): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----RabbitPostBoundary${crypto.randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const item of items) {
    if (!item.enabled || !item.key) continue;
    if (item.type === "file") {
      if (!item.fileBase64) continue;
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${item.key}"; ` +
            `filename="${item.fileName ?? "file"}"\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n",
        ),
      );
      parts.push(Buffer.from(item.fileBase64, "base64"));
      parts.push(Buffer.from("\r\n"));
    } else {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${item.key}"\r\n\r\n` +
            `${item.value}\r\n`,
        ),
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * encodeUrl=false 时按用户原文拼 path?query（不做百分号编码）；
 * 认证环节追加的参数仍按规范编码，否则签名不成立。
 */
function rawPathOf(
  originalUrl: string,
  params: KeyValueItem[],
  authAddedParams: [string, string][],
): string {
  const withScheme = /^https?:\/\//i.test(originalUrl)
    ? originalUrl
    : `http://${originalUrl}`;
  const afterAuthority = withScheme.slice(withScheme.indexOf("://") + 3);
  const slash = afterAuthority.indexOf("/");
  const tail = (slash === -1 ? "" : afterAuthority.slice(slash)).split("#")[0] ?? "";
  const queryAt = tail.indexOf("?");
  const pathname = queryAt === -1 ? tail : tail.slice(0, queryAt);
  const queries = [
    queryAt === -1 ? "" : tail.slice(queryAt + 1),
    ...params.filter((p) => p.enabled && p.key).map((p) => `${p.key}=${p.value}`),
    ...authAddedParams.map(
      ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    ),
  ].filter(Boolean);
  return `${pathname || "/"}${queries.length ? `?${queries.join("&")}` : ""}`;
}

/** 组装请求；digestChallenge 为 Digest 第二轮的服务端挑战参数 */
function buildRequest(
  config: RequestConfig,
  settings: ResolvedRequestSettings,
  digestChallenge?: Record<string, string>,
): BuiltRequest {
  const headers = new Headers();
  for (const h of config.headers) {
    if (h.enabled && h.key) headers.set(h.key, h.value);
  }

  // url + query params
  let url = config.url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const urlObj = new URL(url);
  for (const p of config.params) {
    if (p.enabled && p.key) urlObj.searchParams.append(p.key, p.value);
  }

  // body：bodyBuffer 同时用于发送与签名时计算内容哈希
  let bodyBuffer: Buffer | undefined;
  let bodyPreview: string | undefined;
  const method = config.method.toUpperCase();
  const canHaveBody = !["GET", "HEAD"].includes(method);
  if (canHaveBody && config.body.type !== "none") {
    switch (config.body.type) {
      case "raw": {
        const raw = config.body.raw ?? "";
        bodyBuffer = Buffer.from(raw);
        bodyPreview = raw;
        if (config.body.rawLanguage === "json" && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        } else if (config.body.rawLanguage === "xml" && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/xml");
        } else if (config.body.rawLanguage === "html" && !headers.has("Content-Type")) {
          headers.set("Content-Type", "text/html");
        }
        break;
      }
      case "x-www-form-urlencoded": {
        const params = new URLSearchParams();
        for (const item of config.body.urlencoded ?? []) {
          if (item.enabled && item.key) params.append(item.key, item.value);
        }
        const encoded = params.toString();
        bodyBuffer = Buffer.from(encoded);
        bodyPreview = encoded;
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/x-www-form-urlencoded");
        }
        break;
      }
      case "form-data": {
        const multipart = buildMultipartBody(config.body.formData ?? []);
        bodyBuffer = multipart.body;
        bodyPreview = "[form-data]";
        // 用户自定义 Content-Type 不带 boundary 时无法解析，因此始终以实际 boundary 为准
        headers.set("Content-Type", multipart.contentType);
        break;
      }
      case "binary": {
        if (config.body.binaryBase64) {
          bodyBuffer = Buffer.from(config.body.binaryBase64, "base64");
          bodyPreview = `[binary ${config.body.binaryFileName ?? "file"}]`;
        }
        break;
      }
      case "graphql": {
        // 同 Postman：以 JSON 形式发送 { query, variables }
        let variables: unknown;
        const varsText = config.body.graphqlVariables?.trim();
        if (varsText) {
          try {
            variables = JSON.parse(varsText);
          } catch {
            variables = undefined; // 非法 JSON 时忽略 variables
          }
        }
        const payload = JSON.stringify({
          query: config.body.graphqlQuery ?? "",
          ...(variables !== undefined ? { variables } : {}),
        });
        bodyBuffer = Buffer.from(payload);
        bodyPreview = payload;
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        break;
      }
    }
  }

  // auth：待 url / headers / body 就绪后签名，结果可能落在 header 或 query
  const paramsBeforeAuth = [...urlObj.searchParams.entries()];
  const { needsDigestChallenge = false } = applyAuth(config.auth, {
    method,
    url: urlObj,
    headers,
    body: bodyBuffer,
    digestChallenge,
  });
  const authAddedParams = [...urlObj.searchParams.entries()].slice(
    paramsBeforeAuth.length,
  );

  const headerMap: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerMap[key] = value;
  });

  return {
    url: urlObj,
    method,
    headers: headerMap,
    body: bodyBuffer,
    rawPath: settings.encodeUrl
      ? undefined
      : rawPathOf(config.url, config.params, authAddedParams),
    bodyPreview,
    needsDigestChallenge,
  };
}

/**
 * 声明式 db 操作的结果提取（对标 Apifox）：
 * rows=全部行(JSON) / row=首行(JSON) / row.<col>=首行某列标量 / value=Redis 返回值
 */
export function extractDbValue(
  source: DbExtraction["source"],
  queryResult?: DbQueryResult,
  redisValue?: unknown,
): string {
  if (source === "rows") return JSON.stringify(queryResult?.rows ?? []);
  if (source === "row") return JSON.stringify(queryResult?.rows?.[0] ?? null);
  if (source.startsWith("row.")) {
    const value = queryResult?.rows?.[0]?.[source.slice(4)];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : String(value);
  }
  // redis value
  if (redisValue === undefined || redisValue === null) return "";
  return typeof redisValue === "string" ? redisValue : JSON.stringify(redisValue);
}

/**
 * 执行声明式数据库操作（db.pre / db.post）。
 * 失败不中断请求：错误写入 consoleLogs（与脚本错误同一通道），继续后续步骤。
 */
async function runDbOperations(
  ops: DbOperation[],
  phase: "pre" | "post",
  dbExecutor: DbExecutor | undefined,
  vars: VariableMap,
  consoleLogs: ConsoleLogEntry[],
): Promise<VariableMap> {
  const out: VariableMap = { ...vars };
  for (const op of ops) {
    const label = `[db:${phase}] ${op.connection}`;
    try {
      if (!dbExecutor) throw new Error("no database connections configured");
      const statement = substituteVariables(op.statement, out);
      const params = op.params?.map((p) => substituteVariables(p, out));
      if (op.kind === "redis") {
        const [command, ...args] = statement.split(/\s+/).filter(Boolean);
        if (!command) throw new Error("empty redis command");
        const value = await dbExecutor.redis(op.connection, command, args);
        consoleLogs.push({ level: "log", args: [`${label} ${command} ok`] });
        for (const ext of op.extract ?? []) {
          out[ext.variable] = extractDbValue(ext.source, undefined, value);
        }
      } else if (op.kind === "mongo") {
        // statement 为 MongoDB runCommand 的 JSON 命令串
        let command: Record<string, unknown>;
        try {
          command = JSON.parse(statement) as Record<string, unknown>;
        } catch {
          throw new Error("mongo statement is not valid JSON");
        }
        if (!command || typeof command !== "object" || Array.isArray(command)) {
          throw new Error("mongo statement must be a JSON object");
        }
        const value = await dbExecutor.mongo(op.connection, command);
        consoleLogs.push({ level: "log", args: [`${label} mongo ok`] });
        // extract 语义对齐 SQL：单个 doc → rows=[doc]；含 cursor.firstBatch → 取该数组
        const doc =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : { value };
        const firstBatch = (doc.cursor as Record<string, unknown> | undefined)?.firstBatch;
        const rows = Array.isArray(firstBatch)
          ? (firstBatch as Record<string, unknown>[])
          : [doc];
        const res: DbQueryResult = { rows, rowCount: rows.length };
        for (const ext of op.extract ?? []) {
          out[ext.variable] =
            ext.source === "value"
              ? extractDbValue("value", undefined, value)
              : extractDbValue(ext.source, res);
        }
      } else if (isSelectStatement(statement)) {
        const res = await dbExecutor.query(op.connection, statement, params);
        consoleLogs.push({
          level: "log",
          args: [
            `${label} query ok, rowCount=${res.rowCount}${res.truncated ? " (truncated)" : ""}`,
          ],
        });
        for (const ext of op.extract ?? []) {
          out[ext.variable] = extractDbValue(ext.source, res);
        }
      } else {
        const res = await dbExecutor.exec(op.connection, statement, params);
        consoleLogs.push({
          level: "log",
          args: [`${label} exec ok, affectedRows=${res.affectedRows}`],
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      consoleLogs.push({ level: "error", args: [`${label} ${message}`] });
    }
  }
  return out;
}

export async function executeRequest(
  input: ExecuteRequestInput,
  userId: string,
): Promise<ExecuteResult> {
  const testResults: TestResult[] = [];
  const consoleLogs: ConsoleLogEntry[] = [];
  const startedAt = Date.now();

  // 1. 变量：globals 垫底，Collection 覆盖，Environment 最高（与 Postman 优先级一致）
  const globalVars = await loadWorkspaceVariables(input.workspaceId);
  const collectionVars = await loadCollectionVariables(input.itemId);
  const envVars = await loadEnvironmentVariables(input.environmentId, input.workspaceId);
  let vars: VariableMap = { ...globalVars, ...collectionVars, ...envVars };
  // rp.globals 作用域（脚本内 set/unset 仅当次执行生效，不持久化）
  let globals: VariableMap = { ...globalVars };

  // 2. 变量替换
  let config = substituteConfig(input.request, vars);

  // 数据库连接：优先用调用方随请求下发的明文（local-agent 路径），
  // 否则按 workspace 从 db_connections 加载并解密，应用当前环境的 envOverrides
  const resolvedConnections =
    input.dbConnections ??
    (await loadWorkspaceDbConnections(input.workspaceId, input.environmentId));
  const dbExecutor =
    resolvedConnections.length > 0 ? createDbExecutor(resolvedConnections) : undefined;

  try {
    // 3. db.pre（在 pre-request 脚本之前）
    if (input.request.dbOperations?.pre?.length) {
      vars = await runDbOperations(
        input.request.dbOperations.pre,
        "pre",
        dbExecutor,
        vars,
        consoleLogs,
      );
    }

    // 4. pre-request 脚本
    if (input.request.scripts.preRequest?.trim()) {
      const pre = await runUserScript({
        code: input.request.scripts.preRequest,
        phase: "pre-request",
        variables: vars,
        globals,
        db: dbExecutor,
        request: {
          method: config.method,
          url: config.url,
          headers: enabledToMap(config.headers),
        },
      });
      testResults.push(...pre.testResults);
      consoleLogs.push(...pre.consoleLogs);
      // 脚本改写的 globals 并入当次执行的变量表（仍保持 environment/collection 优先）
      globals = pre.globals;
      vars = { ...globals, ...pre.variables };
      if (pre.request) {
        // 脚本改写后的请求不再做变量替换（与 Postman 行为一致）
        config = {
          ...config,
          method: (pre.request.method as RequestConfig["method"]) ?? config.method,
          url: pre.request.url,
          headers: Object.entries(pre.request.headers).map(([key, value]) => ({
            id: key,
            key,
            value,
            enabled: true,
          })),
        };
      }
    }

    // 5. 发送请求
  let result: ExecuteResult;
  const settings = resolveRequestSettings(config.settings);
  try {
    // 超时贯穿整条重定向链；0 表示不超时
    const signal =
      settings.timeoutMs > 0 ? AbortSignal.timeout(settings.timeoutMs) : undefined;
    const toSendOptions = (built: BuiltRequest): SendRequestOptions => ({
      method: built.method,
      url: built.url,
      rawPath: built.rawPath,
      headers: built.headers,
      body: built.body,
      settings,
      signal,
    });

    let built = buildRequest(config, settings);
    let sent = await sendRequest(toSendOptions(built));

    // Digest 未填 realm/nonce：拿 401 的 WWW-Authenticate 挑战重签重发（同 curl / Postman）
    if (built.needsDigestChallenge && sent.response.status === 401) {
      const challengeHeader = findHeader(sent.response.headers, "www-authenticate");
      const challenge = challengeHeader ? parseDigestChallenge(challengeHeader) : null;
      if (challenge) {
        built = buildRequest(config, settings, challenge);
        sent = await sendRequest(toSendOptions(built));
      }
    }

    const durationMs = Date.now() - startedAt;
    const buffer = sent.response.body;
    const sizeBytes = buffer.byteLength;

    const responseHeaders: Record<string, string> = { ...sent.response.headers };
    if (sent.response.setCookies.length) {
      responseHeaders["set-cookie"] = sent.response.setCookies.join(", ");
    }
    const cookies = parseSetCookies(sent.response.setCookies);

    const contentType = findHeader(sent.response.headers, "content-type") ?? null;
    let bodyText: string;
    let bodyBase64 = false;
    if (buffer.byteLength > MAX_BODY_CAPTURE_BYTES) {
      bodyText = `[response body too large: ${sizeBytes} bytes, truncated]`;
    } else if (isTextual(contentType)) {
      bodyText = buffer.toString("utf-8");
    } else {
      bodyText = buffer.toString("base64");
      bodyBase64 = true;
    }

    result = {
      ok: true,
      status: sent.response.status,
      statusText: sent.response.statusText,
      headers: responseHeaders,
      cookies,
      bodyText,
      bodyBase64,
      sizeBytes,
      durationMs,
      testResults,
      consoleLogs,
    };

    // 6. db.post（响应返回后、test 脚本之前）
    if (input.request.dbOperations?.post?.length) {
      vars = await runDbOperations(
        input.request.dbOperations.post,
        "post",
        dbExecutor,
        vars,
        consoleLogs,
      );
    }

    // 7. test 脚本
    if (input.request.scripts.test?.trim()) {
      const post = await runUserScript({
        code: input.request.scripts.test,
        phase: "test",
        variables: vars,
        globals,
        db: dbExecutor,
        response: {
          code: sent.response.status,
          status: sent.response.statusText,
          headers: responseHeaders,
          time: durationMs,
          bodyText: bodyBase64 ? "" : bodyText,
        },
      });
      result.testResults = [...testResults, ...post.testResults];
      result.consoleLogs = [...consoleLogs, ...post.consoleLogs];
    }
  } catch (e) {
    // 网络层错误原文透传（含 cause 链 / AggregateError），并同样写入历史
    const message = formatNetworkError(e);
    result = {
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      testResults,
      consoleLogs,
    };
  }

    // 8. 写入历史（失败也记录，保留现场）
    try {
      await db.insert(histories).values({
        workspaceId: input.workspaceId,
        userId,
        name: input.name ?? null,
        request: input.request,
        response: result.ok
          ? {
              status: result.status!,
              statusText: result.statusText ?? "",
              sizeBytes: result.sizeBytes ?? 0,
              durationMs: result.durationMs ?? 0,
              headers: result.headers,
              bodyText: result.bodyText,
              bodyBase64: result.bodyBase64,
              cookies: result.cookies,
              testResults: result.testResults,
              consoleLogs: result.consoleLogs,
            }
          : null,
        error: result.ok ? null : (result.error ?? "unknown error"),
      });
    } catch (historyErr) {
      // 历史写入失败不影响主流程，仅日志
      console.error("[execute] failed to persist history:", historyErr);
    }

    return result;
  } finally {
    // 每次执行结束统一关闭本请求周期内建立的连接池
    await dbExecutor?.close();
  }
}

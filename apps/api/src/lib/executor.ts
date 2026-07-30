/**
 * HTTP 请求执行引擎：变量替换 -> pre-request 脚本 -> 发送 -> test 脚本 -> 落历史。
 * 网络/上游错误一律原文透传，不封装为笼统提示。
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  ConsoleLogEntry,
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
import { environments, histories } from "../db/schema";
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

export async function executeRequest(
  input: ExecuteRequestInput,
  userId: string,
): Promise<ExecuteResult> {
  const testResults: TestResult[] = [];
  const consoleLogs: ConsoleLogEntry[] = [];
  const startedAt = Date.now();

  // 1. 环境变量
  let vars = await loadEnvironmentVariables(input.environmentId, input.workspaceId);

  // 2. 变量替换
  let config = substituteConfig(input.request, vars);

  // 3. pre-request 脚本
  if (input.request.scripts.preRequest?.trim()) {
    const pre = runUserScript({
      code: input.request.scripts.preRequest,
      phase: "pre-request",
      variables: vars,
      request: {
        method: config.method,
        url: config.url,
        headers: enabledToMap(config.headers),
      },
    });
    testResults.push(...pre.testResults);
    consoleLogs.push(...pre.consoleLogs);
    vars = pre.variables;
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

  // 4. 发送请求
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

    // 5. test 脚本
    if (input.request.scripts.test?.trim()) {
      const post = runUserScript({
        code: input.request.scripts.test,
        phase: "test",
        variables: vars,
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

  // 6. 写入历史（失败也记录，保留现场）
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
          }
        : null,
      error: result.ok ? null : (result.error ?? "unknown error"),
    });
  } catch (historyErr) {
    // 历史写入失败不影响主流程，仅日志
    console.error("[execute] failed to persist history:", historyErr);
  }

  return result;
}

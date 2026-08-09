/**
 * 请求发送层：基于 Node 内置 http / https / http2，按请求级 Settings 控制
 * TLS 证书校验、cipher suite、协议版本、HTTP 解析严格度、重定向细节与未编码路径。
 * 这些能力 fetch 无法逐请求配置，故直接使用底层模块。
 */
import { constants as cryptoConstants } from "node:crypto";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { ResolvedRequestSettings, TlsProtocol } from "@rabbitpost/shared";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

export interface RawHttpResponse {
  status: number;
  /** HTTP/2 无 reason phrase，此时为空串 */
  statusText: string;
  /** header 名统一小写；set-cookie 单独放在 setCookies */
  headers: Record<string, string>;
  setCookies: string[];
  body: Buffer;
}

export interface SendRequestOptions {
  method: string;
  url: URL;
  /** encodeUrl=false 时按原文发送的 path?query；缺省用 url 编码后的值 */
  rawPath?: string;
  headers: Record<string, string>;
  body?: Buffer;
  settings: ResolvedRequestSettings;
  /** 超时 / 取消信号，贯穿整个重定向链 */
  signal?: AbortSignal;
}

export interface SendRequestResult {
  response: RawHttpResponse;
  /** 跟随重定向后的最终 URL */
  finalUrl: URL;
  /** 实际跟随的重定向次数 */
  redirectCount: number;
}

/** 会被跟随的重定向状态码 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** TLS 协议版本 -> OpenSSL 禁用位 */
const TLS_PROTOCOL_DISABLE_FLAG: Record<TlsProtocol, number> = {
  SSLv3: cryptoConstants.SSL_OP_NO_SSLv3,
  TLSv1: cryptoConstants.SSL_OP_NO_TLSv1,
  "TLSv1.1": cryptoConstants.SSL_OP_NO_TLSv1_1,
  "TLSv1.2": cryptoConstants.SSL_OP_NO_TLSv1_2,
  "TLSv1.3": cryptoConstants.SSL_OP_NO_TLSv1_3,
};

/** HTTP/2 禁止出现的逐跳 header */
const HTTP2_FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

interface TlsSettings {
  rejectUnauthorized: boolean;
  ciphers?: string;
  honorCipherOrder?: boolean;
  secureOptions?: number;
}

/** 由 Settings 生成 TLS 握手参数 */
function tlsOptionsOf(settings: ResolvedRequestSettings): TlsSettings {
  const options: TlsSettings = { rejectUnauthorized: settings.verifySsl };
  let secureOptions = 0;
  for (const protocol of settings.disabledTlsProtocols) {
    secureOptions |= TLS_PROTOCOL_DISABLE_FLAG[protocol] ?? 0;
  }
  if (secureOptions) options.secureOptions = secureOptions;
  const ciphers = settings.cipherSuites
    .split(/[\s,;]+/)
    .filter(Boolean)
    .join(":");
  if (ciphers) options.ciphers = ciphers;
  // 握手时按服务端还是客户端的 cipher 顺序协商
  options.honorCipherOrder = settings.useServerCipherSuite;
  return options;
}

export function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

/** 请求体存在且用户未显式声明 Content-Length 时补上，避免退化为 chunked */
function withContentLength(
  headers: Record<string, string>,
  body: Buffer | undefined,
): Record<string, string> {
  const next = { ...headers };
  if (body && findHeader(next, "content-length") === undefined) {
    next["Content-Length"] = String(body.byteLength);
  }
  return next;
}

/**
 * HTTP 请求行不允许空白 / 控制符 / 非 ASCII，否则报文直接非法；
 * encodeUrl=false 时仅对这类字符做必要转义，其余保留原文（如 {} | " < >）。
 */
function sanitizeRawPath(rawPath: string): string {
  return rawPath.replace(/[^\u0021-\u007e]+/gu, (run) =>
    [...Buffer.from(run, "utf8")]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

function pathOf(options: SendRequestOptions): string {
  return options.rawPath === undefined
    ? `${options.url.pathname}${options.url.search}`
    : sanitizeRawPath(options.rawPath);
}

/** 收集 IncomingMessage 的 header 与响应体 */
function collectHttp1Response(res: http.IncomingMessage): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const setCookies: string[] = [];
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === "set-cookie") {
        setCookies.push(...(Array.isArray(value) ? value : [value]));
        continue;
      }
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("error", reject);
    res.on("end", () =>
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        headers,
        setCookies,
        body: Buffer.concat(chunks),
      }),
    );
  });
}

function sendHttp1(options: SendRequestOptions): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const isHttps = options.url.protocol === "https:";
    const tls = isHttps ? tlsOptionsOf(options.settings) : undefined;
    const requestOptions: https.RequestOptions = {
      method: options.method,
      protocol: options.url.protocol,
      hostname: options.url.hostname,
      port: options.url.port || (isHttps ? 443 : 80),
      path: pathOf(options),
      headers: withContentLength(options.headers, options.body),
      // strictHttpParser 关闭时宽松解析，接受含非法 header 的响应
      insecureHTTPParser: !options.settings.strictHttpParser,
      signal: options.signal,
      ...(tls ?? {}),
    };
    const request = (isHttps ? https : http).request(
      {
        ...requestOptions,
        // 不复用连接：避开连接池导致的 TLS 参数失效，且空闲 socket 上的解析错误
        // 会在无请求上下文时抛出（无法由本次请求捕获）
        agent: isHttps
          ? new https.Agent({ keepAlive: false, ...tls })
          : new http.Agent({ keepAlive: false }),
      },
      (res) => {
        collectHttp1Response(res).then(resolve, reject);
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function sendHttp2(options: SendRequestOptions): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const isHttps = options.url.protocol === "https:";
    const session = http2.connect(options.url.origin, {
      ...(isHttps ? tlsOptionsOf(options.settings) : {}),
    });
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      session.close();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const requestHeaders: Record<string, string> = {
      [http2.constants.HTTP2_HEADER_METHOD]: options.method,
      [http2.constants.HTTP2_HEADER_PATH]: pathOf(options),
      [http2.constants.HTTP2_HEADER_SCHEME]: options.url.protocol.replace(":", ""),
      [http2.constants.HTTP2_HEADER_AUTHORITY]: options.url.host,
    };
    for (const [key, value] of Object.entries(
      withContentLength(options.headers, options.body),
    )) {
      // HTTP/2 禁止逐跳 header，Host 由 :authority 承载
      if (HTTP2_FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
      requestHeaders[key.toLowerCase()] = value;
    }

    session.on("error", fail);
    const stream = session.request(requestHeaders);
    if (options.signal) {
      const onAbort = () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        fail(options.signal!.reason ?? new Error("The operation was aborted"));
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const headers: Record<string, string> = {};
    const setCookies: string[] = [];
    let status = 0;
    stream.on("response", (h) => {
      status = Number(h[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
      for (const [key, value] of Object.entries(h)) {
        if (key.startsWith(":") || value === undefined) continue;
        if (key.toLowerCase() === "set-cookie") {
          setCookies.push(...(Array.isArray(value) ? value : [String(value)]));
          continue;
        }
        headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      session.close();
      resolve({
        status,
        statusText: "",
        headers,
        setCookies,
        body: Buffer.concat(chunks),
      });
    });

    if (options.body) stream.write(options.body);
    stream.end();
  });
}

/**
 * 按 Content-Encoding 解压响应体（gzip / deflate / br）。
 * 底层 http/http2 模块不做解压，不解压会让调用方拿到压缩字节。
 * 解压失败时保留原始体：响应本身已到达，不掩盖现场。
 */
async function decompressResponse(resp: RawHttpResponse): Promise<RawHttpResponse> {
  const encoding = findHeader(resp.headers, "content-encoding")
    ?.toLowerCase()
    .trim();
  if (!encoding || encoding === "identity" || resp.body.byteLength === 0) {
    return resp;
  }
  try {
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        return { ...resp, body: await gunzip(resp.body) };
      case "deflate":
        // deflate 有 zlib 包装与裸 deflate 两种实现，先试带包装的
        try {
          return { ...resp, body: await inflate(resp.body) };
        } catch {
          return { ...resp, body: await inflateRaw(resp.body) };
        }
      case "br":
        return { ...resp, body: await brotliDecompress(resp.body) };
      default:
        return resp;
    }
  } catch {
    return resp;
  }
}

/** 单次发送（不含重定向）：按 HTTP version 设置选择 h2 或 HTTP/1.1 */
async function sendOnce(options: SendRequestOptions): Promise<RawHttpResponse> {
  // auto 目前按 HTTP/1.1 协商，选择 HTTP/2 时才以 h2 直连
  const resp =
    options.settings.httpVersion === "http2"
      ? await sendHttp2(options)
      : await sendHttp1(options);
  return decompressResponse(resp);
}

/**
 * 发送请求并按 Settings 处理重定向：
 * 301/302/303 默认改用 GET 并丢弃请求体（followOriginalHttpMethod 可保留原方法），
 * 307/308 始终沿用原方法；跨主机默认丢弃 Authorization；Referer 依设置移除或指向上一跳。
 */
export async function sendRequest(
  options: SendRequestOptions,
): Promise<SendRequestResult> {
  const { settings } = options;
  let current: SendRequestOptions = options;
  let redirectCount = 0;

  for (;;) {
    const response = await sendOnce(current);
    const location = findHeader(response.headers, "location");
    if (
      !settings.followRedirects ||
      !REDIRECT_STATUSES.has(response.status) ||
      !location
    ) {
      return { response, finalUrl: current.url, redirectCount };
    }
    if (redirectCount >= settings.maxRedirects) {
      throw new Error(
        `Exceeded maxRedirects of ${settings.maxRedirects} while following ${current.url.toString()}`,
      );
    }
    redirectCount += 1;

    const nextUrl = new URL(location, current.url);
    const headers = { ...current.headers };
    if (
      nextUrl.hostname !== current.url.hostname &&
      !settings.followAuthorizationHeader
    ) {
      deleteHeader(headers, "authorization");
    }
    if (settings.removeRefererOnRedirect) deleteHeader(headers, "referer");
    else setHeader(headers, "Referer", current.url.toString());

    let method = current.method;
    let body = current.body;
    const keepsMethod =
      settings.followOriginalHttpMethod ||
      response.status === 307 ||
      response.status === 308;
    if (!keepsMethod && method.toUpperCase() !== "HEAD") {
      method = "GET";
      body = undefined;
      deleteHeader(headers, "content-type");
      deleteHeader(headers, "content-length");
    }

    current = {
      ...current,
      url: nextUrl,
      // 重定向目标由 Location 解析而来，按标准编码发送
      rawPath: undefined,
      method,
      body,
      headers,
    };
  }
}

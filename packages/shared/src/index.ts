/**
 * RabbitPost shared domain model & API contracts.
 * Used by both apps/web (Vite) and apps/api (Next.js).
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const TEAM_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** 请求协议类型；保存到 Collection 后不可再修改 */
export const REQUEST_PROTOCOLS = [
  "http",
  "graphql",
  "ai",
  "mcp",
  "grpc",
  "websocket",
  "socketio",
  "mqtt",
] as const;
export type RequestProtocol = (typeof REQUEST_PROTOCOLS)[number];

/** Body 类型；顺序与 Postman 单选一致 */
export const BODY_TYPES = [
  "none",
  "form-data",
  "x-www-form-urlencoded",
  "raw",
  "binary",
  "graphql",
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const RAW_LANGUAGES = [
  "json",
  "text",
  "xml",
  "html",
  "javascript",
] as const;
export type RawLanguage = (typeof RAW_LANGUAGES)[number];

/** Auth 类型；顺序与 Postman 下拉一致 */
export const AUTH_TYPES = [
  "none",
  "basic",
  "bearer",
  "jwt",
  "digest",
  "oauth1",
  "oauth2",
  "hawk",
  "aws-sigv4",
  "ntlm",
  "api-key",
  "edgegrid",
  "asap",
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** Auth 类型展示文案（与 Postman 一致） */
export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: "No Auth",
  basic: "Basic Auth",
  bearer: "Bearer Token",
  jwt: "JWT Bearer",
  digest: "Digest Auth",
  oauth1: "OAuth 1.0",
  oauth2: "OAuth 2.0",
  hawk: "Hawk Authentication",
  "aws-sigv4": "AWS Signature",
  ntlm: "NTLM Authentication",
  "api-key": "API Key",
  edgegrid: "Akamai EdgeGrid",
  asap: "ASAP (Atlassian)",
};

export const JWT_ALGORITHMS = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export const DIGEST_ALGORITHMS = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
] as const;
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export const OAUTH1_SIGNATURE_METHODS = [
  "HMAC-SHA1",
  "HMAC-SHA256",
  "HMAC-SHA512",
  "RSA-SHA1",
  "RSA-SHA256",
  "PLAINTEXT",
] as const;
export type OAuth1SignatureMethod = (typeof OAUTH1_SIGNATURE_METHODS)[number];

export const OAUTH2_GRANT_TYPES = [
  "authorization_code",
  "authorization_code_pkce",
  "implicit",
  "password",
  "client_credentials",
] as const;
export type OAuth2GrantType = (typeof OAUTH2_GRANT_TYPES)[number];

export const HAWK_ALGORITHMS = ["sha256", "sha1"] as const;
export type HawkAlgorithm = (typeof HAWK_ALGORITHMS)[number];

/** 发送请求使用的 HTTP 版本（同 Postman Settings 的 HTTP version） */
export const HTTP_VERSIONS = ["auto", "http1", "http2"] as const;
export type HttpVersion = (typeof HTTP_VERSIONS)[number];

export const HTTP_VERSION_LABELS: Record<HttpVersion, string> = {
  auto: "Auto",
  http1: "HTTP/1.x",
  http2: "HTTP/2",
};

/** 可在 TLS 握手阶段禁用的协议版本 */
export const TLS_PROTOCOLS = [
  "SSLv3",
  "TLSv1",
  "TLSv1.1",
  "TLSv1.2",
  "TLSv1.3",
] as const;
export type TlsProtocol = (typeof TLS_PROTOCOLS)[number];

// ---------------------------------------------------------------------------
// Request building blocks
// ---------------------------------------------------------------------------

export interface KeyValueItem {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /** form-data 场景：条目类型，缺省 text */
  type?: "text" | "file";
  /** form-data file 类型：文件内容 base64 */
  fileBase64?: string;
  /** form-data file 类型：文件名 */
  fileName?: string;
}

export interface RequestBody {
  type: BodyType;
  raw?: string;
  rawLanguage?: RawLanguage;
  formData?: KeyValueItem[];
  urlencoded?: KeyValueItem[];
  /** binary 暂以 base64 字符串承载 */
  binaryBase64?: string;
  binaryFileName?: string;
  /** GraphQL 查询语句 */
  graphqlQuery?: string;
  /** GraphQL 变量（JSON 文本） */
  graphqlVariables?: string;
  /** GraphQL schema 获取方式；缺省 auto */
  graphqlSchemaMode?: "auto" | "none";
}

export interface BasicAuthConfig {
  username?: string;
  password?: string;
}

export interface BearerAuthConfig {
  token?: string;
}

export interface ApiKeyAuthConfig {
  key?: string;
  value?: string;
  /** 注入位置；缺省 header */
  in?: "header" | "query";
}

/** JWT Bearer：本地签发 JWT 并注入请求 */
export interface JwtAuthConfig {
  /** 缺省 HS256 */
  algorithm?: JwtAlgorithm;
  /** HS* 算法的密钥 */
  secret?: string;
  /** secret 是否为 base64 编码 */
  secretBase64Encoded?: boolean;
  /** RS / PS / ES 系列算法的 PEM 私钥 */
  privateKey?: string;
  /** 追加到 JWT header 的 JSON（alg/typ 自动生成） */
  jwtHeaders?: string;
  /** payload JSON */
  payload?: string;
  /** 注入位置；缺省 header */
  addTokenTo?: "header" | "query";
  /** header 前缀；缺省 Bearer */
  headerPrefix?: string;
  /** addTokenTo=query 时的参数名；缺省 token */
  queryParamKey?: string;
}

/** Digest Auth；realm/nonce 缺省时由服务端先发一次请求取 401 挑战 */
export interface DigestAuthConfig {
  username?: string;
  password?: string;
  realm?: string;
  nonce?: string;
  /** 缺省 MD5 */
  algorithm?: DigestAlgorithm;
  qop?: "" | "auth" | "auth-int";
  nonceCount?: string;
  clientNonce?: string;
  opaque?: string;
}

export interface OAuth1AuthConfig {
  consumerKey?: string;
  consumerSecret?: string;
  accessToken?: string;
  tokenSecret?: string;
  /** 缺省 HMAC-SHA1 */
  signatureMethod?: OAuth1SignatureMethod;
  /** RSA-* 签名的 PEM 私钥 */
  privateKey?: string;
  callbackUrl?: string;
  verifier?: string;
  /** 缺省取当前时间 */
  timestamp?: string;
  /** 缺省随机生成 */
  nonce?: string;
  /** 缺省 1.0 */
  version?: string;
  realm?: string;
  /** 附带 oauth_body_hash */
  includeBodyHash?: boolean;
  /** 参数注入位置；缺省 header */
  addParamsTo?: "header" | "query";
}

/** OAuth 2.0：仅携带已有 Access Token，不自动走授权流程换取 */
export interface OAuth2AuthConfig {
  /** 缺省 authorization_code */
  grantType?: OAuth2GrantType;
  accessToken?: string;
  /** header 前缀；缺省 Bearer */
  headerPrefix?: string;
  /** 注入位置；缺省 header */
  addTokenTo?: "header" | "query";
  /** 以下为换取 token 的配置，仅保存备查 */
  callbackUrl?: string;
  authUrl?: string;
  accessTokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  state?: string;
  username?: string;
  password?: string;
  clientAuthentication?: "header" | "body";
}

export interface HawkAuthConfig {
  authId?: string;
  authKey?: string;
  /** 缺省 sha256 */
  algorithm?: HawkAlgorithm;
  user?: string;
  nonce?: string;
  extraData?: string;
  app?: string;
  dlg?: string;
  timestamp?: string;
  /** 计算并附带 body hash */
  includePayloadHash?: boolean;
}

export interface AwsSigV4AuthConfig {
  accessKey?: string;
  secretKey?: string;
  region?: string;
  service?: string;
  sessionToken?: string;
  /** 签名注入位置；缺省 header（query 为预签名） */
  addAuthDataTo?: "header" | "query";
}

export interface NtlmAuthConfig {
  username?: string;
  password?: string;
  domain?: string;
  workstation?: string;
  disableRetryRequest?: boolean;
}

export interface EdgeGridAuthConfig {
  accessToken?: string;
  clientToken?: string;
  clientSecret?: string;
  nonce?: string;
  timestamp?: string;
  baseUri?: string;
  /** 需签名的 header 名，逗号分隔 */
  headersToSign?: string;
}

/** ASAP (Atlassian)：用私钥签发 JWT 并以 Bearer 注入 */
export interface AsapAuthConfig {
  /** 缺省 RS256 */
  algorithm?: JwtAlgorithm;
  /** JWT header 的 kid */
  kid?: string;
  /** iss */
  issuer?: string;
  /** aud，多个用逗号分隔 */
  audience?: string;
  /** sub；缺省取 issuer */
  subject?: string;
  /** 额外 claims JSON */
  additionalClaims?: string;
  privateKey?: string;
  /** 有效期秒数；缺省 3600 */
  expirySeconds?: string;
  /** jti；缺省随机生成 */
  tokenId?: string;
}

export interface RequestAuth {
  type: AuthType;
  basic?: BasicAuthConfig;
  bearer?: BearerAuthConfig;
  jwt?: JwtAuthConfig;
  digest?: DigestAuthConfig;
  oauth1?: OAuth1AuthConfig;
  oauth2?: OAuth2AuthConfig;
  hawk?: HawkAuthConfig;
  awsSigv4?: AwsSigV4AuthConfig;
  ntlm?: NtlmAuthConfig;
  apiKey?: ApiKeyAuthConfig;
  edgegrid?: EdgeGridAuthConfig;
  asap?: AsapAuthConfig;

  /** @deprecated 旧版扁平字段，读取时由 normalizeRequestAuth 迁移到嵌套结构 */
  bearerToken?: string;
  /** @deprecated 同上 */
  basicUsername?: string;
  /** @deprecated 同上 */
  basicPassword?: string;
  /** @deprecated 同上 */
  apiKeyKey?: string;
  /** @deprecated 同上 */
  apiKeyValue?: string;
  /** @deprecated 同上 */
  apiKeyIn?: "header" | "query";
}

/**
 * 将旧版扁平 auth 字段（bearerToken / basicUsername / apiKeyKey 等）迁移为嵌套结构，
 * 已有嵌套值优先。读取已保存请求（打开 tab / 执行请求）时调用。
 */
export function normalizeRequestAuth(auth: RequestAuth | undefined): RequestAuth {
  if (!auth) return { type: "none" };
  const {
    bearerToken,
    basicUsername,
    basicPassword,
    apiKeyKey,
    apiKeyValue,
    apiKeyIn,
    ...rest
  } = auth;
  const next: RequestAuth = { ...rest };
  if (!next.bearer && bearerToken !== undefined) next.bearer = { token: bearerToken };
  if (!next.basic && (basicUsername !== undefined || basicPassword !== undefined)) {
    next.basic = { username: basicUsername, password: basicPassword };
  }
  if (
    !next.apiKey &&
    (apiKeyKey !== undefined || apiKeyValue !== undefined || apiKeyIn !== undefined)
  ) {
    next.apiKey = { key: apiKeyKey, value: apiKeyValue, in: apiKeyIn };
  }
  return next;
}

/** 当前 auth 是否已配置（用于 Tab 上的小圆点提示） */
export function isAuthConfigured(auth: RequestAuth | undefined): boolean {
  return !!auth && auth.type !== "none";
}

export interface RequestScripts {
  /** 请求发送前执行（rp.environment / rp.variables / rp.request 可写） */
  preRequest?: string;
  /** 响应返回后执行（rp.response / rp.test 可用） */
  test?: string;
}

/** 请求级设置（对齐 Postman Settings tab；缺省值见 DEFAULT_REQUEST_SETTINGS） */
export interface RequestSettings {
  /** 发送请求使用的 HTTP 版本 */
  httpVersion?: HttpVersion;
  /** 校验服务端 SSL 证书，校验失败则中止请求 */
  verifySsl?: boolean;
  /** 自动跟随 3xx 重定向 */
  followRedirects?: boolean;
  /** 重定向时沿用原 HTTP 方法（而非默认改用 GET） */
  followOriginalHttpMethod?: boolean;
  /** 重定向到不同主机时保留 Authorization 头 */
  followAuthorizationHeader?: boolean;
  /** 重定向时移除 Referer 头 */
  removeRefererOnRedirect?: boolean;
  /** 严格 HTTP 解析：拒绝含非法 header 的响应 */
  strictHttpParser?: boolean;
  /** 自动编码 URL 的 path 与 query */
  encodeUrl?: boolean;
  /** 本请求不使用 Cookie Jar（既不带上也不写回） */
  disableCookieJar?: boolean;
  /** 握手时采用服务端的 cipher suite 顺序 */
  useServerCipherSuite?: boolean;
  /** 最多跟随的重定向次数 */
  maxRedirects?: number;
  /** 握手时禁用的 TLS/SSL 协议版本 */
  disabledTlsProtocols?: TlsProtocol[];
  /** cipher suite 列表（OpenSSL 名称，逗号 / 空格 / 换行分隔） */
  cipherSuites?: string;
  /** 请求超时毫秒；0 表示不超时 */
  timeoutMs?: number;
}

export type ResolvedRequestSettings = Required<RequestSettings>;

/** 请求级设置缺省值；SSL 校验默认开启（不因对齐 Postman 而放宽安全默认值） */
export const DEFAULT_REQUEST_SETTINGS: ResolvedRequestSettings = {
  httpVersion: "auto",
  verifySsl: true,
  followRedirects: true,
  followOriginalHttpMethod: false,
  followAuthorizationHeader: false,
  removeRefererOnRedirect: false,
  strictHttpParser: false,
  encodeUrl: true,
  disableCookieJar: false,
  useServerCipherSuite: false,
  maxRedirects: 10,
  disabledTlsProtocols: [],
  cipherSuites: "",
  timeoutMs: 30_000,
};

/** 补齐请求级设置的缺省值；执行请求与设置面板共用，避免两侧默认值漂移。 */
export function resolveRequestSettings(
  settings: RequestSettings | undefined,
): ResolvedRequestSettings {
  const resolved: ResolvedRequestSettings = { ...DEFAULT_REQUEST_SETTINGS };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value === undefined || value === null) continue;
    (resolved as Record<string, unknown>)[key] = value;
  }
  return resolved;
}

export interface RequestConfig {
  /** 协议类型；历史数据缺省时视为 "http" */
  protocol?: RequestProtocol;
  method: HttpMethod;
  url: string;
  params: KeyValueItem[];
  headers: KeyValueItem[];
  body: RequestBody;
  auth: RequestAuth;
  scripts: RequestScripts;
  /** 请求文档（Markdown） */
  docs?: string;
  settings?: RequestSettings;
}

export function createEmptyRequestConfig(): RequestConfig {
  return {
    protocol: "http",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { type: "none", rawLanguage: "json" },
    auth: { type: "none" },
    scripts: {},
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  casdoorId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: string;
  /** 当前用户在该团队中的角色（列表接口返回） */
  role?: TeamRole;
}

export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamRole;
  joinedAt: string;
  user?: Pick<User, "id" | "name" | "email" | "avatarUrl">;
}

export interface Workspace {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  /** 侧边栏手动拖拽排序 */
  sortOrder: number;
  createdAt: string;
}

export type CollectionItemType = "folder" | "request";

export interface CollectionItem {
  id: string;
  collectionId: string;
  parentId: string | null;
  type: CollectionItemType;
  name: string;
  /** 文件夹 Overview 文档（Markdown）；仅 type === "folder" 时使用 */
  description?: string | null;
  sortOrder: number;
  /** 仅 type === "request" 时有值 */
  request?: RequestConfig;
  children?: CollectionItem[];
}

export type DocumentItemType = "folder" | "document";

/** Documents 模块条目：workspace 级自引用树（folder / document） */
export interface DocumentItem {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: DocumentItemType;
  name: string;
  /** 文档正文（Markdown）；仅 type === "document" 时使用 */
  content?: string | null;
  sortOrder: number;
  children?: DocumentItem[];
}

export interface EnvironmentVariable extends KeyValueItem {
  secret?: boolean;
}

export interface Environment {
  id: string;
  workspaceId: string;
  name: string;
  variables: EnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoryResponseSummary {
  status: number;
  statusText: string;
  sizeBytes: number;
  durationMs: number;
}

export interface HistoryEntry {
  id: string;
  workspaceId: string;
  userId: string;
  name: string | null;
  request: RequestConfig;
  response: HistoryResponseSummary | null;
  /** 网络层错误原样透传（不做封装改写） */
  error: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Execution (/api/v1/execute)
// ---------------------------------------------------------------------------

export interface ExecuteRequestInput {
  workspaceId: string;
  environmentId?: string | null;
  name?: string;
  request: RequestConfig;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConsoleLogEntry {
  level: "log" | "warn" | "error" | "info";
  args: string[];
}

/** 响应 Set-Cookie 解析结果 */
export interface ResponseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface ExecuteResult {
  ok: boolean;
  /** 网络/上游错误，原始透传 */
  error?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  cookies?: ResponseCookie[];
  bodyText?: string;
  bodyBase64?: boolean;
  sizeBytes?: number;
  durationMs?: number;
  testResults: TestResult[];
  consoleLogs: ConsoleLogEntry[];
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    /** 上游真实 HTTP 状态码（如执行代理场景） */
    upstreamStatus?: number;
    /** 上游原始响应体（透传，不改写） */
    upstreamBody?: unknown;
  };
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

// ---------------------------------------------------------------------------
// Variable substitution ({{varName}})
// ---------------------------------------------------------------------------

export type VariableMap = Record<string, string>;

const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** 用变量表替换模板中的 {{var}} 占位符；未命中的占位符保持原样。 */
export function substituteVariables(
  template: string,
  vars: VariableMap,
): string {
  return template.replace(VAR_PATTERN, (raw, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : raw,
  );
}

/** 提取模板中所有变量名。 */
export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(VAR_PATTERN)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Specs（定义类型与模板 / 校验 / 文档预览与生成 Collection）
// ---------------------------------------------------------------------------

export * from "./spec";
export * from "./spec-validate";
export * from "./spec-outline";

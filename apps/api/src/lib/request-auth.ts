/**
 * 各 Auth 类型的请求签名：按 RequestAuth 配置改写 headers / query。
 * 只做规范内的计算，任何缺失前置条件都抛出明确错误，不静默降级为“无认证”。
 */
import crypto from "node:crypto";
import type {
  AsapAuthConfig,
  AwsSigV4AuthConfig,
  DigestAuthConfig,
  EdgeGridAuthConfig,
  HawkAuthConfig,
  JwtAlgorithm,
  JwtAuthConfig,
  OAuth1AuthConfig,
  OAuth2AuthConfig,
  RequestAuth,
} from "@rabbitpost/shared";

export interface AuthApplyContext {
  method: string;
  /** 已拼好 query 的最终 URL，签名时可继续追加参数 */
  url: URL;
  /** 已含用户自定义头与 Content-Type */
  headers: Headers;
  /** 原始请求体，用于 body/payload hash；form-data 等无法取得时为 undefined */
  body?: Buffer;
  /** Digest 第二轮：服务端 401 的 WWW-Authenticate 挑战参数 */
  digestChallenge?: Record<string, string>;
}

export interface AuthApplyResult {
  /**
   * Digest 且未拿到 realm/nonce：需要先发一次请求取 401 挑战，
   * 再带 digestChallenge 重新签名重发。
   */
  needsDigestChallenge?: boolean;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(algorithm: string, key: Buffer | string, data: string): Buffer {
  return crypto.createHmac(algorithm, key).update(data, "utf8").digest();
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** JSON 字段解析；非法时报出字段名，方便定位 */
function parseJsonField(text: string | undefined, field: string): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("需为 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${field} 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// JWT 签名（JWT Bearer / ASAP 共用）
// ---------------------------------------------------------------------------

/** alg -> node 摘要算法 */
function jwtDigest(alg: JwtAlgorithm): string {
  const bits = alg.slice(2);
  return `sha${bits}`;
}

function signJwt(
  alg: JwtAlgorithm,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: { secret?: Buffer; privateKey?: string },
): string {
  const encodedHeader = base64url(
    Buffer.from(JSON.stringify({ alg, typ: "JWT", ...header })),
  );
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const digest = jwtDigest(alg);

  let signature: Buffer;
  if (alg.startsWith("HS")) {
    if (!key.secret) throw new Error(`${alg} 需要填写 Secret`);
    signature = hmac(digest, key.secret, signingInput);
  } else {
    if (!key.privateKey?.trim()) throw new Error(`${alg} 需要填写 Private Key`);
    if (alg.startsWith("PS")) {
      signature = crypto.sign(digest, Buffer.from(signingInput), {
        key: key.privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      });
    } else if (alg.startsWith("ES")) {
      signature = crypto.sign(digest, Buffer.from(signingInput), {
        key: key.privateKey,
        dsaEncoding: "ieee-p1363",
      });
    } else {
      signature = crypto.sign(digest, Buffer.from(signingInput), key.privateKey);
    }
  }
  return `${signingInput}.${base64url(signature)}`;
}

function applyJwt(cfg: JwtAuthConfig, ctx: AuthApplyContext): void {
  const alg = cfg.algorithm ?? "HS256";
  const token = signJwt(
    alg,
    parseJsonField(cfg.jwtHeaders, "JWT headers"),
    parseJsonField(cfg.payload, "Payload"),
    {
      secret: cfg.secret
        ? Buffer.from(cfg.secret, cfg.secretBase64Encoded ? "base64" : "utf8")
        : undefined,
      privateKey: cfg.privateKey,
    },
  );
  if (cfg.addTokenTo === "query") {
    ctx.url.searchParams.set(cfg.queryParamKey?.trim() || "token", token);
    return;
  }
  const prefix = cfg.headerPrefix?.trim() ?? "Bearer";
  ctx.headers.set("Authorization", prefix ? `${prefix} ${token}` : token);
}

function applyAsap(cfg: AsapAuthConfig, ctx: AuthApplyContext): void {
  const alg = cfg.algorithm ?? "RS256";
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiry = Number(cfg.expirySeconds ?? "") || 3600;
  const audience = (cfg.audience ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const payload: Record<string, unknown> = {
    iss: cfg.issuer ?? "",
    sub: cfg.subject?.trim() || (cfg.issuer ?? ""),
    aud: audience.length > 1 ? audience : (audience[0] ?? ""),
    iat: issuedAt,
    exp: issuedAt + expiry,
    jti: cfg.tokenId?.trim() || randomHex(16),
    ...parseJsonField(cfg.additionalClaims, "Additional Claims"),
  };
  const token = signJwt(
    alg,
    cfg.kid ? { kid: cfg.kid } : {},
    payload,
    { privateKey: cfg.privateKey },
  );
  ctx.headers.set("Authorization", `Bearer ${token}`);
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** Digest algorithm -> node 摘要算法 */
function digestHashName(algorithm: string): string {
  const base = algorithm.replace(/-sess$/, "").toUpperCase();
  switch (base) {
    case "MD5":
      return "md5";
    case "SHA-256":
      return "sha256";
    case "SHA-512-256":
      return "sha512-256";
    default:
      throw new Error(`不支持的 Digest 算法：${algorithm}`);
  }
}

/** 解析 WWW-Authenticate: Digest realm="x", nonce="y", ... */
export function parseDigestChallenge(header: string): Record<string, string> | null {
  const match = /^\s*Digest\s+(.*)$/is.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of match[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim().replace(/^"|"$/g, "");
    params[key] = value;
  }
  return params;
}

function applyDigest(
  cfg: DigestAuthConfig,
  ctx: AuthApplyContext,
): AuthApplyResult | void {
  const challenge = ctx.digestChallenge ?? {};
  const realm = cfg.realm?.trim() || challenge.realm;
  const nonce = cfg.nonce?.trim() || challenge.nonce;
  // realm/nonce 都拿不到时，先让调用方发一次请求取 401 挑战
  if (!realm || !nonce) return { needsDigestChallenge: true };

  const algorithm = cfg.algorithm ?? (challenge.algorithm as DigestAuthConfig["algorithm"]) ?? "MD5";
  const hashName = digestHashName(algorithm);
  const H = (s: string) => crypto.createHash(hashName).update(s).digest("hex");

  const username = cfg.username ?? "";
  const password = cfg.password ?? "";
  const uri = `${ctx.url.pathname}${ctx.url.search}`;
  const cnonce = cfg.clientNonce?.trim() || randomHex(8);
  const nc = cfg.nonceCount?.trim() || "00000001";
  const opaque = cfg.opaque?.trim() || challenge.opaque;
  // qop 优先取用户配置，其次取挑战里声明的第一个
  const qop =
    cfg.qop ??
    (challenge.qop?.split(",").map((q) => q.trim())[0] as DigestAuthConfig["qop"]) ??
    "";

  let ha1 = H(`${username}:${realm}:${password}`);
  if (algorithm.endsWith("-sess")) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 =
    qop === "auth-int"
      ? H(`${ctx.method}:${uri}:${H(ctx.body?.toString("utf8") ?? "")}`)
      : H(`${ctx.method}:${uri}`);
  const response = qop
    ? H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  ctx.headers.set("Authorization", `Digest ${parts.join(", ")}`);
}

// ---------------------------------------------------------------------------
// OAuth 1.0
// ---------------------------------------------------------------------------

/** RFC 5849 要求的百分号编码 */
function pct(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function applyOAuth1(cfg: OAuth1AuthConfig, ctx: AuthApplyContext): void {
  const method = cfg.signatureMethod ?? "HMAC-SHA1";
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey ?? "",
    oauth_nonce: cfg.nonce?.trim() || randomHex(8),
    oauth_signature_method: method,
    oauth_timestamp: cfg.timestamp?.trim() || String(Math.floor(Date.now() / 1000)),
    oauth_version: cfg.version?.trim() || "1.0",
  };
  if (cfg.accessToken) oauthParams.oauth_token = cfg.accessToken;
  if (cfg.callbackUrl) oauthParams.oauth_callback = cfg.callbackUrl;
  if (cfg.verifier) oauthParams.oauth_verifier = cfg.verifier;
  if (cfg.includeBodyHash && ctx.body) {
    oauthParams.oauth_body_hash = crypto
      .createHash("sha1")
      .update(ctx.body)
      .digest("base64");
  }

  // 签名基串参数：query 参数 + urlencoded body 参数 + oauth_*
  const collected: [string, string][] = [];
  ctx.url.searchParams.forEach((value, key) => collected.push([key, value]));
  const contentType = ctx.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") && ctx.body) {
    new URLSearchParams(ctx.body.toString("utf8")).forEach((value, key) =>
      collected.push([key, value]),
    );
  }
  for (const [key, value] of Object.entries(oauthParams)) collected.push([key, value]);

  const normalized = collected
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${ctx.url.protocol}//${ctx.url.host}${ctx.url.pathname}`;
  const baseString = `${ctx.method.toUpperCase()}&${pct(baseUrl)}&${pct(normalized)}`;
  const signingKey = `${pct(cfg.consumerSecret ?? "")}&${pct(cfg.tokenSecret ?? "")}`;

  let signature: string;
  switch (method) {
    case "PLAINTEXT":
      signature = signingKey;
      break;
    case "HMAC-SHA1":
      signature = hmac("sha1", signingKey, baseString).toString("base64");
      break;
    case "HMAC-SHA256":
      signature = hmac("sha256", signingKey, baseString).toString("base64");
      break;
    case "HMAC-SHA512":
      signature = hmac("sha512", signingKey, baseString).toString("base64");
      break;
    case "RSA-SHA1":
    case "RSA-SHA256": {
      if (!cfg.privateKey?.trim()) throw new Error(`${method} 需要填写 Private Key`);
      const digest = method === "RSA-SHA1" ? "sha1" : "sha256";
      signature = crypto
        .sign(digest, Buffer.from(baseString), cfg.privateKey)
        .toString("base64");
      break;
    }
    default:
      throw new Error(`不支持的 OAuth 1.0 签名方式：${String(method)}`);
  }
  oauthParams.oauth_signature = signature;

  if (cfg.addParamsTo === "query") {
    for (const [key, value] of Object.entries(oauthParams)) {
      ctx.url.searchParams.set(key, value);
    }
    return;
  }
  const header = Object.entries(oauthParams)
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ");
  ctx.headers.set(
    "Authorization",
    `OAuth ${cfg.realm ? `realm="${pct(cfg.realm)}", ` : ""}${header}`,
  );
}

// ---------------------------------------------------------------------------
// OAuth 2.0（仅携带已有 token）
// ---------------------------------------------------------------------------

function applyOAuth2(cfg: OAuth2AuthConfig, ctx: AuthApplyContext): void {
  const token = cfg.accessToken?.trim();
  if (!token) {
    throw new Error(
      "OAuth 2.0：Access Token 为空。当前不支持自动走授权流程换取 Token，请先填入 Access Token。",
    );
  }
  if (cfg.addTokenTo === "query") {
    ctx.url.searchParams.set("access_token", token);
    return;
  }
  const prefix = cfg.headerPrefix?.trim() ?? "Bearer";
  ctx.headers.set("Authorization", prefix ? `${prefix} ${token}` : token);
}

// ---------------------------------------------------------------------------
// Hawk
// ---------------------------------------------------------------------------

function applyHawk(cfg: HawkAuthConfig, ctx: AuthApplyContext): void {
  const algorithm = cfg.algorithm ?? "sha256";
  const ts = cfg.timestamp?.trim() || String(Math.floor(Date.now() / 1000));
  const nonce = cfg.nonce?.trim() || randomHex(3);
  const ext = cfg.extraData ?? "";
  const port = ctx.url.port || (ctx.url.protocol === "https:" ? "443" : "80");

  let payloadHash = "";
  if (cfg.includePayloadHash && ctx.body) {
    const contentType = (ctx.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    payloadHash = crypto
      .createHash(algorithm)
      .update(`hawk.1.payload\n${contentType}\n${ctx.body.toString("utf8")}\n`)
      .digest("base64");
  }

  let normalized =
    `hawk.1.header\n${ts}\n${nonce}\n${ctx.method.toUpperCase()}\n` +
    `${ctx.url.pathname}${ctx.url.search}\n${ctx.url.hostname.toLowerCase()}\n${port}\n` +
    `${payloadHash}\n${ext}\n`;
  if (cfg.app) normalized += `${cfg.app}\n${cfg.dlg ?? ""}\n`;

  const mac = hmac(algorithm, cfg.authKey ?? "", normalized).toString("base64");
  const parts = [`id="${cfg.authId ?? ""}"`, `ts="${ts}"`, `nonce="${nonce}"`];
  if (payloadHash) parts.push(`hash="${payloadHash}"`);
  if (ext) parts.push(`ext="${ext}"`);
  parts.push(`mac="${mac}"`);
  if (cfg.app) parts.push(`app="${cfg.app}"`);
  if (cfg.dlg) parts.push(`dlg="${cfg.dlg}"`);
  ctx.headers.set("Authorization", `Hawk ${parts.join(", ")}`);
}

// ---------------------------------------------------------------------------
// AWS Signature V4
// ---------------------------------------------------------------------------

function canonicalQuery(url: URL): string {
  const entries: [string, string][] = [];
  url.searchParams.forEach((value, key) => entries.push([key, value]));
  return entries
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function applyAwsSigV4(cfg: AwsSigV4AuthConfig, ctx: AuthApplyContext): void {
  const accessKey = cfg.accessKey?.trim();
  const secretKey = cfg.secretKey ?? "";
  if (!accessKey) throw new Error("AWS Signature：Access Key 不能为空");
  const region = cfg.region?.trim() || "us-east-1";
  const service = cfg.service?.trim();
  if (!service) throw new Error("AWS Signature：Service Name 不能为空");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); // yyyyMMddTHHmmssZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = sha256Hex(ctx.body ?? "");
  const host = ctx.url.host;
  const presign = cfg.addAuthDataTo === "query";

  if (presign) {
    ctx.url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    ctx.url.searchParams.set("X-Amz-Credential", `${accessKey}/${scope}`);
    ctx.url.searchParams.set("X-Amz-Date", amzDate);
    ctx.url.searchParams.set("X-Amz-SignedHeaders", "host");
    if (cfg.sessionToken) {
      ctx.url.searchParams.set("X-Amz-Security-Token", cfg.sessionToken);
    }
  } else {
    ctx.headers.set("X-Amz-Date", amzDate);
    if (cfg.sessionToken) ctx.headers.set("X-Amz-Security-Token", cfg.sessionToken);
  }

  // 参与签名的头：host + x-amz-date + x-amz-security-token + content-type
  const signed: [string, string][] = [["host", host]];
  if (!presign) {
    signed.push(["x-amz-date", amzDate]);
    if (cfg.sessionToken) signed.push(["x-amz-security-token", cfg.sessionToken]);
    const contentType = ctx.headers.get("content-type");
    if (contentType) signed.push(["content-type", contentType]);
  }
  signed.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHeaders = signed.map(([k]) => k).join(";");
  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v.trim()}\n`).join("");

  const canonicalRequest = [
    ctx.method.toUpperCase(),
    ctx.url.pathname || "/",
    canonicalQuery(ctx.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("sha256", `AWS4${secretKey}`, dateStamp);
  const kRegion = hmac("sha256", kDate, region);
  const kService = hmac("sha256", kRegion, service);
  const kSigning = hmac("sha256", kService, "aws4_request");
  const signature = hmac("sha256", kSigning, stringToSign).toString("hex");

  if (presign) {
    ctx.url.searchParams.set("X-Amz-Signature", signature);
    return;
  }
  ctx.headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
}

// ---------------------------------------------------------------------------
// Akamai EdgeGrid（EG1-HMAC-SHA256）
// ---------------------------------------------------------------------------

/** EdgeGrid 时间戳格式：yyyyMMddTHH:mm:ss+0000 */
function edgeGridTimestamp(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 19)}+0000`;
}

function applyEdgeGrid(cfg: EdgeGridAuthConfig, ctx: AuthApplyContext): void {
  const timestamp = cfg.timestamp?.trim() || edgeGridTimestamp();
  const nonce = cfg.nonce?.trim() || crypto.randomUUID();
  const authPrefix =
    `EG1-HMAC-SHA256 client_token=${cfg.clientToken ?? ""};` +
    `access_token=${cfg.accessToken ?? ""};timestamp=${timestamp};nonce=${nonce};`;

  const canonicalHeaders = (cfg.headersToSign ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const value = ctx.headers.get(name) ?? "";
      return `${name.toLowerCase()}:${value.trim().replace(/\s+/g, " ")}\t`;
    })
    .join("");

  // 仅 POST/PUT 的请求体参与内容哈希
  const method = ctx.method.toUpperCase();
  const contentHash =
    (method === "POST" || method === "PUT") && ctx.body
      ? crypto.createHash("sha256").update(ctx.body).digest("base64")
      : "";

  const dataToSign = [
    method,
    ctx.url.protocol.replace(":", ""),
    ctx.url.host,
    `${ctx.url.pathname}${ctx.url.search}`,
    canonicalHeaders,
    contentHash,
    authPrefix,
  ].join("\t");

  const signingKey = hmac("sha256", cfg.clientSecret ?? "", timestamp).toString("base64");
  const signature = hmac("sha256", signingKey, dataToSign).toString("base64");
  ctx.headers.set("Authorization", `${authPrefix}signature=${signature}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 按 auth 配置改写 ctx.headers / ctx.url；返回是否需要 Digest 挑战重试 */
export function applyAuth(auth: RequestAuth, ctx: AuthApplyContext): AuthApplyResult {
  switch (auth.type) {
    case "none":
      return {};

    case "basic": {
      const { username = "", password = "" } = auth.basic ?? {};
      const raw = Buffer.from(`${username}:${password}`).toString("base64");
      ctx.headers.set("Authorization", `Basic ${raw}`);
      return {};
    }

    case "bearer": {
      const token = auth.bearer?.token ?? "";
      ctx.headers.set("Authorization", `Bearer ${token}`);
      return {};
    }

    case "api-key": {
      const { key, value = "", in: target = "header" } = auth.apiKey ?? {};
      if (!key) throw new Error("API Key：Key 不能为空");
      if (target === "query") ctx.url.searchParams.set(key, value);
      else ctx.headers.set(key, value);
      return {};
    }

    case "jwt":
      applyJwt(auth.jwt ?? {}, ctx);
      return {};

    case "digest":
      return applyDigest(auth.digest ?? {}, ctx) ?? {};

    case "oauth1":
      applyOAuth1(auth.oauth1 ?? {}, ctx);
      return {};

    case "oauth2":
      applyOAuth2(auth.oauth2 ?? {}, ctx);
      return {};

    case "hawk":
      applyHawk(auth.hawk ?? {}, ctx);
      return {};

    case "aws-sigv4":
      applyAwsSigV4(auth.awsSigv4 ?? {}, ctx);
      return {};

    case "edgegrid":
      applyEdgeGrid(auth.edgegrid ?? {}, ctx);
      return {};

    case "asap":
      applyAsap(auth.asap ?? {}, ctx);
      return {};

    case "ntlm":
      throw new Error(
        "NTLM Authentication 需要多轮 NTLM 握手（且要求连接复用），服务端执行器暂未实现；请改用其他认证方式。",
      );

    default: {
      // 穷举兜底：新增类型时编译期即可发现
      const exhaustive: never = auth.type;
      throw new Error(`不支持的认证类型：${String(exhaustive)}`);
    }
  }
}

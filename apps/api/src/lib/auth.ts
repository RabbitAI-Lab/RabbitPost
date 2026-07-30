import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import type { User } from "@rabbitpost/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { casdoorConfig, env, isCasdoorConfigured } from "../env";

const SESSION_COOKIE = "rp_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7d

// ---------------------------------------------------------------------------
// Casdoor OIDC
// ---------------------------------------------------------------------------

/** 构造 Casdoor 授权地址；前端拿到后整页跳转 */
export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  const cfg = casdoorConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "profile",
    state,
  });
  return `${cfg.endpoint}/login/oauth/authorize?${params.toString()}`;
}

interface CasdoorTokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface CasdoorIdTokenPayload extends jwt.JwtPayload {
  /** Casdoor 用户名 */
  name?: string;
  preferred_username?: string;
  displayName?: string;
  email?: string;
  picture?: string;
  avatar?: string;
}

/** 用授权码换取 token，并验签 id_token，返回用户信息 */
export async function exchangeCodeForUser(
  code: string,
  redirectUri: string,
): Promise<{ casdoorId: string; name: string; email: string | null; avatarUrl: string | null }> {
  const cfg = casdoorConfig();

  const resp = await fetch(`${cfg.endpoint}/api/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  // Casdoor 返回的错误原样透传，便于排查配置问题
  const text = await resp.text();
  let token: CasdoorTokenResponse;
  try {
    token = JSON.parse(text) as CasdoorTokenResponse;
  } catch {
    throw new Error(`Casdoor token endpoint returned non-JSON (${resp.status}): ${text}`);
  }
  if (!resp.ok || token.error) {
    throw new Error(
      `Casdoor token exchange failed (${resp.status}): ${
        token.error_description ?? token.error ?? text
      }`,
    );
  }
  if (!token.id_token) {
    throw new Error(`Casdoor token response missing id_token: ${text}`);
  }

  const payload = jwt.verify(token.id_token, cfg.cert, {
    algorithms: ["RS256"],
    // 容忍 Casdoor 服务器与本机的时钟偏差（nbf/exp 校验同时放宽）
    clockTolerance: 60,
  }) as CasdoorIdTokenPayload;

  // Casdoor 未填 displayName 的用户返回空字符串，需用 || 兜底跳过空值
  const casdoorId = payload.sub || payload.name;
  const name =
    payload.displayName || payload.name || payload.preferred_username || payload.email;
  if (!casdoorId || !name) {
    throw new Error(`Casdoor id_token missing identity claims: ${JSON.stringify(payload)}`);
  }
  return {
    casdoorId,
    name,
    email: payload.email || null,
    avatarUrl: payload.picture || payload.avatar || null,
  };
}

/** 登录成功后 upsert 本地用户 */
export async function upsertUser(profile: {
  casdoorId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}): Promise<User> {
  const [row] = await db
    .insert(users)
    .values(profile)
    .onConflictDoUpdate({
      target: users.casdoorId,
      set: { name: profile.name, email: profile.email, avatarUrl: profile.avatarUrl },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert user");
  return toUser(row);
}

// ---------------------------------------------------------------------------
// App session (httpOnly cookie, JWT)
// ---------------------------------------------------------------------------

export async function createSession(userId: string): Promise<void> {
  const token = jwt.sign({ uid: userId }, env.APP_SESSION_SECRET, {
    expiresIn: SESSION_MAX_AGE_SECONDS,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

type UserRow = typeof users.$inferSelect;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    casdoorId: row.casdoorId,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 读取当前会话用户；未登录返回 null */
export async function getSessionUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.APP_SESSION_SECRET) as jwt.JwtPayload;
    const uid = payload.uid as string | undefined;
    if (!uid) return null;
    const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    return row ? toUser(row) : null;
  } catch {
    return null;
  }
}

export { isCasdoorConfigured };

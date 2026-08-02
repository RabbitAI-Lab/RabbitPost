/**
 * 路由测试公用助手：
 * - seedBasic：一条最小完整数据链（team/user(owner)/workspace/collection/request item）
 *   与一对凭证（API Key 明文 + Runner Token 明文，库里均只存 sha256）
 * - authed：构造带 Bearer 的 Request 直接喂给 route handler（handleRoute 双凭证中的 API Key 路径）
 */
import crypto from "node:crypto";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { db } from "../src/db";
import {
  apiKeys,
  collectionItems,
  collections,
  runners,
  teamMembers,
  teams,
  users,
  workspaces,
} from "../src/db/schema";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface Seed {
  userId: string;
  teamId: string;
  workspaceId: string;
  collectionId: string;
  /** type === "request" 的条目，request 配置为 GET {{baseUrl}}/health */
  itemId: string;
  apiToken: string;
  runnerToken: string;
}

export async function seedBasic(): Promise<Seed> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [user] = await db
    .insert(users)
    .values({ casdoorId: `test-${suffix}`, name: "Test User" })
    .returning();
  const [team] = await db
    .insert(teams)
    .values({ name: "Test Team", slug: `test-team-${suffix}`, createdBy: user.id })
    .returning();
  await db
    .insert(teamMembers)
    .values({ teamId: team.id, userId: user.id, role: "owner" });
  const [workspace] = await db
    .insert(workspaces)
    .values({ teamId: team.id, name: "Test WS", createdBy: user.id })
    .returning();
  const [collection] = await db
    .insert(collections)
    .values({ workspaceId: workspace.id, name: "Test Col" })
    .returning();
  const [item] = await db
    .insert(collectionItems)
    .values({
      collectionId: collection.id,
      type: "request",
      name: "Health Check",
      request: {
        ...createEmptyRequestConfig(),
        url: "{{baseUrl}}/health",
      },
    })
    .returning();

  const apiToken = `rpk_test_${crypto.randomBytes(16).toString("hex")}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: "test-key",
    keyHash: sha256(apiToken),
    keyPrefix: apiToken.slice(0, 12),
  });
  const runnerToken = `rpr_test_${crypto.randomBytes(16).toString("hex")}`;
  await db.insert(runners).values({
    teamId: team.id,
    name: "test-runner",
    tokenHash: sha256(runnerToken),
    tokenPrefix: runnerToken.slice(0, 12),
    createdBy: user.id,
  });

  return {
    userId: user.id,
    teamId: team.id,
    workspaceId: workspace.id,
    collectionId: collection.id,
    itemId: item.id,
    apiToken,
    runnerToken,
  };
}

/** 在指定团队下创建一条 __embedded__ runner 记录，返回其 id */
export async function seedEmbeddedRunner(teamId: string, createdBy: string): Promise<string> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const token = `rpr_emb_${suffix}`;
  const [row] = await db
    .insert(runners)
    .values({
      teamId,
      name: "__embedded__",
      tokenHash: sha256(token),
      tokenPrefix: token.slice(0, 12),
      createdBy,
      // 模拟在线心跳，使 isRunnerOnline 判定为 true
      lastSeenAt: new Date(),
    })
    .returning();
  return row.id;
}

/** 另一个团队的孤立用户（用于 403 越权用例） */
export async function seedOutsiderToken(): Promise<string> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [user] = await db
    .insert(users)
    .values({ casdoorId: `outsider-${suffix}`, name: "Outsider" })
    .returning();
  const token = `rpk_out_${crypto.randomBytes(16).toString("hex")}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: "outsider-key",
    keyHash: sha256(token),
    keyPrefix: token.slice(0, 12),
  });
  return token;
}

/** 构造带 Bearer 的 Request；json 自动序列化并补 Content-Type */
export function authed(
  path: string,
  token: string | null,
  init?: { method?: string; json?: unknown },
): Request {
  return new Request(`http://test.local${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

/** 读响应 envelope；api 错误时连同状态码抛出便于断言 */
export async function envelope<T = unknown>(
  resp: Response,
): Promise<{ status: number; ok: boolean; data: T; error?: { code: string; message: string } }> {
  const body = (await resp.json()) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
  };
  return {
    status: resp.status,
    ok: body.ok,
    data: body.data as T,
    error: body.error,
  };
}

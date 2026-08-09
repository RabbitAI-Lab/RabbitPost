/**
 * db-connections 路由测试：
 * - POST 创建 / GET 列表 / PATCH 更新（密码语义）/ DELETE 删除
 * - 密码密文（passwordEnc 与 envOverrides.password）一律不回传，以 hasPassword 指示
 * - POST /:id/test 对 sqlite 临时库做真实连通性测试
 * - 未认证 401
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as listConnections, POST as createConnection } from "../src/app/api/v1/db-connections/route";
import {
  DELETE as deleteConnection,
  PATCH as patchConnection,
} from "../src/app/api/v1/db-connections/[id]/route";
import { POST as testConnection } from "../src/app/api/v1/db-connections/[id]/test/route";
import { authed, envelope, seedBasic } from "./helpers";

// 与 execute-history.test.ts 一致：测试环境无 cookie 上下文，会话路径固定返回 null
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const sqliteFile = path.join(
  os.tmpdir(),
  `rp-routetest-${crypto.randomBytes(6).toString("hex")}.db`,
);

beforeAll(() => {
  process.env.DB_SECRET_KEY = crypto.randomBytes(32).toString("base64");
});

afterAll(() => {
  fs.rmSync(sqliteFile, { force: true });
});

type ConnectionDto = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  hasPassword: boolean;
  envOverrides: Record<string, Record<string, unknown>> | null;
};

async function createSqlite(token: string, workspaceId: string): Promise<ConnectionDto> {
  const resp = await createConnection(
    authed("/api/v1/db-connections", token, {
      method: "POST",
      json: {
        workspaceId,
        name: "orders",
        type: "sqlite",
        config: { type: "sqlite", filepath: sqliteFile },
        password: "super-secret",
        envOverrides: {
          "env-1": { host: "other-host", password: "env-secret" },
        },
      },
    }),
    {},
  );
  const res = await envelope<ConnectionDto>(resp);
  expect(res.status).toBe(201);
  return res.data;
}

describe("db-connections 路由", () => {
  it("创建后列表返回，但密码密文与 envOverrides 密码不回传", async () => {
    const s = await seedBasic();
    const created = await createSqlite(s.apiToken, s.workspaceId);
    expect(created.name).toBe("orders");
    expect(created.hasPassword).toBe(true);
    expect(created).not.toHaveProperty("passwordEnc");
    expect(created).not.toHaveProperty("password");
    // envOverrides：明文/密文密码都不回传，以 hasPassword 指示
    expect(created.envOverrides?.["env-1"]).toMatchObject({
      host: "other-host",
      hasPassword: true,
    });
    expect(created.envOverrides?.["env-1"]).not.toHaveProperty("password");

    const listResp = await listConnections(
      authed(`/api/v1/db-connections?workspaceId=${s.workspaceId}`, s.apiToken),
      {},
    );
    const list = await envelope<ConnectionDto[]>(listResp);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.id).toBe(created.id);
    expect(JSON.stringify(list.data)).not.toContain("super-secret");
    expect(JSON.stringify(list.data)).not.toContain("env-secret");
  });

  it("PATCH：缺省保留密码，非空重新加密，空字符串清除", async () => {
    const s = await seedBasic();
    const created = await createSqlite(s.apiToken, s.workspaceId);
    const ctx = { params: Promise.resolve({ id: created.id }) };

    // 不改密码：hasPassword 仍为 true
    let resp = await patchConnection(
      authed(`/api/v1/db-connections/${created.id}`, s.apiToken, {
        method: "PATCH",
        json: { name: "orders2" },
      }),
      ctx,
    );
    let res = await envelope<ConnectionDto>(resp);
    expect(res.data.name).toBe("orders2");
    expect(res.data.hasPassword).toBe(true);

    // 清除密码（空字符串）
    resp = await patchConnection(
      authed(`/api/v1/db-connections/${created.id}`, s.apiToken, {
        method: "PATCH",
        json: { password: "" },
      }),
      ctx,
    );
    res = await envelope<ConnectionDto>(resp);
    expect(res.data.hasPassword).toBe(false);

    // 重新设置
    resp = await patchConnection(
      authed(`/api/v1/db-connections/${created.id}`, s.apiToken, {
        method: "PATCH",
        json: { password: "new-secret" },
      }),
      ctx,
    );
    res = await envelope<ConnectionDto>(resp);
    expect(res.data.hasPassword).toBe(true);
    expect(JSON.stringify(res.data)).not.toContain("new-secret");
  });

  it("PATCH envOverrides：整体替换，password 缺省时保留已有密文", async () => {
    const s = await seedBasic();
    const created = await createSqlite(s.apiToken, s.workspaceId);
    const ctx = { params: Promise.resolve({ id: created.id }) };

    // env-1 不提供 password → 保留；env-2 明文 password → 加密存储
    const resp = await patchConnection(
      authed(`/api/v1/db-connections/${created.id}`, s.apiToken, {
        method: "PATCH",
        json: {
          envOverrides: {
            "env-1": { host: "kept-host" },
            "env-2": { database: "other", password: "p2" },
          },
        },
      }),
      ctx,
    );
    const res = await envelope<ConnectionDto>(resp);
    expect(res.data.envOverrides?.["env-1"]).toMatchObject({
      host: "kept-host",
      hasPassword: true, // 原 env-secret 被保留
    });
    expect(res.data.envOverrides?.["env-2"]).toMatchObject({
      database: "other",
      hasPassword: true,
    });
    expect(JSON.stringify(res.data)).not.toContain("p2");
  });

  it("POST /:id/test：sqlite 连通性测试成功", async () => {
    const s = await seedBasic();
    const created = await createSqlite(s.apiToken, s.workspaceId);
    const resp = await testConnection(
      authed(`/api/v1/db-connections/${created.id}/test`, s.apiToken, {
        method: "POST",
        json: {},
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const res = await envelope<{ success: boolean; latencyMs?: number; error?: string }>(resp);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("POST /:id/test：连接失败返回 success:false（200 + error 原文）", async () => {
    const s = await seedBasic();
    // 指向一个必然连不上的 postgres
    const resp = await createConnection(
      authed("/api/v1/db-connections", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          name: "dead-pg",
          type: "postgres",
          config: {
            type: "postgres",
            host: "127.0.0.1",
            port: 59999,
            database: "x",
            connectTimeoutMs: 500,
          },
        },
      }),
      {},
    );
    const created = (await envelope<ConnectionDto>(resp)).data;
    const testResp = await testConnection(
      authed(`/api/v1/db-connections/${created.id}/test`, s.apiToken, {
        method: "POST",
        json: {},
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    const res = await envelope<{ success: boolean; error?: string }>(testResp);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(false);
    expect(res.data.error).toBeTruthy();
  });

  it("DELETE 删除后列表为空；未认证 401", async () => {
    const s = await seedBasic();
    const created = await createSqlite(s.apiToken, s.workspaceId);
    const resp = await deleteConnection(
      authed(`/api/v1/db-connections/${created.id}`, s.apiToken, { method: "DELETE" }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect((await envelope(resp)).data).toEqual({ deleted: true });

    const list = await envelope<ConnectionDto[]>(
      await listConnections(
        authed(`/api/v1/db-connections?workspaceId=${s.workspaceId}`, s.apiToken),
        {},
      ),
    );
    expect(list.data).toHaveLength(0);

    const unauth = await listConnections(
      authed(`/api/v1/db-connections?workspaceId=${s.workspaceId}`, null),
      {},
    );
    expect(unauth.status).toBe(401);
  });
});

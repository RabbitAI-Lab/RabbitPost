/**
 * Workspace 全局变量（globals）在执行链路中的行为：
 *   1. globals 参与 url / params / headers / body 的 {{var}} 替换
 *   2. 优先级：globals < collection variables < environment（同名高优先级覆盖）
 *   3. pre-request 脚本内 rp.globals.get 可读、rp.globals.set 当次生效但不持久化
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import type { KeyValueItem } from "@rabbitpost/shared";
import { db } from "../src/db";
import { collections, environments, workspaces } from "../src/db/schema";
import { executeRequest } from "../src/lib/executor";
import { seedBasic } from "./helpers";

const kv = (key: string, value: string): KeyValueItem => ({
  id: key,
  key,
  value,
  enabled: true,
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // echo 服务器：回显请求路径 / 请求头 / 请求体，便于断言替换结果
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function setWorkspaceGlobals(workspaceId: string, variables: KeyValueItem[]) {
  await db.update(workspaces).set({ variables }).where(eq(workspaces.id, workspaceId));
}

describe("execute 全局变量（globals）", () => {
  it("globals 参与 url / params / headers / body 替换", async () => {
    const s = await seedBasic();
    await setWorkspaceGlobals(s.workspaceId, [
      kv("host", baseUrl),
      kv("token", "global-token"),
      kv("q", "hello"),
    ]);

    const result = await executeRequest(
      {
        workspaceId: s.workspaceId,
        name: "globals substitution",
        request: {
          ...createEmptyRequestConfig(),
          method: "POST",
          url: "{{host}}/echo",
          params: [kv("q", "{{q}}")],
          headers: [kv("x-token", "{{token}}")],
          body: { type: "raw", raw: '{"token":"{{token}}"}' },
        },
      },
      s.userId,
    );

    expect(result.ok).toBe(true);
    const echo = JSON.parse(result.bodyText!) as {
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(echo.url).toBe("/echo?q=hello");
    expect(echo.headers["x-token"]).toBe("global-token");
    expect(echo.body).toBe('{"token":"global-token"}');
  });

  it("优先级：collection 覆盖 globals，environment 覆盖 collection", async () => {
    const s = await seedBasic();
    await setWorkspaceGlobals(s.workspaceId, [kv("host", baseUrl), kv("prio", "from-global")]);
    await db
      .update(collections)
      .set({ variables: [kv("prio", "from-collection")] })
      .where(eq(collections.id, s.collectionId));

    const run = (environmentId?: string) =>
      executeRequest(
        {
          workspaceId: s.workspaceId,
          environmentId,
          itemId: s.itemId,
          name: "priority",
          request: {
            ...createEmptyRequestConfig(),
            url: "{{host}}/prio",
            headers: [kv("x-prio", "{{prio}}")],
          },
        },
        s.userId,
      );

    // 无环境：collection 覆盖 globals
    const noEnv = await run();
    expect(noEnv.ok).toBe(true);
    expect(
      (JSON.parse(noEnv.bodyText!) as { headers: Record<string, string> }).headers["x-prio"],
    ).toBe("from-collection");

    // 有环境：environment 覆盖 collection 与 globals
    const [env] = await db
      .insert(environments)
      .values({
        workspaceId: s.workspaceId,
        name: "Test Env",
        variables: [kv("prio", "from-env")],
      })
      .returning();
    const withEnv = await run(env!.id);
    expect(withEnv.ok).toBe(true);
    expect(
      (JSON.parse(withEnv.bodyText!) as { headers: Record<string, string> }).headers["x-prio"],
    ).toBe("from-env");
  });

  it("pre-request 脚本可 rp.globals.get；rp.globals.set 当次生效但不持久化", async () => {
    const s = await seedBasic();
    await setWorkspaceGlobals(s.workspaceId, [kv("host", baseUrl), kv("greeting", "hi")]);

    const result = await executeRequest(
      {
        workspaceId: s.workspaceId,
        name: "globals in script",
        request: {
          ...createEmptyRequestConfig(),
          url: "{{host}}/script",
          scripts: {
            preRequest: `
              rp.request.headers["x-greeting"] = rp.globals.get("greeting");
              rp.globals.set("greeting", "changed");
              rp.globals.set("ephemeral", "yes");
            `,
            test: `
              rp.test("globals.set 当次生效", () => {
                rp.expect(rp.globals.get("greeting")).to.equal("changed");
              });
            `,
          },
        },
      },
      s.userId,
    );

    expect(result.ok).toBe(true);
    const echo = JSON.parse(result.bodyText!) as { headers: Record<string, string> };
    expect(echo.headers["x-greeting"]).toBe("hi");
    expect(result.testResults).toEqual([
      { name: "globals.set 当次生效", passed: true },
    ]);

    // 脚本的 globals 改动不落库
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
    expect(ws!.variables).toEqual([kv("host", baseUrl), kv("greeting", "hi")]);
  });
});

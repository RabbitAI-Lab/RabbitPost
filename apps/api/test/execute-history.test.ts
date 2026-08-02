/**
 * 回归：POST /api/v1/execute 在 Runner 路径下也必须写入 histories 表。
 *
 * 之前 Runner 路径（dispatchAndWait）只写 run_jobs / run_job_results，
 * 不写 histories 表，导致前端 History 面板 / Response History tab 看不到
 * 单请求 Send 的记录（embedded runner 默认启用，绝大部分请求走 Runner 路径）。
 *
 * 本文件 mock 掉 runner 选择与派发，隔离验证 histories 落库：
 *   1. 成功请求：histories 有 response 摘要、error 为 null
 *   2. 失败请求：histories 有 error 原文、response 为 null
 *   3. 回退路径（无 Runner）：executor.ts 自身已写 history，不重复
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteResult } from "@rabbitpost/shared";
import { db } from "../src/db";
import { histories } from "../src/db/schema";
import { POST as execute } from "../src/app/api/v1/execute/route";
import { authed, envelope, seedBasic } from "./helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

// Mock runner 选择：让 execute 路由走 Runner 路径而非回退到 executeRequest
vi.mock("../src/lib/embedded-runner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasAvailableRunner: async () => true,
}));

// Mock dispatchAndWait：返回模拟结果，不真正派发任务
const mockDispatchAndWait = vi.fn();
vi.mock("../src/lib/runner-dispatch", () => ({
  dispatchAndWait: (...args: unknown[]) => mockDispatchAndWait(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatchAndWait.mockReset();
});

describe("execute → histories 落库回归", () => {
  it("Runner 路径成功：histories 落一条带 response 摘要的记录", async () => {
    const s = await seedBasic();

    const fakeResult: ExecuteResult = {
      ok: true,
      status: 200,
      statusText: "OK",
      sizeBytes: 42,
      durationMs: 15,
      testResults: [],
      consoleLogs: [],
    };
    mockDispatchAndWait.mockResolvedValue(fakeResult);

    const resp = await execute(
      authed("/api/v1/execute", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          name: "My Request",
          request: {
            method: "GET",
            url: "http://x/health",
            params: [],
            headers: [],
            body: { type: "none" },
            auth: { type: "none" },
            scripts: {},
          },
        },
      }),
      {},
    );
    const result = await envelope(resp);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);

    // 回归核心：histories 表必须有一条记录
    const rows = await db
      .select()
      .from(histories)
      .where(eq(histories.workspaceId, s.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("My Request");
    // 完整响应数据落库（含 headers / bodyText / testResults 等）
    expect(rows[0]!.response).toMatchObject({
      status: 200,
      statusText: "OK",
      sizeBytes: 42,
      durationMs: 15,
    });
    expect(rows[0]!.response).toHaveProperty("testResults");
    expect(rows[0]!.response).toHaveProperty("consoleLogs");
    expect(rows[0]!.error).toBeNull();
  });

  it("Runner 路径失败：histories 也落库，error 原文保留", async () => {
    const s = await seedBasic();

    const fakeResult: ExecuteResult = {
      ok: false,
      error: "connect ECONNREFUSED 127.0.0.1:8443",
      durationMs: 3,
      testResults: [],
      consoleLogs: [],
    };
    mockDispatchAndWait.mockResolvedValue(fakeResult);

    const resp = await execute(
      authed("/api/v1/execute", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          name: "Bad Request",
          request: {
            method: "GET",
            url: "http://unreachable/health",
            params: [],
            headers: [],
            body: { type: "none" },
            auth: { type: "none" },
            scripts: {},
          },
        },
      }),
      {},
    );
    const result = await envelope(resp);
    expect(result.status).toBe(200);

    // 回归核心：失败请求也必须写 history（保留现场）
    const rows = await db
      .select()
      .from(histories)
      .where(eq(histories.workspaceId, s.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Bad Request");
    // 失败时 response 为 null，error 有值
    expect(rows[0]!.response).toBeNull();
    expect(rows[0]!.error).toBe("connect ECONNREFUSED 127.0.0.1:8443");
  });

  it("dispatchAndWait 被调用时传入了正确的 requestConfig 和 targetName", async () => {
    const s = await seedBasic();

    mockDispatchAndWait.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      sizeBytes: 1,
      durationMs: 1,
      testResults: [],
      consoleLogs: [],
    });

    await execute(
      authed("/api/v1/execute", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          name: "Named Request",
          itemId: s.itemId,
          request: {
            method: "POST",
            url: "http://x/api",
            params: [],
            headers: [],
            body: { type: "none" },
            auth: { type: "none" },
            scripts: {},
          },
        },
      }),
      {},
    );

    // 验证 dispatchAndWait 收到了正确的参数
    expect(mockDispatchAndWait).toHaveBeenCalledTimes(1);
    const callArg = mockDispatchAndWait.mock.calls[0]![0];
    expect(callArg.targetName).toBe("Named Request");
    expect(callArg.targetId).toBe(s.itemId);
    expect(callArg.requestConfig).toMatchObject({ method: "POST", url: "http://x/api" });
  });

  // ---------------------------------------------------------------------
  // 回归：histories 表必须存完整响应数据（headers/bodyText/cookies/testResults），
  // 否则前端打开历史 tab 时只能看到状态码和耗时，看不到响应体/响应头/断言结果。
  // ---------------------------------------------------------------------
  it("Runner 路径成功：完整响应数据（headers/bodyText/cookies/testResults）全部落库", async () => {
    const s = await seedBasic();

    const fakeResult: ExecuteResult = {
      ok: true,
      status: 200,
      statusText: "OK",
      sizeBytes: 128,
      durationMs: 42,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-123",
      },
      bodyText: "{\"ok\":true,\"data\":[]}",
      bodyBase64: false,
      cookies: [
        { name: "session", value: "abc123", domain: ".example.com", path: "/" },
      ],
      testResults: [
        { name: "status is 200", passed: true },
        { name: "body has data", passed: true },
      ],
      consoleLogs: [
        { level: "log", args: ["request sent"] },
        { level: "warn", args: ["deprecated header"] },
      ],
    };
    mockDispatchAndWait.mockResolvedValue(fakeResult);

    await execute(
      authed("/api/v1/execute", s.apiToken, {
        method: "POST",
        json: {
          workspaceId: s.workspaceId,
          name: "Full Response",
          request: {
            method: "GET",
            url: "http://x/api",
            params: [],
            headers: [],
            body: { type: "none" },
            auth: { type: "none" },
            scripts: {},
          },
        },
      }),
      {},
    );

    const rows = await db
      .select()
      .from(histories)
      .where(eq(histories.workspaceId, s.workspaceId));
    expect(rows).toHaveLength(1);
    const resp = rows[0]!.response!;
    // 回归核心：以下字段必须存在于 histories.response 中
    expect(resp.headers).toEqual({
      "content-type": "application/json",
      "x-request-id": "req-123",
    });
    expect(resp.bodyText).toBe("{\"ok\":true,\"data\":[]}");
    expect(resp.bodyBase64).toBe(false);
    expect(resp.cookies).toHaveLength(1);
    expect(resp.cookies![0]).toMatchObject({ name: "session", domain: ".example.com" });
    expect(resp.testResults).toHaveLength(2);
    expect(resp.testResults![0]!.passed).toBe(true);
    expect(resp.consoleLogs).toHaveLength(2);
    expect(resp.consoleLogs![1]!.level).toBe("warn");
  });
});

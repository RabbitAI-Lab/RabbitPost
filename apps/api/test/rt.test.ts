/**
 * 实时通道（rt）路由级测试：
 * session 创建 / 无 runner 503 / send 转发 / runner 事件推送到 SSE / 关闭清理。
 * 流式 downlink 用注入的 fake writer 代替真实 runner 连接。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// route handler 直接调用时 getSessionUser 走 mock（与其它路由测试一致）
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { runners } from "../src/db/schema";
import { POST as createSession } from "../src/app/api/v1/rt/sessions/route";
import { DELETE as deleteSession } from "../src/app/api/v1/rt/sessions/[id]/route";
import { POST as sendToSession } from "../src/app/api/v1/rt/sessions/[id]/send/route";
import { GET as sessionEvents } from "../src/app/api/v1/rt/sessions/[id]/events/route";
import { POST as postEvent } from "../src/app/api/v1/runner/rt/event/route";
import {
  registerRtLink,
  resetRtState,
  type RtCommand,
} from "../src/lib/rt";
import { authed, envelope, seedBasic } from "./helpers";

const sessionCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 注册一条 fake downlink，返回收到的指令序列与注销函数 */
function fakeLink(runnerId: string) {
  const commands: RtCommand[] = [];
  const unregister = registerRtLink(runnerId, true, (cmd) => {
    commands.push(cmd);
    return true;
  });
  return { commands, unregister };
}

async function seededRunnerId(teamId: string): Promise<string> {
  const [row] = await db.select().from(runners).where(eq(runners.teamId, teamId)).limit(1);
  if (!row) throw new Error("seeded runner not found");
  return row.id;
}

async function readSseLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const line = buf.split("\n").find((l) => l.startsWith("data: "));
    if (line) return line;
  }
  throw new Error(`no SSE data line received, buffer: ${buf}`);
}

beforeEach(() => {
  resetRtState();
});

describe("POST /api/v1/rt/sessions", () => {
  it("无活跃 rt link 的 runner 时返回 503 NO_RUNNER_AVAILABLE", async () => {
    const s = await seedBasic();
    const r = await envelope(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    expect(r.status).toBe(503);
    expect(r.error?.code).toBe("NO_RUNNER_AVAILABLE");
  });

  it("创建成功返回 sessionId，并向 runner 下发 start 指令", async () => {
    const s = await seedBasic();
    const link = fakeLink(await seededRunnerId(s.teamId));

    const r = await envelope<{ sessionId: string }>(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: {
            workspaceId: s.workspaceId,
            protocol: "websocket",
            url: "ws://localhost:9001/ws",
            config: { headers: [{ key: "X-Token", value: "abc", enabled: true }] },
          },
        }),
        {},
      ),
    );
    expect(r.status).toBe(200);
    expect(r.data.sessionId).toBeTruthy();
    expect(link.commands).toEqual([
      {
        cmd: "start",
        sessionId: r.data.sessionId,
        protocol: "websocket",
        url: "ws://localhost:9001/ws",
        config: { headers: [{ key: "X-Token", value: "abc", enabled: true }] },
      },
    ]);
  });

  it("无权访问 workspace 时返回 403/404", async () => {
    const s = await seedBasic();
    const outsider = await import("./helpers").then((h) => h.seedOutsiderToken());
    fakeLink(await seededRunnerId(s.teamId));
    const r = await envelope(
      await createSession(
        authed("/api/v1/rt/sessions", outsider, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    expect(r.status).toBe(403);
  });
});

describe("POST /api/v1/rt/sessions/:id/send", () => {
  it("经 downlink 转发 send 指令", async () => {
    const s = await seedBasic();
    const link = fakeLink(await seededRunnerId(s.teamId));
    const created = await envelope<{ sessionId: string }>(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    const id = created.data.sessionId;

    const r = await envelope(
      await sendToSession(
        authed(`/api/v1/rt/sessions/${id}/send`, s.apiToken, {
          method: "POST",
          json: { data: "aGVsbG8=", encoding: "base64" },
        }),
        sessionCtx(id),
      ),
    );
    expect(r.status).toBe(200);
    expect(link.commands.at(-1)).toEqual({
      cmd: "send",
      sessionId: id,
      data: "aGVsbG8=",
      encoding: "base64",
    });
  });

  it("session 不存在返回 404", async () => {
    const s = await seedBasic();
    const r = await envelope(
      await sendToSession(
        authed("/api/v1/rt/sessions/nonexistent/send", s.apiToken, {
          method: "POST",
          json: { data: "hi" },
        }),
        sessionCtx("nonexistent"),
      ),
    );
    expect(r.status).toBe(404);
  });
});

describe("runner 事件 → SSE", () => {
  it("POST /api/v1/runner/rt/event 写入该 session 的 SSE 队列", async () => {
    const s = await seedBasic();
    fakeLink(await seededRunnerId(s.teamId));
    const created = await envelope<{ sessionId: string }>(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    const id = created.data.sessionId;

    // 浏览器侧打开 SSE
    const sseResp = await sessionEvents(
      authed(`/api/v1/rt/sessions/${id}/events`, s.apiToken),
      sessionCtx(id),
    );
    expect(sseResp.status).toBe(200);
    expect(sseResp.headers.get("content-type")).toBe("text/event-stream");
    const reader = sseResp.body!.getReader();

    // runner 上报事件
    const r = await envelope(
      await postEvent(
        authed("/api/v1/runner/rt/event", s.runnerToken, {
          method: "POST",
          json: { sessionId: id, event: { t: "message", dir: "in", data: "hi", encoding: "text", ts: 1 } },
        }),
        {},
      ),
    );
    expect(r.status).toBe(200);

    // SSE 收到该事件，id 被盖章为 sessionId
    const line = await readSseLine(reader);
    expect(JSON.parse(line.slice("data: ".length))).toEqual({
      t: "message",
      id,
      dir: "in",
      data: "hi",
      encoding: "text",
      ts: 1,
    });
    await reader.cancel();
  });

  it("runner token 缺失时 event 路由返回 401", async () => {
    const r = await envelope(
      await postEvent(
        authed("/api/v1/runner/rt/event", null, {
          method: "POST",
          json: { sessionId: "x", event: { t: "error", message: "m" } },
        }),
        {},
      ),
    );
    expect(r.status).toBe(401);
  });
});

describe("DELETE /api/v1/rt/sessions/:id", () => {
  it("关闭 session：通知 runner 并清理，之后 send 返回 404", async () => {
    const s = await seedBasic();
    const link = fakeLink(await seededRunnerId(s.teamId));
    const created = await envelope<{ sessionId: string }>(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    const id = created.data.sessionId;

    const r = await envelope(
      await deleteSession(authed(`/api/v1/rt/sessions/${id}`, s.apiToken, { method: "DELETE" }), sessionCtx(id)),
    );
    expect(r.status).toBe(200);
    expect(link.commands.at(-1)).toEqual({ cmd: "close", sessionId: id });

    const after = await envelope(
      await sendToSession(
        authed(`/api/v1/rt/sessions/${id}/send`, s.apiToken, {
          method: "POST",
          json: { data: "hi" },
        }),
        sessionCtx(id),
      ),
    );
    expect(after.status).toBe(404);
  });

  it("runner downlink 断开后，该 runner 名下 session 被置为 error 并清理", async () => {
    const s = await seedBasic();
    const link = fakeLink(await seededRunnerId(s.teamId));
    const created = await envelope<{ sessionId: string }>(
      await createSession(
        authed("/api/v1/rt/sessions", s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, protocol: "websocket", url: "ws://localhost:9001" },
        }),
        {},
      ),
    );
    const id = created.data.sessionId;

    // SSE 订阅中：断链应收到 error 通知
    const sseResp = await sessionEvents(
      authed(`/api/v1/rt/sessions/${id}/events`, s.apiToken),
      sessionCtx(id),
    );
    const reader = sseResp.body!.getReader();

    link.unregister();

    const line = await readSseLine(reader);
    const msg = JSON.parse(line.slice("data: ".length)) as { t: string; id: string; state?: string };
    expect(msg.id).toBe(id);
    expect(msg.t === "error" || (msg.t === "status" && msg.state === "error")).toBe(true);

    // session 已被清理
    const after = await envelope(
      await sendToSession(
        authed(`/api/v1/rt/sessions/${id}/send`, s.apiToken, {
          method: "POST",
          json: { data: "hi" },
        }),
        sessionCtx(id),
      ),
    );
    expect(after.status).toBe(404);
    await reader.cancel();
  });
});

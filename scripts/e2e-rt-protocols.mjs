/**
 * 全协议全链路验收：浏览器路径（POST + SSE + 会话 cookie）→ api 实时桥 → runner → apps/mock-server。
 * 覆盖：websocket / socketio / mqtt / sse / graphql-subscription / mcp / grpc。
 *
 * 公共前提：mock-server 已启动（:3090 / :1883 / :50051）。
 * 前提（两种模式二选一）：
 *   A. api 桥模式：`pnpm dev`（api :4000 + 内嵌 runner rt link）+ mock-server，直接运行本脚本
 *   B. local-agent 直连模式（桌面端本地执行路径）：启动 `rabbitpost-runner local-agent --port 17360`，
 *      然后 `API_ORIGIN=http://127.0.0.1:17360 node scripts/e2e-rt-protocols.mjs`（无需会话 cookie）
 * 两种模式都应 ALL PROTOCOLS PASS。
 * 用法：node scripts/e2e-rt-protocols.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const API = process.env.API_ORIGIN ?? "http://localhost:4000";
const UID = process.env.RT_E2E_UID ?? "5c77656a-b6b6-488f-b357-965e6469b63f"; // smoke@test.local
const WORKSPACE_ID =
  process.env.RT_E2E_WORKSPACE_ID ?? "91f6266b-b196-4543-811f-664396c2e717"; // Smoke WS

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const secret =
  readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^APP_SESSION_SECRET=(.*)$/m)?.[1]?.trim() ||
  "rabbitpost-dev-secret";
const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const p = b64u(
  JSON.stringify({ uid: UID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
);
const COOKIE = `rp_session=${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.error(`  ❌ ${name} ${extra}`);
  }
};

/** 创建一个 rt session 并挂 SSE 事件流，返回操作句柄 */
async function openSession(protocol, url, config) {
  const created = await (
    await fetch(`${API}/api/v1/rt/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, protocol, url, config }),
    })
  ).json();
  if (!created.ok) throw new Error(`create ${protocol} session failed: ${JSON.stringify(created)}`);
  const sessionId = created.data.sessionId;
  const events = [];
  const sseRes = await fetch(`${API}/api/v1/rt/sessions/${sessionId}/events`, {
    headers: { cookie: COOKIE },
  });
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const done = (async () => {
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* 心跳等 */
          }
        }
      }
    }
  })();
  return {
    events,
    async send(payload) {
      await fetch(`${API}/api/v1/rt/sessions/${sessionId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: COOKIE },
        body: JSON.stringify({ data: typeof payload === "string" ? payload : JSON.stringify(payload) }),
      });
    },
    async waitFor(pred, label, timeoutMs = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`[${protocol}] timeout: ${label}; events=${JSON.stringify(events).slice(0, 800)}`);
    },
    async close() {
      await fetch(`${API}/api/v1/rt/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { cookie: COOKIE },
      }).catch(() => {});
      reader.cancel().catch(() => {});
      await done.catch(() => {});
    },
  };
}

const has = (s, sub) => (m) => m.t === "message" && m.dir === s && String(m.data).includes(sub);

async function testWebSocket() {
  console.log("■ websocket");
  const s = await openSession("websocket", "ws://localhost:3090/ws/echo", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    ok("连接打开 + 收到 greeting", await s.waitFor(has("in", "welcome"), "greeting").then(() => true));
    await s.send("ping-rabbit");
    ok("文本 echo", !!(await s.waitFor(has("in", "ping-rabbit"), "echo")));
  } finally {
    await s.close();
  }
}

async function testSocketIO() {
  console.log("■ socketio");
  const s = await openSession("socketio", "http://localhost:3090", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    ok("welcome 事件", !!(await s.waitFor(has("in", "welcome"), "welcome")));
    await s.send({ event: "chat", args: [{ text: "hi" }] });
    ok("echo:chat 回显", !!(await s.waitFor(has("in", "echo:chat"), "echo")));
    ok("ack 回执", !!(await s.waitFor(has("in", "[ack] chat"), "ack")));
  } finally {
    await s.close();
  }
}

async function testMqtt() {
  console.log("■ mqtt");
  const s = await openSession("mqtt", "mqtt://localhost:1883", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    await s.send({ action: "subscribe", topic: "test/e2e", qos: 0 });
    await s.waitFor(has("out", "已订阅"), "subscribe ack");
    await s.send({ action: "publish", topic: "test/e2e", payload: "mqtt-hello", qos: 0 });
    ok("订阅收到自己发布的消息", !!(await s.waitFor(has("in", "mqtt-hello"), "publish echo")));
  } finally {
    await s.close();
  }
}

async function testSse() {
  console.log("■ sse");
  const s = await openSession("sse", "http://localhost:3090/sse/finite", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    ok("收到自定义事件帧", !!(await s.waitFor(has("in", "done"), "custom event")));
    ok("流结束后 closed", !!(await s.waitFor((m) => m.t === "status" && m.state === "closed", "closed")));
  } finally {
    await s.close();
  }
}

async function testGraphqlSubscription() {
  console.log("■ graphql-subscription");
  const s = await openSession("graphql-subscription", "http://localhost:3090/graphql", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    await s.send({ action: "subscribe", query: "subscription { tick }" });
    ok("收到 tick 数据", !!(await s.waitFor(has("in", '"tick"'), "tick", 20000)));
    // graphql-transport-ws 语义：client complete（stop）后服务端不再发 next，也不回 complete。
    // stop 经 浏览器→api→runner→服务端 传递存在在途消息，宽限 1.5s 后必须静默
    await s.send({ action: "stop" });
    await new Promise((r) => setTimeout(r, 1500));
    const countAtGrace = s.events.filter(has("in", '"tick"')).length;
    await new Promise((r) => setTimeout(r, 2500));
    const countAfterGrace = s.events.filter(has("in", '"tick"')).length;
    ok("stop 宽限期后不再收到数据", countAfterGrace === countAtGrace, `又收到 ${countAfterGrace - countAtGrace} 条`);
  } finally {
    await s.close();
  }
}

async function testMcp() {
  console.log("■ mcp");
  const s = await openSession("mcp", "http://localhost:3090/mcp", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    ok("serverInfo 回推", !!(await s.waitFor(has("in", "serverInfo"), "serverInfo")));
    await s.send({ action: "tools/call", name: "echo", arguments: { text: "hi" } });
    ok("tools/call echo", !!(await s.waitFor(has("in", "echo: hi"), "tools/call")));
  } finally {
    await s.close();
  }
}

async function testGrpc() {
  console.log("■ grpc");
  const s = await openSession("grpc", "localhost:50051", {});
  try {
    await s.waitFor((m) => m.t === "status" && m.state === "open", "open");
    ok(
      "reflection serviceList",
      !!(await s.waitFor(has("in", "rabbitpost.test.echo.Echo"), "serviceList", 20000)),
    );
    await s.send({
      action: "invoke",
      service: "rabbitpost.test.echo.Echo",
      method: "Unary",
      payload: { text: "hi", count: 1 },
    });
    ok("Unary 响应", !!(await s.waitFor(has("in", "echo: hi"), "unary data", 20000)));
    ok("调用正常结束 code 0", !!(await s.waitFor(has("in", '"code":0'), "end")));
    // server streaming：从当前位置起算，避免与 Unary 的事件混淆
    const offset = s.events.length;
    await s.send({
      action: "invoke",
      service: "rabbitpost.test.echo.Echo",
      method: "ServerStream",
      payload: { text: "s", count: 3 },
    });
    const start = Date.now();
    let streamEvents = [];
    while (Date.now() - start < 20000) {
      streamEvents = s.events.slice(offset);
      if (
        streamEvents.some(
          (m) => m.t === "message" && m.dir === "in" && String(m.data).includes('"event":"end"'),
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const dataCount = streamEvents.filter(
      (m) => m.t === "message" && m.dir === "in" && String(m.data).includes('"event":"data"'),
    ).length;
    ok("ServerStream 收到 3 条流式消息后 end", dataCount === 3, `got ${dataCount}`);
  } finally {
    await s.close();
  }
}

const tests = [
  testWebSocket,
  testSocketIO,
  testMqtt,
  testSse,
  testGraphqlSubscription,
  testMcp,
  testGrpc,
];
for (const t of tests) {
  try {
    await t();
  } catch (e) {
    failures++;
    console.error(`  ❌ ${t.name} 异常：${e instanceof Error ? e.message : e}`);
  }
}

console.log(failures === 0 ? "\nALL PROTOCOLS PASS ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);

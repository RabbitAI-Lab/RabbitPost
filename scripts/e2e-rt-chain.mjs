/**
 * 长连接协议全链路手工验收脚本：
 * 浏览器路径（POST + SSE + 会话 cookie）→ api 实时桥 → runner（rt link）→ 本地 WS echo 服务。
 *
 * 前提：`pnpm dev` 已启动（api :4000 且内嵌 runner 的 rt link 已建立）。
 * 用法：node scripts/e2e-rt-chain.mjs
 * 环境变量：RT_E2E_UID / RT_E2E_WORKSPACE_ID 覆盖默认的 smoke 测试账号。
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require2 = createRequire(
  fileURLToPath(new URL("../apps/runner/tests/node/package.json", import.meta.url)),
);
const wsModule = await import(require2.resolve("ws"));
// ws 是 CJS 包：命名导出可能在 default 上
const { WebSocketServer } = wsModule.default ?? wsModule;

const API = process.env.API_ORIGIN ?? "http://localhost:4000";
const UID = process.env.RT_E2E_UID ?? "5c77656a-b6b6-488f-b357-965e6469b63f"; // smoke@test.local
const WORKSPACE_ID =
  process.env.RT_E2E_WORKSPACE_ID ?? "91f6266b-b196-4543-811f-664396c2e717"; // Smoke WS

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function mintSession() {
  // 与 apps/api/src/lib/auth.ts createSession 等价的 HS256 JWT
  const secret =
    readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^APP_SESSION_SECRET=(.*)$/m)?.[1]?.trim() ||
    "rabbitpost-dev-secret";
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({
      uid: UID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `rp_session=${header}.${payload}.${sig}`;
}
const COOKIE = mintSession();

// 1. 本地 WS echo 服务
const echo = new WebSocketServer({ port: 4999 });
echo.on("connection", (ws) => ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary })));
await new Promise((r) => echo.on("listening", r));
console.log("[e2e] echo server on :4999");

// 2. 创建 session
const created = await (
  await fetch(`${API}/api/v1/rt/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      protocol: "websocket",
      url: "ws://127.0.0.1:4999",
      config: { headers: [{ key: "x-e2e", value: "1", enabled: true }] },
    }),
  })
).json();
if (!created.ok) {
  console.error("[e2e] create session failed:", JSON.stringify(created));
  process.exit(1);
}
const sessionId = created.data.sessionId;
console.log("[e2e] session created:", sessionId);

// 3. SSE 收事件
const events = [];
const sseRes = await fetch(`${API}/api/v1/rt/sessions/${sessionId}/events`, {
  headers: { cookie: COOKIE },
});
if (!sseRes.ok || !sseRes.body) {
  console.error("[e2e] events failed:", sseRes.status);
  process.exit(1);
}
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buf = "";
(async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
})();

const waitFor = async (pred, label, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some(pred)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`[e2e] TIMEOUT waiting: ${label}; events=`, JSON.stringify(events, null, 1));
  process.exit(1);
};

// 4. 等 open → 发消息 → 等 echo
await waitFor((m) => m.t === "status" && m.state === "open", "status open");
console.log("[e2e] connection open (browser→api→runner→target)");

await fetch(`${API}/api/v1/rt/sessions/${sessionId}/send`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: COOKIE },
  body: JSON.stringify({ data: "hello via runner", encoding: "text" }),
});
await waitFor((m) => m.t === "message" && m.dir === "in" && m.data === "hello via runner", "echo");
console.log("[e2e] echo received");

// 5. 关闭
await fetch(`${API}/api/v1/rt/sessions/${sessionId}`, {
  method: "DELETE",
  headers: { cookie: COOKIE },
});
await waitFor((m) => m.t === "status" && m.state === "closed", "closed");
console.log("[e2e] closed cleanly");
console.log("[e2e] FULL CHAIN PASS ✅  browser⇄api⇄runner⇄target");
process.exit(0);

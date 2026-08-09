/**
 * 数据库连接（Apifox 风格）端到端验收：
 *   REST 连接管理（创建/连通性测试/列表/删除）
 *   → /execute 声明式 dbOperations.pre/post（建表/写入/查询/变量提取/{{var}} 替换）
 *   → 脚本 rp.db.query/exec（async 沙箱真实往返）
 *   → 失败操作不中断请求、未知连接名错误路径。
 * 全程使用 sqlite 临时文件库，无需外部数据库服务。
 *
 * 公共前提：api 已启动（:4000，`pnpm dev:api`）+ mock-server 已启动
 * （:3090，`pnpm --filter @rabbitpost/mock-server start`）。本脚本不自动启动服务。
 * 用法：node scripts/e2e-db.mjs
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const API = process.env.API_ORIGIN ?? "http://localhost:4000";
const MOCK = process.env.MOCK_ORIGIN ?? "http://localhost:3090";
const UID = process.env.DB_E2E_UID ?? "5c77656a-b6b6-488f-b357-965e6469b63f"; // smoke@test.local
const WORKSPACE_ID =
  process.env.DB_E2E_WORKSPACE_ID ?? "91f6266b-b196-4543-811f-664396c2e717"; // Smoke WS
const CONN_NAME = "e2e-sqlite";
const DB_FILE = path.join(os.tmpdir(), `rp-e2e-db-${randomBytes(6).toString("hex")}.db`);

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

async function apiFetch(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** 组装一个最小 RequestConfig（字段与 packages/shared createEmptyRequestConfig 对齐） */
function requestConfig(overrides = {}) {
  return {
    protocol: "http",
    method: "GET",
    url: `${MOCK}/get`,
    params: [],
    headers: [],
    body: { type: "none", rawLanguage: "json" },
    auth: { type: "none" },
    scripts: {},
    ...overrides,
  };
}

async function execute(request, name) {
  const { status, json } = await apiFetch("/api/v1/execute", {
    method: "POST",
    body: { workspaceId: WORKSPACE_ID, name, request },
  });
  if (status !== 200 || !json?.ok) {
    throw new Error(`execute ${name} HTTP ${status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data; // ExecuteResult
}

const logLines = (result) => result.consoleLogs.map((l) => `${l.level}:${l.args.join(" ")}`);

let connectionId = null;
try {
  // ------------------------------------------------------------------ 连接管理
  console.log("■ db-connections REST（sqlite）");
  {
    const { status, json } = await apiFetch("/api/v1/db-connections", {
      method: "POST",
      body: {
        workspaceId: WORKSPACE_ID,
        name: CONN_NAME,
        type: "sqlite",
        config: { type: "sqlite", filepath: DB_FILE },
      },
    });
    ok("创建连接 201 + ok", status === 201 && json?.ok === true, JSON.stringify(json).slice(0, 300));
    connectionId = json?.data?.id;
    ok("DTO 字段完整", !!connectionId && json.data.type === "sqlite" && json.data.hasPassword === false);
  }
  if (!connectionId) throw new Error("创建连接失败，后续用例无法继续");

  {
    const { json } = await apiFetch(`/api/v1/db-connections/${connectionId}/test`, {
      method: "POST",
      body: {},
    });
    ok("连通性测试 success=true", json?.ok === true && json.data.success === true, JSON.stringify(json).slice(0, 300));
  }

  {
    const { json } = await apiFetch(`/api/v1/db-connections?workspaceId=${WORKSPACE_ID}`);
    ok("列表包含新连接", json?.ok === true && json.data.some((c) => c.id === connectionId && c.name === CONN_NAME));
  }

  // ------------------------------------------------- 声明式 dbOperations 全链路
  console.log("■ execute：db.pre 建表/写入/提取 + db.post + 脚本 rp.db");
  {
    // 注意：URL/params 的 {{var}} 替换发生在 db.pre 之前（与 Postman 一致，两个沙箱对齐），
    // 因此提取变量对 {{var}} 的证明放在 db 操作语句内部（runDbOperations 逐步替换）。
    const result = await execute(
      requestConfig({
        dbOperations: {
          pre: [
            {
              id: "p1",
              connection: CONN_NAME,
              kind: "sql",
              statement: "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, token TEXT)",
            },
            {
              id: "p2",
              connection: CONN_NAME,
              kind: "sql",
              statement: "INSERT INTO users (id, name, token) VALUES (?, ?, ?)",
              params: ["1", "alice", "tok-abc-123"],
            },
            {
              id: "p3",
              connection: CONN_NAME,
              kind: "sql",
              statement: "SELECT * FROM users WHERE id = ?",
              params: ["1"],
              extract: [
                { variable: "dbUserName", source: "row.name" },
                { variable: "dbFirstRow", source: "row" },
                { variable: "dbAllRows", source: "rows" },
              ],
            },
            {
              // 提取变量在同一阶段后续语句的 {{var}} 中可见
              id: "p4",
              connection: CONN_NAME,
              kind: "sql",
              statement: "SELECT token FROM users WHERE name = '{{dbUserName}}'",
              extract: [{ variable: "dbTokenViaVar", source: "row.token" }],
            },
          ],
          post: [
            {
              id: "q1",
              connection: CONN_NAME,
              kind: "sql",
              statement: "SELECT COUNT(*) AS c FROM users WHERE name = '{{dbUserName}}'",
              extract: [{ variable: "dbUserCount", source: "row.c" }],
            },
          ],
        },
        scripts: {
          preRequest: `
            const r = await rp.db.query("${CONN_NAME}", "SELECT token FROM users WHERE id = ?", [1]);
            rp.environment.set("scriptToken", r.rows[0].token);
            rp.test("pre: rp.db.query rowCount", () => { rp.expect(r.rowCount).to.equal(1); });
          `,
          test: `
            rp.test("status 200", () => { rp.expect(rp.response.code).to.equal(200); });
            rp.test("extract row.name", () => { rp.expect(rp.environment.get("dbUserName")).to.equal("alice"); });
            rp.test("extract row JSON", () => { rp.expect(JSON.parse(rp.environment.get("dbFirstRow")).token).to.equal("tok-abc-123"); });
            rp.test("extract rows JSON", () => { rp.expect(JSON.parse(rp.environment.get("dbAllRows"))[0].name).to.equal("alice"); });
            rp.test("pre 阶段 {{var}} 替换", () => { rp.expect(rp.environment.get("dbTokenViaVar")).to.equal("tok-abc-123"); });
            rp.test("post 提取（{{var}} 替换）", () => { rp.expect(rp.environment.get("dbUserCount")).to.equal("1"); });
            rp.test("pre 脚本写入变量", () => { rp.expect(rp.environment.get("scriptToken")).to.equal("tok-abc-123"); });
            const r2 = await rp.db.query("${CONN_NAME}", "SELECT name FROM users WHERE id = 1");
            rp.test("test 脚本 rp.db 往返", () => { rp.expect(r2.rows[0].name).to.equal("alice"); });
          `,
        },
      }),
      "e2e-db main flow",
    );

    ok("ExecuteResult ok + status 200", result.ok === true && result.status === 200, JSON.stringify(result).slice(0, 300));
    const failedTests = (result.testResults ?? []).filter((t) => !t.passed);
    ok(
      `脚本断言全部通过（${(result.testResults ?? []).length} 项）`,
      (result.testResults ?? []).length === 9 && failedTests.length === 0,
      failedTests.map((t) => `${t.name}: ${t.error}`).join("; "),
    );
    const logs = logLines(result);
    ok("[db:pre] exec 日志（建表）", logs.some((l) => l.startsWith("log:[db:pre] e2e-sqlite exec ok")), logs.join(" | ").slice(0, 400));
    ok("[db:pre] query 日志 rowCount=1", logs.some((l) => l.startsWith("log:[db:pre] e2e-sqlite query ok, rowCount=1")));
    ok("[db:post] query 日志", logs.some((l) => l.startsWith("log:[db:post] e2e-sqlite query ok")));
  }

  // ------------------------------------------------------- 失败操作不中断请求
  console.log("■ execute：db.pre 坏 SQL → 记录错误但不中断请求");
  {
    const result = await execute(
      requestConfig({
        dbOperations: {
          pre: [
            {
              id: "bad1",
              connection: CONN_NAME,
              kind: "sql",
              statement: "INSERT INTO missing_table VALUES (1)",
            },
          ],
        },
      }),
      "e2e-db failing op",
    );
    ok("请求仍然成功（ok + 200）", result.ok === true && result.status === 200, JSON.stringify(result).slice(0, 300));
    const logs = logLines(result);
    ok(
      "console 含 [db:pre] error 且提到 missing_table",
      logs.some((l) => l.startsWith("error:[db:pre] e2e-sqlite") && l.includes("missing_table")),
      logs.join(" | ").slice(0, 400),
    );
  }

  // ------------------------------------------------------------ 未知连接名路径
  console.log("■ execute：未知连接名 → 清晰错误");
  {
    const result = await execute(
      requestConfig({
        dbOperations: {
          pre: [{ id: "u1", connection: "no-such-conn", kind: "sql", statement: "SELECT 1" }],
        },
      }),
      "e2e-db unknown connection (declarative)",
    );
    ok("请求仍成功", result.ok === true && result.status === 200);
    ok(
      "声明式操作报 unknown database connection",
      logLines(result).some((l) => l.startsWith("error:[db:pre]") && l.includes("unknown database connection") && l.includes("no-such-conn")),
      logLines(result).join(" | ").slice(0, 400),
    );
  }
  {
    const result = await execute(
      requestConfig({
        scripts: {
          test: `await rp.db.query("no-such-conn", "SELECT 1");`,
        },
      }),
      "e2e-db unknown connection (script)",
    );
    ok("脚本路径请求仍成功", result.ok === true && result.status === 200);
    ok(
      "脚本 rp.db 报 unknown database connection",
      logLines(result).some((l) => l.startsWith("error:[test]") && l.includes("unknown database connection") && l.includes("no-such-conn")),
      logLines(result).join(" | ").slice(0, 400),
    );
  }
} catch (e) {
  failures++;
  console.error(`  ❌ 异常：${e instanceof Error ? e.message : e}`);
} finally {
  // ------------------------------------------------------------------ 清理
  if (connectionId) {
    const { json } = await apiFetch(`/api/v1/db-connections/${connectionId}`, { method: "DELETE" });
    ok("清理：删除连接", json?.ok === true && json.data.deleted === true, JSON.stringify(json).slice(0, 200));
    const { json: list } = await apiFetch(`/api/v1/db-connections?workspaceId=${WORKSPACE_ID}`);
    ok("清理：列表不再包含该连接", list?.ok === true && !list.data.some((c) => c.id === connectionId));
  }
  rmSync(DB_FILE, { force: true });
}

console.log(failures === 0 ? "\nALL DB E2E PASS ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);

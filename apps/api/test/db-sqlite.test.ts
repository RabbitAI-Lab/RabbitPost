/**
 * sqlite 集成测试（better-sqlite3 临时文件库，无需外部服务）：
 * - db-client：exec/query/? 参数/readOnly 护栏/maxRows 截断
 * - pm-sandbox：旧同步脚本行为不变；rp.db 无执行器时报错；await rp.db.query 真实往返
 * - executor：声明式 db.pre/db.post（建表/写入/提取/{{var}} 替换）+ 脚本断言全链路
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createEmptyRequestConfig, type ExecuteRequestInput } from "@rabbitpost/shared";
import { createDbExecutor } from "../src/lib/db-client";
import { executeRequest } from "../src/lib/executor";
import { runUserScript } from "../src/lib/pm-sandbox";
import { seedBasic } from "./helpers";

const tmpFile = () =>
  path.join(os.tmpdir(), `rp-dbtest-${crypto.randomBytes(6).toString("hex")}.db`);

const cleanups: string[] = [];
afterAll(() => {
  for (const f of cleanups) fs.rmSync(f, { force: true });
});

describe("db-client: sqlite", () => {
  it("exec / query（? 占位符 + 参数绑定）", async () => {
    const file = tmpFile();
    cleanups.push(file);
    const executor = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: file } },
    ]);
    await executor.exec("main", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    const ins = await executor.exec("main", "INSERT INTO users (id, name) VALUES (?, ?)", [
      1,
      "alice",
    ]);
    expect(ins.affectedRows).toBe(1);
    const res = await executor.query("main", "SELECT * FROM users WHERE id = ?", [1]);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toEqual({ id: 1, name: "alice" });
    await executor.close();
  });

  it("readOnly 拒绝非 SELECT（大小写不敏感），允许 WITH...SELECT", async () => {
    const file = tmpFile();
    cleanups.push(file);
    // 先用可写连接建表
    const writer = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: file } },
    ]);
    await writer.exec("main", "CREATE TABLE t (id INTEGER)");
    await writer.exec("main", "INSERT INTO t VALUES (1)");
    await writer.close();

    const ro = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: file, readOnly: true } },
    ]);
    await expect(ro.exec("main", "INSERT INTO t VALUES (2)")).rejects.toThrow(/read-only/);
    await expect(ro.query("main", "delete from t")).rejects.toThrow(/read-only/);
    const ok = await ro.query("main", "WITH x AS (SELECT 1 AS v) SELECT * FROM x");
    expect(ok.rows[0]).toEqual({ v: 1 });
    await ro.close();
  });

  it("maxRows 截断：超出 1000 行时 truncated=true", async () => {
    const file = tmpFile();
    cleanups.push(file);
    // 直接用 better-sqlite3 灌 1005 行
    const db = new Database(file);
    db.exec("CREATE TABLE big (id INTEGER)");
    const insert = db.prepare("INSERT INTO big VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < 1005; i++) insert.run(i);
    })();
    db.close();

    const executor = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: file } },
    ]);
    const res = await executor.query("main", "SELECT * FROM big");
    expect(res.rowCount).toBe(1000);
    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(1000);
    await executor.close();
  });

  it("未知连接名报错清晰", async () => {
    const executor = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: tmpFile() } },
    ]);
    await expect(executor.query("nope", "SELECT 1")).rejects.toThrow(
      /unknown database connection "nope"/,
    );
    await executor.close();
  });
});

describe("pm-sandbox: async 改造与 rp.db", () => {
  it("旧同步脚本行为不变（变量/请求改写/console/断言）", async () => {
    const result = await runUserScript({
      code: `
        rp.environment.set("token", "abc");
        rp.request.headers["X-Token"] = "abc";
        console.log("hello", 42);
        rp.test("ok", () => { rp.expect(1 + 1).to.equal(2); });
      `,
      phase: "pre-request",
      variables: { base: "1" },
      request: { method: "GET", url: "http://x/", headers: {} },
    });
    expect(result.error).toBeUndefined();
    expect(result.variables).toEqual({ base: "1", token: "abc" });
    expect(result.request?.headers["X-Token"]).toBe("abc");
    expect(result.consoleLogs[0]).toEqual({ level: "log", args: ["hello", "42"] });
    expect(result.testResults).toEqual([{ name: "ok", passed: true }]);
  });

  it("未配置连接时 rp.db 抛出清晰错误（转为脚本错误）", async () => {
    const result = await runUserScript({
      code: `await rp.db.query("main", "SELECT 1");`,
      phase: "pre-request",
      variables: {},
    });
    expect(result.error).toMatch(/no database connections configured/);
  });

  it("await rp.db.query 真实往返 sqlite，结果可写入环境变量", async () => {
    const file = tmpFile();
    cleanups.push(file);
    const executor = createDbExecutor([
      { name: "main", config: { type: "sqlite", filepath: file } },
    ]);
    await executor.exec("main", "CREATE TABLE users (id INTEGER, name TEXT)");
    await executor.exec("main", "INSERT INTO users VALUES (7, 'carol')");

    const result = await runUserScript({
      code: `
        const res = await rp.db.query("main", "SELECT name FROM users WHERE id = ?", [7]);
        rp.environment.set("userName", res.rows[0].name);
        rp.test("rowCount", () => { rp.expect(res.rowCount).to.equal(1); });
      `,
      phase: "test",
      variables: {},
      db: executor,
    });
    expect(result.error).toBeUndefined();
    expect(result.variables.userName).toBe("carol");
    expect(result.testResults).toEqual([{ name: "rowCount", passed: true }]);
    await executor.close();
  });
});

describe("executor: 声明式 db.pre / db.post 全链路（sqlite）", () => {
  let server: http.Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("db.pre 建表/写入/提取 → test 脚本断言提取变量；失败操作不中断请求", async () => {
    const s = await seedBasic();
    const file = tmpFile();
    cleanups.push(file);

    const input: ExecuteRequestInput = {
      workspaceId: s.workspaceId,
      request: {
        ...createEmptyRequestConfig(),
        method: "GET",
        url: `${baseUrl}/echo`,
        dbOperations: {
          pre: [
            {
              id: "p1",
              connection: "main",
              kind: "sql",
              statement: "CREATE TABLE IF NOT EXISTS users (id INTEGER, name TEXT)",
            },
            {
              id: "p2",
              connection: "main",
              kind: "sql",
              statement: "INSERT INTO users VALUES (?, ?)",
              params: ["1", "alice"],
            },
            {
              id: "p3",
              connection: "main",
              kind: "sql",
              statement: "SELECT * FROM users WHERE id = ?",
              params: ["1"],
              extract: [
                { variable: "userName", source: "row.name" },
                { variable: "allUsers", source: "rows" },
              ],
            },
            // 故意失败的操作：应记录 console 错误但不中断请求
            {
              id: "p4",
              connection: "main",
              kind: "sql",
              statement: "INSERT INTO missing_table VALUES (1)",
            },
          ],
          post: [
            {
              id: "q1",
              connection: "main",
              kind: "sql",
              // {{var}} 替换：db.pre 提取的 userName 在 db.post 可见
              statement: "SELECT COUNT(*) AS c FROM users WHERE name = '{{userName}}'",
              extract: [{ variable: "userCount", source: "row.c" }],
            },
          ],
        },
        scripts: {
          test: `
            rp.test("extracted userName", () => { rp.expect(rp.environment.get("userName")).to.equal("alice"); });
            rp.test("post userCount", () => { rp.expect(rp.environment.get("userCount")).to.equal("1"); });
            rp.test("rows json", () => { rp.expect(JSON.parse(rp.environment.get("allUsers"))[0].name).to.equal("alice"); });
          `,
        },
      },
      // local-agent 路径：明文连接随请求下发，服务端不再查表
      dbConnections: [{ name: "main", config: { type: "sqlite", filepath: file } }],
    };

    const result = await executeRequest(input, s.userId);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    // 三个断言全过：pre 提取、post 提取（含 {{var}} 替换）、rows JSON
    expect(result.testResults).toEqual([
      { name: "extracted userName", passed: true },
      { name: "post userCount", passed: true },
      { name: "rows json", passed: true },
    ]);

    // db 操作日志进入 consoleLogs；失败操作记录为 error
    const logs = result.consoleLogs.map((l) => `${l.level}:${l.args.join(" ")}`);
    expect(logs.some((l) => l.startsWith("log:[db:pre] main query ok, rowCount=1"))).toBe(true);
    expect(logs.some((l) => l.startsWith("log:[db:post] main query ok"))).toBe(true);
    expect(logs.some((l) => l.startsWith("error:[db:pre] main") && l.includes("missing_table"))).toBe(
      true,
    );
  });
});

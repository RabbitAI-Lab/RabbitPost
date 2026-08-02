/**
 * 执行报告导出（GET /runs/:jobId/report?format=junit|html）的路由级回归：
 * JUnit XML 结构/转义、HTML 自包含、权限
 */
import { describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { environments } from "../src/db/schema";
import type { RequestCase, RunJob } from "@rabbitpost/shared";
import {
  POST as createCase,
} from "../src/app/api/v1/items/[itemId]/cases/route";
import { POST as createRun } from "../src/app/api/v1/items/[itemId]/case-runs/route";
import { GET as reportRoute } from "../src/app/api/v1/runs/[jobId]/report/route";
import { authed, envelope, seedBasic, seedOutsiderToken, type Seed } from "./helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const itemCtx = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
const jobCtx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

async function makeCase(s: Seed, name: string): Promise<RequestCase> {
  const resp = await envelope<RequestCase>(
    await createCase(
      authed(`/api/v1/items/${s.itemId}/cases`, s.apiToken, { method: "POST", json: { name } }),
      itemCtx(s.itemId),
    ),
  );
  return resp.data;
}

async function makeBatchJob(s: Seed, a: RequestCase, b: RequestCase): Promise<RunJob> {
  const resp = await envelope<RunJob>(
    await createRun(
      authed(`/api/v1/items/${s.itemId}/case-runs`, s.apiToken, {
        method: "POST",
        json: {
          kind: "batch",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:02.000Z",
          results: [
            {
              caseId: a.id, name: "A <正常>", method: "GET", url: "http://x/health?a=1&b=2",
              ok: true, status: 200, statusText: "OK", durationMs: 10,
              testResults: [{ name: "status 200", passed: true }],
              request: {
                method: "GET", url: "{{baseUrl}}/health?a=1&b=2",
                params: [{ key: "a", value: "1", enabled: true }],
                headers: [{ key: "X-Token", value: "t-1", enabled: true }],
                body: { type: "none" },
              },
              responseHeaders: { "content-type": "application/json" },
              responseBody: "{\"ok\":true}",
            },
            {
              caseId: b.id, name: "B 异常", method: "GET", url: "http://x/bad",
              ok: false, status: 500, statusText: "Internal Server Error", durationMs: 12,
              error: "boom & <busted>",
              testResults: [{ name: "should be 400", passed: false, error: "expected 400, got 500" }],
              request: { method: "GET", url: "{{baseUrl}}/bad", params: [], headers: [], body: { type: "none" } },
              responseBody: "internal error detail",
            },
          ],
        },
      }),
      itemCtx(s.itemId),
    ),
  );
  return resp.data;
}

describe("runs/:jobId/report 导出", () => {
  it("JUnit XML：testsuite/testcase 结构、失败附 failure、特殊字符转义", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const b = await makeCase(s, "B");
    const job = await makeBatchJob(s, a, b);

    const resp = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=junit`, s.apiToken),
      jobCtx(job.id),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/xml");
    expect(resp.headers.get("Content-Disposition")).toContain("attachment");
    const xml = await resp.text();

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites name="rabbitpost" tests="2" failures="1"');
    expect(xml).toContain('<testsuite name="Health Check（全部用例）" tests="2" failures="1"');
    // 用例名转义
    expect(xml).toContain("GET A &lt;正常&gt;");
    // 失败用例附 failure + CDATA 明细
    expect(xml).toContain('<failure message="boom &amp; &lt;busted&gt;">');
    expect(xml).toContain("✗ should be 400 — expected 400, got 500");
    // 通过断言进 system-out
    expect(xml).toContain("✓ status 200");
    expect(xml.trim().endsWith("</testsuites>")).toBe(true);
  });

  it("HTML：自包含、汇总卡片、逐用例明细、内容转义", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const b = await makeCase(s, "B");
    const job = await makeBatchJob(s, a, b);

    const resp = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=html`, s.apiToken),
      jobCtx(job.id),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    const html = await resp.text();

    expect(html).toContain("RabbitPost 测试报告");
    expect(html).toContain("FAILED"); // 有失败
    expect(html).toContain("Health Check（全部用例）");
    // 转义：原始 < > & 不直接出现
    expect(html).toContain("A &lt;正常&gt;");
    expect(html).toContain("boom &amp; &lt;busted&gt;");
    expect(html).toContain("should be 400");
    // 自包含：无外部资源引用
    expect(html).not.toMatch(/<script src=|<link /);
  });

  it("报告含执行时的环境变量快照（secret 脱敏）", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const [env] = await db
      .insert(environments)
      .values({
        workspaceId: s.workspaceId,
        name: "Staging",
        variables: [
          { key: "baseUrl", value: "https://stg.example.com", enabled: true },
          { key: "token", value: "secret-value", enabled: true, secret: true },
        ],
      })
      .returning();
    const created = await envelope<RunJob>(
      await createRun(
        authed(`/api/v1/items/${s.itemId}/case-runs`, s.apiToken, {
          method: "POST",
          json: {
            kind: "single",
            caseId: a.id,
            environmentId: env.id,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [{
              caseId: a.id, name: "A", method: "GET", url: "http://x", ok: true,
              status: 200, statusText: "OK", durationMs: 5, testResults: [],
            }],
          },
        }),
        itemCtx(s.itemId),
      ),
    );

    const resp = await reportRoute(
      authed(`/api/v1/runs/${created.data.id}/report?format=html`, s.apiToken),
      jobCtx(created.data.id),
    );
    const html = await resp.text();
    expect(html).toContain("环境快照 · Staging");
    expect(html).toContain("baseUrl");
    expect(html).toContain("https://stg.example.com");
    // secret 脱敏
    expect(html).toContain("token");
    expect(html).toContain("******");
    expect(html).not.toContain("secret-value");
  });

  it("inline=1：Content-Disposition 为 inline（在线预览），缺省为 attachment（下载）", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const job = await makeBatchJob(s, a, a);

    const preview = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=html&inline=1`, s.apiToken),
      jobCtx(job.id),
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Disposition")).toMatch(/^inline;/);

    const download = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=html`, s.apiToken),
      jobCtx(job.id),
    );
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("format 非法 400；job 不存在 404；未认证 401；越权 403", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const job = await makeBatchJob(s, a, a);

    const bad = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=pdf`, s.apiToken),
      jobCtx(job.id),
    );
    expect(bad.status).toBe(400);

    const notFound = await reportRoute(
      authed(`/api/v1/runs/00000000-0000-0000-0000-000000000000/report?format=html`, s.apiToken),
      jobCtx("00000000-0000-0000-0000-000000000000"),
    );
    expect(notFound.status).toBe(404);

    const anon = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=html`, null),
      jobCtx(job.id),
    );
    expect(anon.status).toBe(401);

    const outsider = await seedOutsiderToken();
    const forbidden = await reportRoute(
      authed(`/api/v1/runs/${job.id}/report?format=html`, outsider),
      jobCtx(job.id),
    );
    expect(forbidden.status).toBe(403);
  });
});

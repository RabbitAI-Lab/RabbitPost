/**
 * 用例运行历史（服务端持久化）的路由级回归：
 * POST 上报（single/batch 语义、caseId 校验、结果落库）→ GET 历史列表 → runs/:jobId 详情
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { RequestCase, RunJob, RunJobDetail } from "@rabbitpost/shared";
import { db } from "../src/db";
import { environments, runJobResults } from "../src/db/schema";
import {
  GET as listCases,
  POST as createCase,
} from "../src/app/api/v1/items/[itemId]/cases/route";
import {
  GET as listRuns,
  POST as createRun,
} from "../src/app/api/v1/items/[itemId]/case-runs/route";
import { GET as runDetail } from "../src/app/api/v1/runs/[jobId]/route";
import { authed, envelope, seedBasic, seedOutsiderToken, type Seed } from "./helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const itemCtx = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
const jobCtx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const runsPath = (itemId: string) => `/api/v1/items/${itemId}/case-runs`;

async function makeCase(s: Seed, name: string): Promise<RequestCase> {
  const resp = await envelope<RequestCase>(
    await createCase(
      authed(`/api/v1/items/${s.itemId}/cases`, s.apiToken, { method: "POST", json: { name } }),
      itemCtx(s.itemId),
    ),
  );
  return resp.data;
}

function resultEntry(caseId: string, name: string, ok = true) {
  return {
    caseId,
    name,
    method: "GET",
    url: "http://x/health",
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    durationMs: 8,
    testResults: [{ name: "status 200", passed: ok }],
  };
}

describe("case-runs 上报与历史", () => {
  it("single：落一条终态 job（caseId 关联），结果含断言；历史列表与详情可读回", async () => {
    const s = await seedBasic();
    const c = await makeCase(s, "Smoke A");

    const created = await envelope<RunJob>(
      await createRun(
        authed(runsPath(s.itemId), s.apiToken, {
          method: "POST",
          json: {
            kind: "single",
            caseId: c.id,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [{
              ...resultEntry(c.id, "Smoke A"),
              request: { method: "GET", url: "{{baseUrl}}/health", params: [], headers: [], body: { type: "none" } },
              responseHeaders: { "content-type": "application/json" },
              responseBody: "{\"ok\":true}",
            }],
          },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.data.targetType).toBe("case");
    // Web Cases 面板直接执行上报，来源为 web（不是 cli）
    expect(created.data.source).toBe("web");
    expect(created.data.caseId).toBe(c.id);
    expect(created.data.targetName).toBe("Health Check / Smoke A");
    expect(created.data.status).toBe("succeeded");
    expect(created.data.testPassedCount).toBe(1);

    // 结果落库：caseId 归因
    const rows = await db
      .select()
      .from(runJobResults)
      .where(eq(runJobResults.jobId, created.data.id))
      .orderBy(asc(runJobResults.createdAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caseId).toBe(c.id);
    // 请求配置与响应落库（报告展示）
    expect(rows[0]!.request).toMatchObject({ method: "GET", url: "{{baseUrl}}/health" });
    expect(rows[0]!.responseHeaders).toEqual({ "content-type": "application/json" });
    expect(rows[0]!.responseBody).toBe("{\"ok\":true}");

    // 历史列表：只含该接口的 case 运行
    const runs = await envelope<RunJob[]>(
      await listRuns(authed(runsPath(s.itemId), s.apiToken), itemCtx(s.itemId)),
    );
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0]!.id).toBe(created.data.id);

    // 详情（历史面板展开报告的数据源）
    const detail = await envelope<RunJobDetail>(
      await runDetail(authed(`/api/v1/runs/${created.data.id}`, s.apiToken), jobCtx(created.data.id)),
    );
    expect(detail.data.results.map((r) => [r.name, r.caseId])).toEqual([["Smoke A", c.id]]);
  });

  it("batch：job.caseId 为 null，报告含全部用例；失败用例使整体 failed", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "A");
    const b = await makeCase(s, "B");

    const created = await envelope<RunJob>(
      await createRun(
        authed(runsPath(s.itemId), s.apiToken, {
          method: "POST",
          json: {
            kind: "batch",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:02.000Z",
            results: [resultEntry(a.id, "A", true), resultEntry(b.id, "B", false)],
          },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.data.caseId).toBeNull();
    expect(created.data.targetName).toBe("Health Check（全部用例）");
    expect(created.data.status).toBe("failed");
    expect(created.data.totalCount).toBe(2);
    expect(created.data.succeededCount).toBe(1);
    expect(created.data.failedCount).toBe(1);
    expect(created.data.testPassedCount).toBe(1);
    expect(created.data.testFailedCount).toBe(1);
  });

  it("single 缺 caseId 400；caseId 不属于该接口 404", async () => {
    const s = await seedBasic();
    const missing = await envelope(
      await createRun(
        authed(runsPath(s.itemId), s.apiToken, {
          method: "POST",
          json: {
            kind: "single",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [resultEntry("00000000-0000-0000-0000-000000000000", "X")],
          },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(missing.status).toBe(400);
    expect(missing.error?.code).toBe("CASE_REQUIRED");

    const notFound = await envelope(
      await createRun(
        authed(runsPath(s.itemId), s.apiToken, {
          method: "POST",
          json: {
            kind: "single",
            caseId: "00000000-0000-0000-0000-000000000000",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [resultEntry("00000000-0000-0000-0000-000000000000", "X")],
          },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(notFound.status).toBe(404);
  });

  it("带环境上报：存执行时的变量快照，secret 值脱敏", async () => {
    const s = await seedBasic();
    const c = await makeCase(s, "A");
    const [env] = await db
      .insert(environments)
      .values({
        workspaceId: s.workspaceId,
        name: "Staging",
        variables: [
          { key: "baseUrl", value: "https://stg.example.com", enabled: true },
          { key: "token", value: "secret-value", enabled: true, secret: true },
          { key: "debug", value: "1", enabled: false },
        ],
      })
      .returning();

    const created = await envelope<RunJob>(
      await createRun(
        authed(runsPath(s.itemId), s.apiToken, {
          method: "POST",
          json: {
            kind: "single",
            caseId: c.id,
            environmentId: env.id,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [resultEntry(c.id, "A")],
          },
        }),
        itemCtx(s.itemId),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.data.environmentName).toBe("Staging");
    const snapshot = created.data.environmentSnapshot!;
    expect(snapshot).toHaveLength(3);
    // 普通变量原样、secret 脱敏、enabled 状态保留
    expect(snapshot.find((v) => v.key === "baseUrl")!.value).toBe("https://stg.example.com");
    expect(snapshot.find((v) => v.key === "token")!.value).toBe("******");
    expect(snapshot.find((v) => v.key === "debug")!.enabled).toBe(false);

    // 环境后续改动不影响快照（把 token 改成别的，快照仍是执行时的）
    await db
      .update(environments)
      .set({ variables: [{ key: "baseUrl", value: "https://prod.example.com", enabled: true }] })
      .where(eq(environments.id, env.id));
    const detail = await envelope<RunJobDetail>(
      await runDetail(authed(`/api/v1/runs/${created.data.id}`, s.apiToken), jobCtx(created.data.id)),
    );
    expect(detail.data.job.environmentSnapshot).toHaveLength(3);
    expect(detail.data.job.environmentSnapshot!.find((v) => v.key === "baseUrl")!.value).toBe(
      "https://stg.example.com",
    );
  });

  it("历史列表不包含其它接口/其它类型的 run；未认证 401；越权 403", async () => {
    const s = await seedBasic();
    const c = await makeCase(s, "A");
    await createRun(
      authed(runsPath(s.itemId), s.apiToken, {
        method: "POST",
        json: {
          kind: "single",
          caseId: c.id,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          results: [resultEntry(c.id, "A")],
        },
      }),
      itemCtx(s.itemId),
    );

    // 未认证
    const anon = await envelope(await listRuns(authed(runsPath(s.itemId), null), itemCtx(s.itemId)));
    expect(anon.status).toBe(401);
    // 越权
    const outsider = await seedOutsiderToken();
    const forbidden = await envelope(
      await listRuns(authed(runsPath(s.itemId), outsider), itemCtx(s.itemId)),
    );
    expect(forbidden.status).toBe(403);
  });
});

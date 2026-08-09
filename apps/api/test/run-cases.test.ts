/**
 * 用例进入执行链路的回归测试：
 * expandRunTarget 展开（request / collection）→ dispatch → claim → results 上报（caseId 落库）
 * → runs/:jobId 详情；以及 CLI 报告上传路径。
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { RequestCase, RunJob, RunJobDetail, RunnerJobAssignment } from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { db } from "../src/db";
import { collectionItems, runJobResults } from "../src/db/schema";
import { expandRunTarget } from "../src/lib/runner";
import {
  GET as listCases,
  POST as createCase,
} from "../src/app/api/v1/items/[itemId]/cases/route";
import { POST as dispatchRun } from "../src/app/api/v1/teams/[teamId]/runs/route";
import { POST as claimJob } from "../src/app/api/v1/runner/jobs/claim/route";
import { POST as reportResults } from "../src/app/api/v1/runner/jobs/[jobId]/results/route";
import { GET as runDetail } from "../src/app/api/v1/runs/[jobId]/route";
import { POST as uploadReport } from "../src/app/api/v1/collections/[collectionId]/runs/route";
import {
  GET as listCollectionRuns,
} from "../src/app/api/v1/collections/[collectionId]/runs/route";
import { authed, envelope, seedBasic, type Seed } from "./helpers";

const itemCtx = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
const teamCtx = (teamId: string) => ({ params: Promise.resolve({ teamId }) });
const jobCtx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const colCtx = (collectionId: string) => ({ params: Promise.resolve({ collectionId }) });

async function makeCase(s: Seed, name: string): Promise<RequestCase> {
  const resp = await envelope<RequestCase>(
    await createCase(
      authed(`/api/v1/items/${s.itemId}/cases`, s.apiToken, { method: "POST", json: { name } }),
      itemCtx(s.itemId),
    ),
  );
  return resp.data;
}

describe("expandRunTarget 展开用例", () => {
  it("request 目标：请求本身 + 全部用例，用例带 caseId 且命名「接口 / 用例」", async () => {
    const s = await seedBasic();
    const a = await makeCase(s, "Smoke A");
    const b = await makeCase(s, "Smoke B");

    const target = await expandRunTarget("request", s.itemId);
    expect(target.workspaceId).toBe(s.workspaceId);
    expect(target.items.map((i) => i.name)).toEqual([
      "Health Check",
      "Health Check / Smoke A",
      "Health Check / Smoke B",
    ]);
    expect(target.items[0]!.caseId).toBeNull();
    expect(target.items[1]!.caseId).toBe(a.id);
    expect(target.items[2]!.caseId).toBe(b.id);
    expect(target.items[1]!.itemId).toBe(s.itemId);
  });

  it("collection 目标：用例紧跟所属接口（含文件夹前缀），无用例接口只有本身", async () => {
    const s = await seedBasic();
    await makeCase(s, "Smoke A");
    // 文件夹 + 另一个无用例接口
    const [folder] = await db
      .insert(collectionItems)
      .values({ collectionId: s.collectionId, type: "folder", name: "Sub", sortOrder: 1 })
      .returning();
    await db.insert(collectionItems).values({
      collectionId: s.collectionId,
      parentId: folder.id,
      type: "request",
      name: "Second",
      sortOrder: 0,
      request: createEmptyRequestConfig(),
    });

    const target = await expandRunTarget("collection", s.collectionId);
    expect(target.items.map((i) => [i.name, i.caseId ? "case" : "req"])).toEqual([
      ["Health Check", "req"],
      ["Health Check / Smoke A", "case"],
      ["Sub / Second", "req"],
    ]);
  });
});

describe("dispatch → claim → results → detail（Runner 链路）", () => {
  it("派发总数含用例；claim 下发 caseId；上报结果落 case_id；详情可读回", async () => {
    const s = await seedBasic();
    const c = await makeCase(s, "Smoke A");

    // 1. 派发（owner 满足 admin+）
    const dispatched = await envelope<RunJob>(
      await dispatchRun(
        authed(`/api/v1/teams/${s.teamId}/runs`, s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, targetType: "request", targetId: s.itemId },
        }),
        teamCtx(s.teamId),
      ),
    );
    expect(dispatched.status).toBe(201);
    expect(dispatched.data.totalCount).toBe(2); // 请求 + 1 用例

    // 2. Runner 领取：assignment items 含用例（带 caseId）
    const claimed = await envelope<{ job: RunnerJobAssignment }>(
      await claimJob(authed("/api/v1/runner/jobs/claim", s.runnerToken, { method: "POST", json: {} }), {}),
    );
    const job = claimed.data.job;
    expect(job.jobId).toBe(dispatched.data.id);
    expect(job.items.map((i) => [i.name, i.caseId ?? null])).toEqual([
      ["Health Check", null],
      ["Health Check / Smoke A", c.id],
    ]);

    // 3. 上报结果（一条请求 + 一条用例）
    const reported = await envelope(
      await reportResults(
        authed(`/api/v1/runner/jobs/${job.jobId}/results`, s.runnerToken, {
          method: "POST",
          json: {
            results: [
              { itemId: s.itemId, name: "Health Check", method: "GET", url: "http://x/health", ok: true, status: 200, durationMs: 5, responseHeaders: { "content-type": "text/html" }, responseBody: "<html>ok</html>" },
              {
                itemId: s.itemId,
                caseId: c.id,
                name: "Health Check / Smoke A",
                method: "GET",
                url: "http://x/health",
                ok: true,
                status: 200,
                durationMs: 7,
                testResults: [{ name: "status 200", passed: true }],
              },
            ],
          },
        }),
        jobCtx(job.jobId),
      ),
    );
    expect(reported.status).toBe(200);

    // 4. 落库验证：case_id 正确归因、断言计数
    const rows = await db
      .select()
      .from(runJobResults)
      .where(eq(runJobResults.jobId, job.jobId))
      .orderBy(asc(runJobResults.createdAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.caseId).toBeNull();
    expect(rows[1]!.caseId).toBe(c.id);
    // Runner 上报的响应头 / 响应体必须落库（Send 按钮 Body tab 数据源）
    expect(rows[0]!.responseHeaders).toEqual({ "content-type": "text/html" });
    expect(rows[0]!.responseBody).toBe("<html>ok</html>");

    // 5. 详情接口读回（Web Runs UI 数据源）
    const detail = await envelope<RunJobDetail>(
      await runDetail(authed(`/api/v1/runs/${job.jobId}`, s.apiToken), jobCtx(job.jobId)),
    );
    expect(detail.data.job.testPassedCount).toBe(1);
    expect(detail.data.results.map((r) => r.caseId)).toEqual([null, c.id]);
  });
});

describe("CLI 报告上传（cli 链路）", () => {
  it("上传结果带 caseId 时落库并可在详情读回；请求本身 caseId 为 null", async () => {
    const s = await seedBasic();
    const c = await makeCase(s, "Smoke A");

    const uploaded = await envelope<RunJob>(
      await uploadReport(
        authed(`/api/v1/collections/${s.collectionId}/runs`, s.apiToken, {
          method: "POST",
          json: {
            format: "rabbitpost.run-report",
            version: 1,
            agent: "rabbitpost-cli/test",
            collectionId: s.collectionId,
            targetType: "collection",
            targetId: s.collectionId,
            targetName: "Test Col",
            environmentId: null,
            environmentName: null,
            concurrency: 4,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            summary: { total: 2, succeeded: 2, failed: 0, testsPassed: 0, testsFailed: 0, durationMs: 1000 },
            results: [
              { itemId: s.itemId, name: "Health Check", method: "GET", url: "http://x/health", ok: true, status: 200, durationMs: 5 },
              { itemId: s.itemId, caseId: c.id, name: "Health Check / Smoke A", method: "GET", url: "http://x/health", ok: true, status: 200, durationMs: 7 },
            ],
          },
        }),
        colCtx(s.collectionId),
      ),
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.data.status).toBe("succeeded");
    expect(uploaded.data.totalCount).toBe(2);

    const detail = await envelope<RunJobDetail>(
      await runDetail(authed(`/api/v1/runs/${uploaded.data.id}`, s.apiToken), jobCtx(uploaded.data.id)),
    );
    expect(detail.data.results.map((r) => [r.name, r.caseId])).toEqual([
      ["Health Check", null],
      ["Health Check / Smoke A", c.id],
    ]);
  });

  // -----------------------------------------------------------------------
  // 回归：Web Runner（CollectionRunner 页面 Start run）上报 source=web，
  // 之前后端硬编码 source=cli 导致 Web Runner 的运行结果无法与 CLI 区分，
  // 且前端 CollectionRunsPanel 按集合过滤列表时因记录未落库而看不到。
  // -----------------------------------------------------------------------
  it("Web Runner 上报 source=web：落库标记 web，GET 列表可读回", async () => {
    const s = await seedBasic();

    const uploaded = await envelope<RunJob>(
      await uploadReport(
        authed(`/api/v1/collections/${s.collectionId}/runs`, s.apiToken, {
          method: "POST",
          json: {
            format: "rabbitpost.run-report",
            version: 1,
            source: "web",
            agent: "rabbitpost-web",
            collectionId: s.collectionId,
            targetType: "collection",
            targetId: s.collectionId,
            targetName: "Test Col",
            environmentId: null,
            environmentName: null,
            concurrency: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            summary: { total: 1, succeeded: 1, failed: 0, testsPassed: 0, testsFailed: 0, durationMs: 100 },
            results: [
              { itemId: s.itemId, name: "Health Check", method: "GET", url: "http://x/health", ok: true, status: 200, durationMs: 5 },
            ],
          },
        }),
        colCtx(s.collectionId),
      ),
    );
    expect(uploaded.status).toBe(201);
    // 关键回归点：source 必须是 web（不是 cli）
    expect(uploaded.data.source).toBe("web");
    expect(uploaded.data.collectionId).toBe(s.collectionId);
    expect(uploaded.data.agent).toBe("rabbitpost-web");

    // GET 列表必须能读回（CollectionRunsPanel 的数据源）
    const list = await envelope<RunJob[]>(
      await listCollectionRuns(
        authed(`/api/v1/collections/${s.collectionId}/runs`, s.apiToken),
        colCtx(s.collectionId),
      ),
    );
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.id).toBe(uploaded.data.id);
    expect(list.data[0]!.source).toBe("web");
  });

  it("不传 source 时缺省 cli（向后兼容 CLI 上传）", async () => {
    const s = await seedBasic();
    const uploaded = await envelope<RunJob>(
      await uploadReport(
        authed(`/api/v1/collections/${s.collectionId}/runs`, s.apiToken, {
          method: "POST",
          json: {
            format: "rabbitpost.run-report",
            version: 1,
            // 不传 source
            agent: "rabbitpost-cli/test",
            collectionId: s.collectionId,
            targetType: "collection",
            targetId: s.collectionId,
            targetName: "Test Col",
            environmentId: null,
            environmentName: null,
            concurrency: 4,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:01.000Z",
            results: [
              { itemId: s.itemId, name: "Health Check", method: "GET", url: "http://x/health", ok: true, status: 200, durationMs: 5 },
            ],
          },
        }),
        colCtx(s.collectionId),
      ),
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.data.source).toBe("cli");
  });

  it("上报结果含 NUL（二进制响应体）时剥除后正常落库", async () => {
    const s = await seedBasic();

    const dispatched = await envelope<RunJob>(
      await dispatchRun(
        authed(`/api/v1/teams/${s.teamId}/runs`, s.apiToken, {
          method: "POST",
          json: { workspaceId: s.workspaceId, targetType: "request", targetId: s.itemId },
        }),
        teamCtx(s.teamId),
      ),
    );
    const claimed = await envelope<{ job: RunnerJobAssignment }>(
      await claimJob(authed("/api/v1/runner/jobs/claim", s.runnerToken, { method: "POST", json: {} }), {}),
    );
    const job = claimed.data.job;

    // 模拟 1x1 PNG 经 from_utf8_lossy 后的响应体：合法 UTF-8 但含 \0
    const pngLike = "�PNG\r\n\0\r\nIHDR\0\0";
    const reported = await envelope(
      await reportResults(
        authed(`/api/v1/runner/jobs/${job.jobId}/results`, s.runnerToken, {
          method: "POST",
          json: {
            results: [
              {
                itemId: s.itemId,
                name: "Binary 1x1 PNG",
                method: "GET",
                url: "http://x/advanced/binary",
                ok: true,
                status: 200,
                durationMs: 3,
                responseHeaders: { "content-type": "image/png" },
                responseBody: pngLike,
              },
            ],
          },
        }),
        jobCtx(job.jobId),
      ),
    );
    expect(reported.status).toBe(200);

    const rows = await db
      .select()
      .from(runJobResults)
      .where(eq(runJobResults.jobId, job.jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responseBody).toBe(pngLike.replace(/\0/g, ""));
    expect(rows[0]!.responseBody).not.toContain("\0");
  });
});

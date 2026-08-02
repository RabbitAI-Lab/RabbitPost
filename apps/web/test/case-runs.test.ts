/**
 * 用例运行历史（lib/case-runs，服务端持久化）回归：
 * loadCaseRuns 读取、saveCaseRun 上报参数映射（single/batch 语义）、summarizeJob 汇总
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteResult, RunJob } from "@rabbitpost/shared";
import { casesApi, runsApi } from "../src/api";
import {
  loadCaseRunDetail,
  loadCaseRuns,
  saveCaseRun,
  summarizeJob,
} from "../src/lib/case-runs";

vi.mock("../src/api", () => ({
  casesApi: {
    listRuns: vi.fn(),
    createRun: vi.fn(),
  },
  runsApi: {
    get: vi.fn(),
  },
}));

const mockedListRuns = vi.mocked(casesApi.listRuns);
const mockedCreateRun = vi.mocked(casesApi.createRun);
const mockedRunsGet = vi.mocked(runsApi.get);

function makeJob(partial: Partial<RunJob>): RunJob {
  return {
    id: partial.id ?? "job-1",
    teamId: "t1",
    workspaceId: "ws1",
    source: "cli",
    collectionId: "col1",
    caseId: partial.caseId ?? null,
    runnerId: null,
    runnerName: null,
    agent: "rabbitpost-web",
    targetType: "case",
    targetId: "i1",
    targetName: partial.targetName ?? "Health Check（全部用例）",
    environmentId: null,
    environmentName: null,
    concurrency: 1,
    status: partial.status ?? "succeeded",
    totalCount: partial.totalCount ?? 2,
    succeededCount: partial.succeededCount ?? 2,
    failedCount: partial.failedCount ?? 0,
    testPassedCount: partial.testPassedCount ?? 0,
    testFailedCount: partial.testFailedCount ?? 0,
    error: null,
    createdBy: "u1",
    claimedAt: null,
    finishedAt: "2026-01-01T00:00:01.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function execResult(ok: boolean): ExecuteResult {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    sizeBytes: 10,
    durationMs: 12,
    testResults: [{ name: "t", passed: ok }],
    consoleLogs: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("case-runs（服务端持久化）", () => {
  it("loadCaseRuns：读取历史并包装为记录视图（结果懒加载）", async () => {
    mockedListRuns.mockResolvedValue([makeJob({ id: "j1" }), makeJob({ id: "j2", caseId: "c1" })]);
    const records = await loadCaseRuns("i1");
    expect(mockedListRuns).toHaveBeenCalledWith("i1", 50);
    expect(records.map((r) => r.job.id)).toEqual(["j1", "j2"]);
    expect(records[0]!.results).toBeUndefined();
  });

  it("loadCaseRunDetail：复用 Runs 详情接口取逐用例结果", async () => {
    mockedRunsGet.mockResolvedValue({
      job: makeJob({ id: "j1" }),
      results: [
        {
          id: "r1", jobId: "j1", itemId: "i1", caseId: "c1", name: "A", method: "GET",
          url: "http://x", ok: true, status: 200, statusText: "OK", sizeBytes: 1,
          durationMs: 1, error: null, testResults: null, consoleLogs: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const results = await loadCaseRunDetail("j1");
    expect(mockedRunsGet).toHaveBeenCalledWith("j1");
    expect(results).toHaveLength(1);
    expect(results[0]!.caseId).toBe("c1");
  });

  it("saveCaseRun single：caseId 必传，报告只含该用例", async () => {
    mockedCreateRun.mockResolvedValue(makeJob({ id: "j1", caseId: "c1" }));
    await saveCaseRun({
      itemId: "i1",
      kind: "single",
      caseId: "c1",
      environmentId: "env1",
      startedAt: 1735689600000,
      entries: [{
        caseId: "c1", caseName: "Smoke A", method: "GET", url: "{{baseUrl}}/health",
        result: execResult(true),
      }],
    });
    expect(mockedCreateRun).toHaveBeenCalledWith("i1", expect.objectContaining({
      kind: "single",
      caseId: "c1",
      environmentId: "env1",
      results: [
        expect.objectContaining({
          caseId: "c1", name: "Smoke A", method: "GET", url: "{{baseUrl}}/health",
          ok: true, status: 200, durationMs: 12,
        }),
      ],
    }));
    // 时间戳转 ISO
    const body = mockedCreateRun.mock.calls[0]![1];
    expect(body.startedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("saveCaseRun batch：job.caseId 为 null，报告含全部用例", async () => {
    mockedCreateRun.mockResolvedValue(makeJob({ id: "j1" }));
    await saveCaseRun({
      itemId: "i1",
      kind: "batch",
      startedAt: 1735689600000,
      entries: [
        { caseId: "c1", caseName: "A", method: "GET", url: "u1", result: execResult(true) },
        { caseId: "c2", caseName: "B", method: "POST", url: "u2", result: execResult(false) },
      ],
    });
    const body = mockedCreateRun.mock.calls[0]![1];
    expect(body.kind).toBe("batch");
    expect(body.caseId).toBeNull();
    expect(body.results.map((r) => r.caseId)).toEqual(["c1", "c2"]);
  });

  it("summarizeJob：基于 job 计数汇总，无需加载结果", () => {
    const sum = summarizeJob(makeJob({
      totalCount: 3, succeededCount: 1, failedCount: 2,
      testPassedCount: 3, testFailedCount: 1,
    }));
    expect(sum).toEqual({ total: 3, passed: 1, failed: 2, testsPassed: 3, testsTotal: 4 });
  });
});

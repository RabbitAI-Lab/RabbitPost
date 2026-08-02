/**
 * 接口用例运行历史：服务端持久化（targetType = "case" 的 run_jobs + run_job_results）。
 * - Run All 一次批量回归聚合为一条记录（job.caseId = null，results 含全部用例）
 * - 单条 Run 各自成一条记录（job.caseId = 该用例）
 * 历史列表 = GET /items/:id/case-runs；展开报告 = GET /runs/:jobId（复用 Runs 详情）。
 */
import type { ExecuteResult, RequestConfig, RunJob, RunJobResult } from "@rabbitpost/shared";
import { casesApi, runsApi } from "../api";

/** 历史面板使用的记录视图：job 概要 + 懒加载的逐用例结果 */
export interface CaseRunRecord {
  job: RunJob;
  /** 点击展开时按需加载；undefined 未加载 */
  results?: RunJobResult[];
}

/** 读取接口的运行历史（新→旧） */
export async function loadCaseRuns(itemId: string): Promise<CaseRunRecord[]> {
  const jobs = await casesApi.listRuns(itemId, 50);
  return jobs.map((job) => ({ job }));
}

/** 加载一条记录的逐用例结果（展开报告时调用） */
export async function loadCaseRunDetail(jobId: string): Promise<RunJobResult[]> {
  const detail = await runsApi.get(jobId);
  return detail.results;
}

export interface CaseRunEntryInput {
  caseId: string;
  caseName: string;
  method: string;
  url: string;
  /** 执行时的请求配置快照（报告展示请求参数） */
  request: RequestConfig;
  result: ExecuteResult;
}

/** 上报一次用例运行（single 单条 / batch Run All 聚合）；失败不阻塞主流程 */
export async function saveCaseRun(args: {
  itemId: string;
  kind: "single" | "batch";
  /** single 时为该用例 id */
  caseId?: string | null;
  environmentId?: string | null;
  startedAt: number;
  entries: CaseRunEntryInput[];
}): Promise<void> {
  const { itemId, kind, caseId, environmentId, startedAt, entries } = args;
  await casesApi.createRun(itemId, {
    kind,
    caseId: kind === "single" ? (caseId ?? null) : null,
    environmentId: environmentId ?? null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    results: entries.map((e) => ({
      itemId,
      caseId: e.caseId,
      name: e.caseName,
      method: e.method,
      url: e.url,
      ok: e.result.ok,
      status: e.result.status ?? null,
      statusText: e.result.statusText ?? null,
      sizeBytes: e.result.sizeBytes ?? null,
      durationMs: e.result.durationMs ?? null,
      error: e.result.error ?? null,
      testResults: e.result.testResults ?? null,
      consoleLogs: e.result.consoleLogs ?? null,
      // 报告展示：请求配置快照 + 响应头/响应体（二进制不存）
      request: e.request,
      responseHeaders: e.result.headers ?? null,
      responseBody: e.result.bodyBase64 ? null : (e.result.bodyText ?? null),
    })),
  });
}

/** 单条记录的汇总：通过/失败数与断言通过情况（基于 job 计数，无需加载结果） */
export function summarizeJob(job: RunJob): {
  total: number;
  passed: number;
  failed: number;
  testsPassed: number;
  testsTotal: number;
} {
  return {
    total: job.totalCount,
    passed: job.succeededCount,
    failed: job.failedCount,
    testsPassed: job.testPassedCount,
    testsTotal: job.testPassedCount + job.testFailedCount,
  };
}

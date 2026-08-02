/**
 * 任务派发与结果等待：将请求执行转为 Runner 任务，同步等待结果返回。
 * 支持单请求（Send）和 Collection 批量执行。
 */
import { eq } from "drizzle-orm";
import type {
  ExecuteResult,
  RequestConfig,
  ResponseCookie,
  RunJob,
  RunJobResult,
  RunnerJobItem,
} from "@rabbitpost/shared";
import { db } from "../db";
import { runJobResults, runJobs, runners } from "../db/schema";
import { HttpError } from "./http";
import {
  collectionIdOfItem,
  expandRunTarget,
  loadRunnerVariables,
  toRunJob,
  toRunJobResult,
} from "./runner";
import { selectRunnerForJob } from "./embedded-runner";

const DEFAULT_TIMEOUT_MS = 60_000; // 默认 60 秒超时
const POLL_INTERVAL_MS = 50; // 50ms 轮询间隔

export interface DispatchOptions {
  workspaceId: string;
  teamId: string;
  userId: string;
  targetType: "request" | "collection" | "scenario";
  targetId: string;
  targetName: string;
  environmentId: string | null;
  /** 单请求执行时直接传入配置，跳过 expand */
  requestConfig?: RequestConfig;
  /** 超时时间（毫秒），默认 60s */
  timeoutMs?: number;
}

/**
 * 派发任务并同步等待结果。
 * 用于 Send 按钮等需要实时响应的场景。
 */
export async function dispatchAndWait(options: DispatchOptions): Promise<ExecuteResult> {
  const {
    workspaceId,
    teamId,
    userId,
    targetType,
    targetId,
    targetName,
    environmentId,
    requestConfig,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // 1. 选择 Runner（外部优先）
  const selectedRunner = await selectRunnerForJob(teamId);
  if (!selectedRunner) {
    throw new HttpError(503, "NO_RUNNER_AVAILABLE", "No runner available for this team");
  }

  // 2. 准备执行项
  let items: RunnerJobItem[];
  let variables: Record<string, string>;

  if (requestConfig) {
    // 单请求直接执行：不查库展开，直接用传入的配置
    items = [{
      itemId: null,
      caseId: null,
      name: targetName,
      request: requestConfig,
    }];
    // targetId 为请求条目 id 时，解析所属 Collection 以加载 Collection 级变量
    const colId = await collectionIdOfItem(targetId);
    variables = await loadRunnerVariables(environmentId, colId);
  } else {
    // 从库中展开目标（Collection 或已保存的请求）
    const target = await expandRunTarget(targetType, targetId);
    items = target.items;
    variables = await loadRunnerVariables(environmentId, target.collectionId);
  }

  // 3. 创建任务
  const [job] = await db
    .insert(runJobs)
    .values({
      teamId,
      workspaceId,
      source: "dispatch",
      runnerId: selectedRunner.id, // 指定 Runner，确保被选中者领取
      targetType,
      targetId,
      targetName,
      environmentId,
      requestConfig: requestConfig ?? null, // 存储请求配置快照
      concurrency: 1, // 单请求执行，并发为 1
      status: "queued",
      totalCount: items.length,
      createdBy: userId,
    })
    .returning();

  if (!job) throw new Error("Failed to create run job");

  // 4. 轮询等待结果
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const [currentJob] = await db
      .select()
      .from(runJobs)
      .where(eq(runJobs.id, job.id))
      .limit(1);

    if (!currentJob) {
      throw new HttpError(404, "JOB_NOT_FOUND", "Run job not found");
    }

    // 终态：成功或失败
    if (currentJob.status === "succeeded" || currentJob.status === "failed") {
      const results = await db
        .select()
        .from(runJobResults)
        .where(eq(runJobResults.jobId, job.id))
        .orderBy(runJobResults.createdAt);

      if (results.length === 0 || !results[0]) {
        throw new HttpError(500, "NO_RESULTS", "Job finished but no results found");
      }

      // 转换为 ExecuteResult 格式
      return convertToExecuteResult(toRunJob(currentJob, selectedRunner.name), toRunJobResult(results[0]));
    }

    // 取消或超时
    if (currentJob.status === "canceled") {
      throw new HttpError(499, "JOB_CANCELED", "Job was canceled");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // 超时：标记任务为取消，抛出超时错误
  await db
    .update(runJobs)
    .set({ status: "canceled", error: "Execution timeout", finishedAt: new Date() })
    .where(eq(runJobs.id, job.id));

  throw new HttpError(504, "EXECUTION_TIMEOUT", `Execution timeout after ${timeoutMs}ms`);
}

/**
 * 将 RunJob + RunJobResult 转换为 ExecuteResult（与 executor.ts 返回格式一致）。
 */
function convertToExecuteResult(job: RunJob, result: RunJobResult): ExecuteResult {
  // 如果 Runner 上报了错误
  if (result.error) {
    return {
      ok: false,
      error: result.error,
      durationMs: result.durationMs ?? 0,
      testResults: result.testResults ?? [],
      consoleLogs: result.consoleLogs ?? [],
    };
  }

  // 正常响应
  const headers = result.responseHeaders ?? {};
  return {
    ok: result.ok,
    status: result.status ?? undefined,
    statusText: result.statusText ?? undefined,
    headers,
    bodyText: result.responseBody ?? undefined,
    sizeBytes: result.sizeBytes ?? undefined,
    durationMs: result.durationMs ?? 0,
    testResults: result.testResults ?? [],
    consoleLogs: result.consoleLogs ?? [],
    // 从响应的 Set-Cookie 头解析结构化 Cookie（Runner 合并后以 ", " 分隔）
    cookies: parseResponseCookies(headers["set-cookie"]),
  };
}

/**
 * 将合并后的 Set-Cookie 字符串拆分为单条 Cookie 原文，再逐条解析。
 * 多条 Set-Cookie 在 HTTP 层以 ", " 分隔，但 expires 日期也含 ", "（如 "Thu, 31-Dec-37"），
 * 因此用启发式：仅在 ", " 后面的片段看起来像 "name=value"（= 出现在 ; 之前）时才拆分。
 */
function splitJoinedSetCookies(joined: string): string[] {
  const cookies: string[] = [];
  let current = "";
  for (const part of joined.split(", ")) {
    const eq = part.indexOf("=");
    const semi = part.indexOf(";");
    // 看起来像新 Cookie 起始：含 = 且 = 在 ; 之前（或无 ;）
    const looksLikeNewCookie = eq > 0 && (semi === -1 || eq < semi);
    if (looksLikeNewCookie && current) {
      cookies.push(current.trim());
      current = part;
    } else {
      current = current ? `${current}, ${part}` : part;
    }
  }
  if (current.trim()) cookies.push(current.trim());
  return cookies;
}

/** 与 executor.ts 的 parseSetCookies 等价的 Runner 路径实现 */
function parseResponseCookies(setCookieHeader?: string): ResponseCookie[] {
  if (!setCookieHeader) return [];
  const raws = splitJoinedSetCookies(setCookieHeader);
  const cookies: ResponseCookie[] = [];
  for (const raw of raws) {
    const segments = raw.split(";").map((s) => s.trim());
    const first = segments.shift();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const cookie: ResponseCookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
    };
    for (const seg of segments) {
      const i = seg.indexOf("=");
      const attr = (i === -1 ? seg : seg.slice(0, i)).trim().toLowerCase();
      const val = i === -1 ? "" : seg.slice(i + 1).trim();
      switch (attr) {
        case "domain": cookie.domain = val; break;
        case "path": cookie.path = val; break;
        case "expires": cookie.expires = val; break;
        case "max-age": {
          const n = Number(val);
          if (Number.isFinite(n)) cookie.maxAge = n;
          break;
        }
        case "httponly": cookie.httpOnly = true; break;
        case "secure": cookie.secure = true; break;
        case "samesite": cookie.sameSite = val; break;
      }
    }
    cookies.push(cookie);
  }
  return cookies;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 异步派发（不等待结果，用于 Collection Run 等场景）
// ---------------------------------------------------------------------------

export interface DispatchAsyncOptions extends Omit<DispatchOptions, "timeoutMs"> {
  concurrency?: number;
}

/**
 * 异步派发任务，立即返回 Job ID，不等待结果。
 * 用于 Collection Run / Scenario Run 等后台执行场景。
 */
export async function dispatchAsync(options: DispatchAsyncOptions): Promise<RunJob> {
  const {
    workspaceId,
    teamId,
    userId,
    targetType,
    targetId,
    targetName,
    environmentId,
    concurrency = 4,
  } = options;

  // 选择 Runner（外部优先）
  const selectedRunner = await selectRunnerForJob(teamId);
  if (!selectedRunner) {
    throw new HttpError(503, "NO_RUNNER_AVAILABLE", "No runner available for this team");
  }

  // 展开目标
  const target = await expandRunTarget(targetType, targetId);

  // 场景测试强制串行执行
  const effectiveConcurrency = targetType === "scenario" ? 1 : concurrency;

  // 创建任务
  const [job] = await db
    .insert(runJobs)
    .values({
      teamId,
      workspaceId,
      source: "dispatch",
      runnerId: selectedRunner.id,
      targetType,
      targetId,
      targetName,
      environmentId,
      concurrency: effectiveConcurrency,
      status: "queued",
      totalCount: target.items.length,
      createdBy: userId,
    })
    .returning();

  if (!job) throw new Error("Failed to create run job");
  return toRunJob(job, selectedRunner.name);
}

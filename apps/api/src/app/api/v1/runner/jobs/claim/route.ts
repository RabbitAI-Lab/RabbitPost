import { eq, sql } from "drizzle-orm";
import type { RequestConfig, RunnerJobAssignment, RunnerJobItem, RunTargetType } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems, runJobs } from "../../../../../../db/schema";
import { ok } from "../../../../../../lib/http";
import {
  collectionIdOfItem,
  expandRunTarget,
  handleRunnerRoute,
  loadRunnerVariables,
} from "../../../../../../lib/runner";

/** 原生 SQL 返回的列名为 snake_case，单独声明以免与 drizzle 的 camelCase 推断混淆 */
interface ClaimedJobRow {
  id: string;
  workspace_id: string;
  target_type: RunTargetType;
  target_id: string;
  target_name: string;
  environment_id: string | null;
  request_config: RequestConfig | null;
  concurrency: number;
  total_count: number;
}

/**
 * POST /api/v1/runner/jobs/claim
 * 领取一个待执行任务：FOR UPDATE SKIP LOCKED 保证多 Runner 并发拉取时不会重复领取。
 * 队列为空时返回 { job: null }，由 Runner 侧退避轮询。
 */
export const POST = handleRunnerRoute(async (_req, _ctx, runner) => {
  // Runner 全局共享：不按 team_id 隔离，任何 Runner 都能领取任意团队的 queued 任务。
  // runner_id is null 表示未指定 Runner（任意可领）；runner_id 匹配则只由该 Runner 领取。
  const claimed = await db.execute(sql`
    update run_jobs
       set status = 'running',
           runner_id = ${runner.id},
           claimed_at = now()
     where id = (
       select id from run_jobs
        where status = 'queued'
          and (runner_id is null or runner_id = ${runner.id})
        order by created_at
        for update skip locked
        limit 1
     )
    returning *
  `);
  const job = (claimed.rows as unknown as ClaimedJobRow[])[0];
  if (!job) return ok<{ job: null }>({ job: null });

  try {
    // 目标可能在派发后被改动，这里按最新内容展开（与手动执行看到的一致）
    // 队列里只会有 request / collection（case 历史不经派发），收窄类型
    let items: RunnerJobItem[];
    let variables: Record<string, string>;

    // 检查是否是直接传入请求配置的单请求执行（target_id 是随机 UUID，不在库中）
    const [existingItem] = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(eq(collectionItems.id, job.target_id))
      .limit(1);

    if (job.target_type === "request" && !existingItem) {
      // 单请求直接执行：从任务快照中读取请求配置
      if (!job.request_config) {
        throw new Error("Request config not found in job snapshot");
      }
      items = [{
        itemId: null,
        caseId: null,
        name: job.target_name,
        request: job.request_config,
      }];
      // target_id 为请求条目 id 时，解析所属 Collection 以加载 Collection 级变量
      const colId = await collectionIdOfItem(job.target_id);
      variables = await loadRunnerVariables(job.environment_id, colId);
    } else {
      const target = await expandRunTarget(
        job.target_type as "request" | "collection" | "scenario",
        job.target_id,
      );
      items = target.items;
      variables = await loadRunnerVariables(job.environment_id, target.collectionId);
    }

    // 请求数可能变化，回填以保证进度显示准确
    if (items.length !== job.total_count) {
      await db
        .update(runJobs)
        .set({ totalCount: items.length })
        .where(eq(runJobs.id, job.id));
    }

    const assignment: RunnerJobAssignment = {
      jobId: job.id,
      workspaceId: job.workspace_id,
      targetType: job.target_type,
      targetName: job.target_name,
      concurrency: job.concurrency,
      variables,
      items,
    };
    return ok<{ job: RunnerJobAssignment }>({ job: assignment });
  } catch (e) {
    // 展开失败（目标被删除等）：任务直接判失败并原文记录原因，避免卡在 running
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(runJobs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(runJobs.id, job.id));
    throw e;
  }
});

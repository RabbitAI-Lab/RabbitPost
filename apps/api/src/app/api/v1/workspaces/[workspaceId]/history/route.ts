import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { HistoryEntry } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { histories } from "../../../../../../db/schema";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ workspaceId: string }> };

const MAX_LIMIT = 200;

/** GET /api/v1/workspaces/:workspaceId/history?limit=50&offset=0 — 按时间倒序 */
export const GET = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_LIMIT);
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;

  const rows = await db
    .select()
    .from(histories)
    .where(eq(histories.workspaceId, workspaceId))
    .orderBy(desc(histories.createdAt))
    .limit(limit)
    .offset(offset);

  const entries: HistoryEntry[] = rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    name: row.name,
    request: row.request,
    response: row.response,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }));
  return ok(entries);
});

/** DELETE /api/v1/workspaces/:workspaceId/history — 清空历史（editor+） */
export const DELETE = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  await db.delete(histories).where(eq(histories.workspaceId, workspaceId));
  return ok({ cleared: true });
});

// request/response 为 jsonb 快照（RequestConfig / HistoryResponseSummary），
// 上报场景下由客户端本地执行产生，服务端只做最小形状校验后原样落库
const reportSchema = z.object({
  name: z.string().max(256).nullable().optional(),
  request: z
    .object({ method: z.string().min(1), url: z.string() })
    .passthrough(),
  response: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
});

/**
 * POST /api/v1/workspaces/:workspaceId/history — 客户端上报一条历史。
 * 用于桌面端 local-agent 本地执行（请求不经过服务器）后回传执行结果，
 * 与服务端执行时 executor 自动落库的行为保持一致（失败也记录）。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const input = reportSchema.parse(await req.json());

  const [row] = await db
    .insert(histories)
    .values({
      workspaceId,
      userId: user.id,
      name: input.name ?? null,
      request: input.request as unknown as HistoryEntry["request"],
      response: (input.response ?? null) as HistoryEntry["response"],
      error: input.error ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to insert history");

  const entry: HistoryEntry = {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    name: row.name,
    request: row.request,
    response: row.response,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
  return ok(entry);
});

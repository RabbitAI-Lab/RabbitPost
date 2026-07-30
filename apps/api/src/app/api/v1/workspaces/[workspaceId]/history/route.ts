import { desc, eq } from "drizzle-orm";
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

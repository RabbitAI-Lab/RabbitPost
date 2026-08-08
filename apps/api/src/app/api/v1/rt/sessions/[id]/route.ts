import { handleRoute, ok, requireWorkspaceRole } from "../../../../../../lib/http";
import { closeRtSession, getRtSession } from "../../../../../../lib/rt";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/rt/sessions/:id
 * 关闭 rt session：通知 runner 断开目标连接并清理内存状态。
 */
export const DELETE = handleRoute(async (_req, ctx: Ctx, user) => {
  const { id } = await ctx.params;
  const { workspaceId } = getRtSession(id);
  await requireWorkspaceRole(workspaceId, user.id, "viewer");
  closeRtSession(id);
  return ok({ closed: true });
});

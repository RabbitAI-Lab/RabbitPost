import { z } from "zod";
import type { ResolvedDbConnection } from "@rabbitpost/shared";
import { loadWorkspaceDbConnections } from "../../../../../lib/db-connections";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../lib/http";

const resolveSchema = z.object({
  workspaceId: z.string().uuid(),
  environmentId: z.string().uuid().nullable().optional(),
});

/**
 * POST /api/v1/db-connections/resolve — 解密并返回执行期连接（含明文密码）。
 * 仅供 local-agent / runner 执行路径调用（浏览器直连本机 agent 时由 web 拉取后随
 * execute payload 明文下发，与 variables 现状一致）；服务端执行不需要此端点。
 * 要求 editor+ 角色。
 */
export const POST = handleRoute(async (req, _ctx, user) => {
  const body = resolveSchema.parse(await req.json());
  await requireWorkspaceRole(body.workspaceId, user.id, "editor");
  const connections: ResolvedDbConnection[] = await loadWorkspaceDbConnections(
    body.workspaceId,
    body.environmentId,
  );
  return ok(connections);
});

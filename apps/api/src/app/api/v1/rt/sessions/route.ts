import { z } from "zod";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../lib/http";
import { createRtSession, RT_PROTOCOLS } from "../../../../../lib/rt";

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  protocol: z.enum(RT_PROTOCOLS),
  url: z.string().min(1).max(4096),
  /** 各协议连接配置（headers / 子协议等），由 runner 侧协议客户端自行解释 */
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/v1/rt/sessions
 * 创建长连接协议 session 并指派给一条持有 rt link 的 runner；
 * 无可用 runner → 503 NO_RUNNER_AVAILABLE。
 */
export const POST = handleRoute(async (req, _ctx, user) => {
  const input = createSchema.parse(await req.json());
  // viewer 也允许建立连接（与一次性请求执行一致）
  await requireWorkspaceRole(input.workspaceId, user.id, "viewer");
  const { sessionId } = createRtSession({
    workspaceId: input.workspaceId,
    protocol: input.protocol,
    url: input.url,
    config: input.config,
  });
  return ok({ sessionId });
});

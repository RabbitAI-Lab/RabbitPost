import { z } from "zod";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../../../lib/http";
import { getRtSession, sendToRtSession } from "../../../../../../../lib/rt";

const sendSchema = z.object({
  data: z.string().max(1024 * 1024),
  encoding: z.enum(["text", "base64"]).default("text"),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/rt/sessions/:id/send
 * 浏览器上行：经该 session 所属 runner 的 downlink 转发给目标连接。
 */
export const POST = handleRoute(async (req, ctx: Ctx, user) => {
  const { id } = await ctx.params;
  const input = sendSchema.parse(await req.json());
  const { workspaceId } = getRtSession(id);
  await requireWorkspaceRole(workspaceId, user.id, "viewer");
  sendToRtSession(id, input.data, input.encoding);
  return ok({ sent: true });
});

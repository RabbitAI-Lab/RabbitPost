import { z } from "zod";
import { ok } from "../../../../../../lib/http";
import { pushRtEvent, type RtServerMessage } from "../../../../../../lib/rt";
import { handleRunnerRoute } from "../../../../../../lib/runner";

const eventSchema = z.object({
  sessionId: z.string().min(1).max(128),
  /** ServerMessage 形状（status/message/error）；id 由 api 盖章为 sessionId */
  event: z.record(z.string(), z.unknown()),
});

/**
 * POST /api/v1/runner/rt/event
 * runner 上行：把一条 session 事件写入该 session 的 SSE 队列，推给浏览器。
 */
export const POST = handleRunnerRoute(async (req, _ctx, _runner) => {
  const input = eventSchema.parse(await req.json());
  pushRtEvent(input.sessionId, input.event as Omit<RtServerMessage, "id">);
  return ok({ delivered: true });
});

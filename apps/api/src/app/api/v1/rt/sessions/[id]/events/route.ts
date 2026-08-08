import { handleRoute, requireWorkspaceRole } from "../../../../../../../lib/http";
import { getRtSession, subscribeRtSession, type RtServerMessage } from "../../../../../../../lib/rt";

/** SSE 保活间隔：15s 一条注释行，防止代理/浏览器空闲断连 */
const PING_INTERVAL_MS = 15_000;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/rt/sessions/:id/events
 * 浏览器下行：SSE 流，把该 session 的事件（ServerMessage 形状）逐条
 * `data: {json}\n\n` 推给浏览器。Next.js route handler 不支持 WS upgrade，
 * 故浏览器下行用 SSE、上行用 POST。
 */
export const GET = handleRoute(async (_req, ctx: Ctx, user) => {
  const { id } = await ctx.params;
  const { workspaceId } = getRtSession(id);
  await requireWorkspaceRole(workspaceId, user.id, "viewer");

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribeRtSession(id, (msg: RtServerMessage) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
      });
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // 流已被取消：清掉定时器即可
          if (ping) clearInterval(ping);
        }
      }, PING_INTERVAL_MS);
    },
    cancel() {
      // 浏览器断开：退订并停止保活（session 本身保留，由 DELETE 或 runner 断线清理）
      if (ping) clearInterval(ping);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 禁止 nginx 等中间层缓冲，保证事件实时到达
      "X-Accel-Buffering": "no",
    },
  });
});

export const dynamic = "force-dynamic";

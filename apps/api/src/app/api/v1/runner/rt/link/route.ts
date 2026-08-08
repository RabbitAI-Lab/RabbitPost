import { getEmbeddedRunnerId } from "../../../../../../lib/embedded-runner";
import { registerRtLink, type RtCommand } from "../../../../../../lib/rt";
import { handleRunnerRoute } from "../../../../../../lib/runner";

/** downlink 保活间隔：15s 一个空行（NDJSON 中的空行，runner 侧读行时跳过） */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * GET /api/v1/runner/rt/link
 * runner 保持的 downlink 长连接：chunked NDJSON，每行一条指令
 * （{"cmd":"start",...} / {"cmd":"send",...} / {"cmd":"close",...}）。
 * 断线时 api 会把该 runner 名下 session 全部置为 error 并通知对应 SSE。
 */
export const GET = handleRunnerRoute(async (req, _ctx, runner) => {
  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (cmd: RtCommand): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(cmd)}\n`));
          return true;
        } catch {
          return false;
        }
      };
      unregister = registerRtLink(runner.id, runner.id === getEmbeddedRunnerId(), write);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cleanup();
    },
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    // 注销并把该 runner 名下 session 全部置为 error
    unregister?.();
  };

  // runner 主动断开（请求中止）时同样清理
  req.signal.addEventListener("abort", cleanup, { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});

export const dynamic = "force-dynamic";

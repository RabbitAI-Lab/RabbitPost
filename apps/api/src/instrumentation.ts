/**
 * Next.js instrumentation：服务启动时初始化内嵌 Runner。
 * 仅在 Node.js 运行时执行（非 Edge）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmbeddedRunner } = await import("./lib/embedded-runner");
    const { getDefaultTeamId, getSystemUserId } = await import("./lib/system");

    try {
      const teamId = await getDefaultTeamId();
      const userId = await getSystemUserId();
      await startEmbeddedRunner(teamId, userId);
      console.log("[instrumentation] embedded runner started");
    } catch (e) {
      console.error("[instrumentation] failed to start embedded runner:", e);
      // 不阻断服务启动，Runner 可稍后手动启动
    }
  }
}

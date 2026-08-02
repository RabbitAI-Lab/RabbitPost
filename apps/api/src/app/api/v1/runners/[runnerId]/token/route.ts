import { eq } from "drizzle-orm";
import type { RunnerWithToken } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { runners } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireTeamRole,
} from "../../../../../../lib/http";
import { isEmbeddedRunner } from "../../../../../../lib/embedded-runner";
import { issueRunnerToken, toRunner } from "../../../../../../lib/runner";
import { getTeamOrgId, notifyOrgAdmins } from "../../../../../../lib/org";

type Ctx = { params: Promise<{ runnerId: string }> };

/**
 * POST /api/v1/runners/:runnerId/token — 重新生成 Token（admin+）
 * 旧 Token 立即失效；新明文 Token 仅此一次返回。
 */
export const POST = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { runnerId } = await ctx.params;
  const [existing] = await db
    .select()
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!existing) throw new HttpError(404, "NOT_FOUND", "Runner not found");
  await requireTeamRole(existing.teamId, user.id, "admin");
  // 内嵌 Runner 的 Token 由服务启动时自动签发，重置会令进程失联并陷入重启循环
  if (isEmbeddedRunner(existing.name)) {
    throw new HttpError(
      403,
      "EMBEDDED_RUNNER_PROTECTED",
      "Embedded runner token is managed by the server and cannot be regenerated",
    );
  }

  const { token, tokenHash, tokenPrefix } = issueRunnerToken();
  const [row] = await db
    .update(runners)
    .set({ tokenHash, tokenPrefix, updatedAt: new Date() })
    .where(eq(runners.id, runnerId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Runner not found");

  // 通知企业管理员
  const orgId = await getTeamOrgId(existing.teamId);
  if (orgId) {
    await notifyOrgAdmins({
      orgId,
      actorId: user.id,
      title: "Runner Token 重置",
      body: `Runner「${existing.name}」的 Token 已被重置，旧 Token 立即失效`,
      teamId: existing.teamId,
    });
  }

  return ok<RunnerWithToken>({ runner: toRunner(row), token });
});

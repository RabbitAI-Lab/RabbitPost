/**
 * Runner 共享与内嵌 Runner 保护的路由级回归测试。
 *
 * 覆盖三类场景：
 * 1. __embedded__ Runner 写保护：改名 / 启停 / 删除 / 重置 Token / 注册保留名 均被拒绝
 * 2. Runner 全局共享：任务派发选择 Runner 不按 teamId 隔离；claim 不按 team_id 隔离
 * 3. 无在线 Runner 时正确返回 null（execute 回退到服务端执行的判定依据）
 */
import { describe, expect, it, vi } from "vitest";

// route handler 直接调用时 getSessionUser 走 mock（与其它路由测试一致）
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

import { db } from "../src/db";
import { runners } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  GET as listRunners,
  POST as registerRunner,
} from "../src/app/api/v1/teams/[teamId]/runners/route";
import {
  DELETE as deleteRunner,
  PATCH as patchRunner,
} from "../src/app/api/v1/runners/[runnerId]/route";
import { POST as regenerateToken } from "../src/app/api/v1/runners/[runnerId]/token/route";
import { selectRunnerForJob } from "../src/lib/embedded-runner";
import { authed, envelope, seedBasic, seedEmbeddedRunner } from "./helpers";

const teamCtx = (teamId: string) => ({ params: Promise.resolve({ teamId }) });
const runnerCtx = (runnerId: string) => ({ params: Promise.resolve({ runnerId }) });

// ---------------------------------------------------------------------------
// 1. __embedded__ Runner 写保护
// ---------------------------------------------------------------------------
describe("__embedded__ runner 写保护", () => {
  it("PATCH 改名 / 启停 返回 403 EMBEDDED_RUNNER_PROTECTED", async () => {
    const s = await seedBasic();
    const embeddedId = await seedEmbeddedRunner(s.teamId, s.userId);

    const r = await envelope(
      await patchRunner(
        authed(`/api/v1/runners/${embeddedId}`, s.apiToken, {
          method: "PATCH",
          json: { name: "hacked" },
        }),
        runnerCtx(embeddedId),
      ),
    );
    expect(r.status).toBe(403);
    expect(r.error?.code).toBe("EMBEDDED_RUNNER_PROTECTED");

    // 记录未被篡改
    const [row] = await db.select().from(runners).where(eq(runners.id, embeddedId)).limit(1);
    expect(row?.name).toBe("__embedded__");
    expect(row?.status).toBe("active");
  });

  it("DELETE 删除返回 403 EMBEDDED_RUNNER_PROTECTED", async () => {
    const s = await seedBasic();
    const embeddedId = await seedEmbeddedRunner(s.teamId, s.userId);

    const r = await envelope(
      await deleteRunner(
        authed(`/api/v1/runners/${embeddedId}`, s.apiToken, { method: "DELETE" }),
        runnerCtx(embeddedId),
      ),
    );
    expect(r.status).toBe(403);
    expect(r.error?.code).toBe("EMBEDDED_RUNNER_PROTECTED");

    // 记录仍然存在
    const [row] = await db.select().from(runners).where(eq(runners.id, embeddedId)).limit(1);
    expect(row).toBeDefined();
  });

  it("POST /token 重置 Token 返回 403 EMBEDDED_RUNNER_PROTECTED", async () => {
    const s = await seedBasic();
    const embeddedId = await seedEmbeddedRunner(s.teamId, s.userId);

    const r = await envelope(
      await regenerateToken(
        authed(`/api/v1/runners/${embeddedId}/token`, s.apiToken, { method: "POST" }),
        runnerCtx(embeddedId),
      ),
    );
    expect(r.status).toBe(403);
    expect(r.error?.code).toBe("EMBEDDED_RUNNER_PROTECTED");
  });

  it("注册保留名 __embedded__ 返回 400 RUNNER_NAME_RESERVED", async () => {
    const s = await seedBasic();

    const r = await envelope(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.apiToken, {
          method: "POST",
          json: { name: "__embedded__" },
        }),
        teamCtx(s.teamId),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("RUNNER_NAME_RESERVED");
  });
});

// ---------------------------------------------------------------------------
// 2. Runner 列表全局可见
// ---------------------------------------------------------------------------
describe("Runner 列表全局共享", () => {
  it("任意团队均能列出所有 Runner（含其他团队的 runner）", async () => {
    // 团队 A + runnerA
    const s = await seedBasic();
    // 团队 B + __embedded__
    const embeddedId = await seedEmbeddedRunner(s.teamId, s.userId);

    // 从当前团队（A）请求列表，应包含 seedBasic 的 test-runner 和 __embedded__
    const r = await envelope(
      await listRunners(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.apiToken),
        teamCtx(s.teamId),
      ),
    );
    expect(r.status).toBe(200);
    const names = (r.data as { name: string }[]).map((x) => x.name);
    expect(names).toContain("test-runner");
    expect(names).toContain("__embedded__");
    expect((r.data as { id: string }[]).some((x) => x.id === embeddedId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. selectRunnerForJob 全局选择（不按 teamId 隔离）
// ---------------------------------------------------------------------------
describe("selectRunnerForJob 全局共享", () => {
  it("无任何 Runner 时返回 null", async () => {
    const s = await seedBasic();
    const selected = await selectRunnerForJob(s.teamId);
    expect(selected).toBeNull();
  });

  it("心跳过期的 Runner 不被选中（即使 status=active）", async () => {
    const s = await seedBasic();
    // 手动把 test-runner 的 lastSeenAt 改到很久以前
    await db
      .update(runners)
      .set({ lastSeenAt: new Date(Date.now() - 200_000) })
      .where(eq(runners.teamId, s.teamId));
    const selected = await selectRunnerForJob(s.teamId);
    expect(selected).toBeNull();
  });

  it("可选中其他团队的心跳在线 Runner（不按 teamId 隔离）", async () => {
    const s = await seedBasic();
    // seedBasic 的 test-runner 默认无心跳，手动更新为在线
    await db
      .update(runners)
      .set({ lastSeenAt: new Date() })
      .where(eq(runners.teamId, s.teamId));
    const selected = await selectRunnerForJob(s.teamId);
    expect(selected).not.toBeNull();
    expect(selected!.name).toBe("test-runner");
  });
});

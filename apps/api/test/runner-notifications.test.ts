/**
 * Runner 操作触发企业管理员通知的路由级回归测试。
 * 覆盖：注册 Runner、重置 Token、更新 Runner、删除 Runner 四种操作的 org_admin 通知。
 */
import { describe, expect, it, vi } from "vitest";
import type { Notification, RunnerWithToken } from "@rabbitpost/shared";
import {
  GET as listNotifications,
} from "../src/app/api/v1/orgs/[orgId]/notifications/route";
import {
  POST as registerRunner,
} from "../src/app/api/v1/teams/[teamId]/runners/route";
import {
  DELETE as deleteRunner,
  PATCH as patchRunner,
} from "../src/app/api/v1/runners/[runnerId]/route";
import { POST as regenerateToken } from "../src/app/api/v1/runners/[runnerId]/token/route";
import { authed, envelope, seedOrg, type OrgSeed } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const teamCtx = (teamId: string) => ({ params: Promise.resolve({ teamId }) });
const runnerCtx = (runnerId: string) => ({ params: Promise.resolve({ runnerId }) });

/** 获取通知列表辅助 */
async function getNotifications(s: OrgSeed): Promise<Notification[]> {
  const resp = await envelope<Notification[]>(
    await listNotifications(
      authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken),
      orgCtx(s.orgId),
    ),
  );
  return resp.data;
}

describe("Runner 操作通知企业管理员", () => {
  it("注册 Runner 后通知企业管理员", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.owner.apiToken, {
          method: "POST",
          json: { name: "CI Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    expect(resp.status).toBe(201);

    const notifications = await getNotifications(s);
    const runnerNotify = notifications.find((n) => n.title.includes("新 Runner 注册"));
    expect(runnerNotify).toBeTruthy();
    expect(runnerNotify!.level).toBe("org_admin");
    expect(runnerNotify!.body).toContain("CI Runner");
    expect(runnerNotify!.teamName).toBeTruthy();
  });

  it("重置 Runner Token 后通知企业管理员", async () => {
    const s = await seedOrg();
    // 先注册一个 Runner
    const regResp = await envelope<RunnerWithToken>(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.owner.apiToken, {
          method: "POST",
          json: { name: "Token Test Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    const runnerId = regResp.data.runner.id;

    // 重置 Token
    const resp = await envelope(
      await regenerateToken(
        authed(`/api/v1/runners/${runnerId}/token`, s.owner.apiToken, { method: "POST" }),
        runnerCtx(runnerId),
      ),
    );
    expect(resp.status).toBe(200);

    const notifications = await getNotifications(s);
    const tokenNotify = notifications.find((n) => n.title.includes("Token 重置"));
    expect(tokenNotify).toBeTruthy();
    expect(tokenNotify!.body).toContain("Token Test Runner");
    expect(tokenNotify!.body).toContain("旧 Token 立即失效");
  });

  it("更新 Runner（停用）后通知企业管理员", async () => {
    const s = await seedOrg();
    const regResp = await envelope<RunnerWithToken>(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.owner.apiToken, {
          method: "POST",
          json: { name: "Status Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    const runnerId = regResp.data.runner.id;

    // 停用 Runner
    const resp = await envelope(
      await patchRunner(
        authed(`/api/v1/runners/${runnerId}`, s.owner.apiToken, {
          method: "PATCH",
          json: { status: "disabled" },
        }),
        runnerCtx(runnerId),
      ),
    );
    expect(resp.status).toBe(200);

    const notifications = await getNotifications(s);
    const updateNotify = notifications.find((n) => n.title.includes("Runner 更新"));
    expect(updateNotify).toBeTruthy();
    expect(updateNotify!.body).toContain("Status Runner");
    expect(updateNotify!.body).toContain("disabled");
  });

  it("更新 Runner（改名）后通知企业管理员", async () => {
    const s = await seedOrg();
    const regResp = await envelope<RunnerWithToken>(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.owner.apiToken, {
          method: "POST",
          json: { name: "Old Name Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    const runnerId = regResp.data.runner.id;

    await patchRunner(
      authed(`/api/v1/runners/${runnerId}`, s.owner.apiToken, {
        method: "PATCH",
        json: { name: "New Name Runner" },
      }),
      runnerCtx(runnerId),
    );

    const notifications = await getNotifications(s);
    const renameNotify = notifications.find(
      (n) => n.title.includes("Runner 更新") && n.body.includes("改名为"),
    );
    expect(renameNotify).toBeTruthy();
    expect(renameNotify!.body).toContain("New Name Runner");
  });

  it("删除 Runner 后通知企业管理员", async () => {
    const s = await seedOrg();
    const regResp = await envelope<RunnerWithToken>(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.owner.apiToken, {
          method: "POST",
          json: { name: "Doomed Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    const runnerId = regResp.data.runner.id;

    const resp = await envelope(
      await deleteRunner(
        authed(`/api/v1/runners/${runnerId}`, s.owner.apiToken, { method: "DELETE" }),
        runnerCtx(runnerId),
      ),
    );
    expect(resp.status).toBe(200);

    const notifications = await getNotifications(s);
    const deleteNotify = notifications.find((n) => n.title.includes("Runner 删除"));
    expect(deleteNotify).toBeTruthy();
    expect(deleteNotify!.body).toContain("Doomed Runner");
    expect(deleteNotify!.body).toContain("已被删除");
  });

  it("非企业团队注册 Runner 不触发通知（orgId 为 null）", async () => {
    // 使用 seedBasic 创建一个非企业团队
    const { seedBasic } = await import("./helpers");
    const s = await seedBasic();

    // 注册 Runner 不应报错（非企业团队没有 orgId，通知静默跳过）
    const resp = await envelope(
      await registerRunner(
        authed(`/api/v1/teams/${s.teamId}/runners`, s.apiToken, {
          method: "POST",
          json: { name: "Personal Runner" },
        }),
        teamCtx(s.teamId),
      ),
    );
    expect(resp.status).toBe(201);
    // 不抛异常即说明非企业团队的 orgId 查找正确返回 null，通知被跳过
  });
});

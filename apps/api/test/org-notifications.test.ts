/**
 * 企业通知 + 团队详情/成员管理的路由级回归测试。
 * 覆盖：
 *   - 创建团队时通知企业管理员
 *   - 添加/移除团队成员时通知团队管理员
 *   - 通知列表、标记已读
 *   - 团队详情（含 Team Admin 列表）
 *   - 团队成员管理（添加/角色变更/移除）
 *   - 权限（非企业成员/角色不足/跨企业）
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Notification, TeamMember } from "@rabbitpost/shared";
import { db } from "../src/db";
import { notifications, teamMembers, users } from "../src/db/schema";
import {
  GET as listNotifications,
  PATCH as markNotificationsRead,
} from "../src/app/api/v1/orgs/[orgId]/notifications/route";
import {
  DELETE as deleteTeamMember,
  GET as getTeamDetail,
  PATCH as patchTeamMember,
  POST as addTeamMember,
} from "../src/app/api/v1/orgs/[orgId]/teams/[teamId]/route";
import { POST as createOrgTeam } from "../src/app/api/v1/orgs/[orgId]/teams/route";
import { authed, envelope, seedNonOrgToken, seedOrg, seedOtherOrg, type OrgSeed } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const teamCtx = (orgId: string, teamId: string) => ({
  params: Promise.resolve({ orgId, teamId }),
});

describe("org notifications: 创建团队触发通知", () => {
  it("创建团队后企业管理员收到通知", async () => {
    const s = await seedOrg();
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.admin.apiToken, {
        method: "POST",
        json: { name: "Notified Team" },
      }),
      orgCtx(s.orgId),
    );

    // 查询通知
    const resp = await envelope<Notification[]>(
      await listNotifications(
        authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    // seedOrg 写了 2 条审计日志但不写通知；创建团队写了 1 条 org_admin 通知
    const teamNotify = resp.data.find((n) => n.title.includes("新团队创建"));
    expect(teamNotify).toBeTruthy();
    expect(teamNotify!.level).toBe("org_admin");
    expect(teamNotify!.body).toContain("Notified Team");
    expect(teamNotify!.actorName).toBeTruthy();
  });

  it("普通成员可以查看通知", async () => {
    const s = await seedOrg();
    // 触发一条通知
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "Visible Team" },
      }),
      orgCtx(s.orgId),
    );

    const resp = await envelope<Notification[]>(
      await listNotifications(
        authed(`/api/v1/orgs/${s.orgId}/notifications`, s.member.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.length).toBeGreaterThan(0);
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await listNotifications(authed(`/api/v1/orgs/${s.orgId}/notifications`, null), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await listNotifications(authed(`/api/v1/orgs/${s.orgId}/notifications`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("按级别筛选（org_admin / team_admin）", async () => {
    const s = await seedOrg();
    // 创建团队（org_admin 通知）
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "Filter Team" },
      }),
      orgCtx(s.orgId),
    );
    // 添加成员到团队（team_admin 通知）
    await addTeamMember(
      authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
        method: "POST",
        json: { email: s.member.email, role: "editor" },
      }),
      teamCtx(s.orgId, s.teamId),
    );

    const orgOnly = await envelope<Notification[]>(
      await listNotifications(
        authed(`/api/v1/orgs/${s.orgId}/notifications?level=org_admin`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(orgOnly.data.every((n) => n.level === "org_admin")).toBe(true);

    const teamOnly = await envelope<Notification[]>(
      await listNotifications(
        authed(`/api/v1/orgs/${s.orgId}/notifications?level=team_admin`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(teamOnly.data.every((n) => n.level === "team_admin")).toBe(true);
    expect(teamOnly.data.length).toBeGreaterThan(0);
  });

  it("标记单条通知已读", async () => {
    const s = await seedOrg();
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "Read Test Team" },
      }),
      orgCtx(s.orgId),
    );

    const list = await envelope<Notification[]>(
      await listNotifications(authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken), orgCtx(s.orgId)),
    );
    const unread = list.data.find((n) => !n.read);
    expect(unread).toBeTruthy();

    await markNotificationsRead(
      authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken, {
        method: "PATCH",
        json: { id: unread!.id },
      }),
      orgCtx(s.orgId),
    );

    // 验证已读
    const [updated] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, unread!.id))
      .limit(1);
    expect(updated!.read).toBe(true);
  });

  it("全部标记已读", async () => {
    const s = await seedOrg();
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "All Read Team 1" },
      }),
      orgCtx(s.orgId),
    );
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "All Read Team 2" },
      }),
      orgCtx(s.orgId),
    );

    await markNotificationsRead(
      authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken, {
        method: "PATCH",
        json: { all: true },
      }),
      orgCtx(s.orgId),
    );

    const list = await envelope<Notification[]>(
      await listNotifications(authed(`/api/v1/orgs/${s.orgId}/notifications`, s.owner.apiToken), orgCtx(s.orgId)),
    );
    expect(list.data.every((n) => n.read)).toBe(true);
  });
});

describe("org team detail: 团队详情与 Team Admin", () => {
  it("企业成员可查看团队详情（含 Team Admin 列表）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await getTeamDetail(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.member.apiToken),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.name).toBe("Org Team");
    expect(resp.data.memberCount).toBeGreaterThan(0);
    // seedOrg 中 team owner 是 s.owner
    expect(resp.data.admins.length).toBeGreaterThan(0);
    const ownerAdmin = resp.data.admins.find((a: { role: string }) => a.role === "owner");
    expect(ownerAdmin).toBeTruthy();
    expect(ownerAdmin.name).toBe("Org Owner");
  });

  it("非企业成员查看团队详情 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await getTeamDetail(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, nonOrg),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业访问团队详情 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await getTeamDetail(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, other.apiToken),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("查询不属于该企业的团队返回 404", async () => {
    const s = await seedOrg();
    // 创建一个不属于企业的独立团队
    const [ outsider ] = await db.insert(users).values({
      casdoorId: `out-${Date.now()}`,
      name: "Outsider",
    }).returning();
    const { seedBasic } = await import("./helpers");
    const basic = await seedBasic(); // 创建了一个独立团队

    const resp = await envelope(
      await getTeamDetail(
        authed(`/api/v1/orgs/${s.orgId}/teams/${basic.teamId}`, s.owner.apiToken),
        teamCtx(s.orgId, basic.teamId),
      ),
    );
    expect(resp.status).toBe(404);
  });
});

describe("org team members: 团队成员管理", () => {
  it("admin+ 可以添加企业成员到团队", async () => {
    const s = await seedOrg();
    // s.member 已是企业成员
    const resp = await envelope(
      await addTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "POST",
          json: { email: s.member.email, role: "editor" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.added).toBe(true);
  });

  it("添加非企业成员到团队返回 403", async () => {
    const s = await seedOrg();
    // 创建一个不在企业中的用户
    const [ outsider ] = await db.insert(users).values({
      casdoorId: `nontm-${Date.now()}`,
      name: "Non Team",
      email: "nontm@test.com",
    }).returning();

    const resp = await envelope(
      await addTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.owner.apiToken, {
          method: "POST",
          json: { email: "nontm@test.com", role: "editor" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(403);
    expect(resp.error?.code).toBe("NOT_ORG_MEMBER");
  });

  it("普通成员添加团队成员 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await addTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.member.apiToken, {
          method: "POST",
          json: { email: s.billing.email, role: "viewer" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("添加团队成员后触发 team_admin 通知", async () => {
    const s = await seedOrg();
    await addTeamMember(
      authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
        method: "POST",
        json: { email: s.member.email, role: "editor" },
      }),
      teamCtx(s.orgId, s.teamId),
    );

    const list = await envelope<Notification[]>(
      await listNotifications(
        authed(`/api/v1/orgs/${s.orgId}/notifications?level=team_admin`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    const memberNotify = list.data.find((n) => n.title.includes("新成员加入"));
    expect(memberNotify).toBeTruthy();
    expect(memberNotify!.body).toContain("Org Member");
  });

  it("变更团队成员角色", async () => {
    const s = await seedOrg();
    // 先添加 member 到团队
    await addTeamMember(
      authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
        method: "POST",
        json: { email: s.member.email, role: "viewer" },
      }),
      teamCtx(s.orgId, s.teamId),
    );

    // 变更角色为 editor
    const resp = await envelope(
      await patchTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "PATCH",
          json: { userId: s.member.userId, role: "editor" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(200);

    // 验证角色已变更
    const [tm] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, s.teamId), eq(teamMembers.userId, s.member.userId)))
      .limit(1);
    expect(tm!.role).toBe("editor");
  });

  it("不能变更团队 owner 角色", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "PATCH",
          json: { userId: s.owner.userId, role: "editor" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(400);
    expect(resp.error?.code).toBe("CANNOT_MODIFY_OWNER");
  });

  it("移除团队成员", async () => {
    const s = await seedOrg();
    // 先添加
    await addTeamMember(
      authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
        method: "POST",
        json: { email: s.member.email, role: "viewer" },
      }),
      teamCtx(s.orgId, s.teamId),
    );

    // 移除
    const resp = await envelope(
      await deleteTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "DELETE",
          json: { userId: s.member.userId },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.removed).toBe(true);
  });

  it("不能移除团队 owner", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "DELETE",
          json: { userId: s.owner.userId },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(400);
    expect(resp.error?.code).toBe("CANNOT_REMOVE_OWNER");
  });

  it("重复添加同一成员到团队是幂等的", async () => {
    const s = await seedOrg();
    await addTeamMember(
      authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
        method: "POST",
        json: { email: s.member.email, role: "viewer" },
      }),
      teamCtx(s.orgId, s.teamId),
    );
    const resp = await envelope(
      await addTeamMember(
        authed(`/api/v1/orgs/${s.orgId}/teams/${s.teamId}`, s.admin.apiToken, {
          method: "POST",
          json: { email: s.member.email, role: "admin" },
        }),
        teamCtx(s.orgId, s.teamId),
      ),
    );
    expect(resp.status).toBe(201);
    // 角色已更新为 admin
    const [tm] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, s.teamId), eq(teamMembers.userId, s.member.userId)))
      .limit(1);
    expect(tm!.role).toBe("admin");
  });
});

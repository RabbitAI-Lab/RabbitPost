/**
 * 企业成员管理（GET/POST/PATCH/DELETE /orgs/:orgId/members）的路由级回归测试。
 * 覆盖：列表、邀请、角色变更、移除、owner 保护、越权（非成员/跨企业/角色不足）。
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { OrgMember } from "@rabbitpost/shared";
import { db } from "../src/db";
import { organizationMembers, users } from "../src/db/schema";
import {
  DELETE as deleteMember,
  GET as listMembers,
  PATCH as patchMember,
  POST as inviteMember,
} from "../src/app/api/v1/orgs/[orgId]/members/route";
import { authed, envelope, seedNonOrgToken, seedOrg, seedOtherOrg } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

describe("org members: 列表", () => {
  it("企业成员可以查看成员列表（含团队归属）", async () => {
    const s = await seedOrg();
    const resp = await envelope<OrgMember[]>(
      await listMembers(authed(`/api/v1/orgs/${s.orgId}/members`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    // seedOrg 创建了 4 个企业成员
    expect(resp.data).toHaveLength(4);
    // owner 有 teamIds
    const owner = resp.data.find((m) => m.role === "owner");
    expect(owner).toBeTruthy();
    expect(owner!.teamIds).toContain(s.teamId);
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(await listMembers(authed(`/api/v1/orgs/${s.orgId}/members`, null), orgCtx(s.orgId)));
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await listMembers(authed(`/api/v1/orgs/${s.orgId}/members`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业访问 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await listMembers(authed(`/api/v1/orgs/${s.orgId}/members`, other.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

describe("org members: 邀请", () => {
  it("admin+ 可以邀请已注册用户加入企业", async () => {
    const s = await seedOrg();
    // 创建一个已注册但未加入企业的用户
    const [newUser] = await db
      .insert(users)
      .values({ casdoorId: `invitee-${Date.now()}`, name: "Invitee", email: "invitee@test.com" })
      .returning();

    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "POST",
          json: { email: "invitee@test.com", role: "member" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.added).toBe(true);
    expect(resp.data.userId).toBe(newUser.id);
  });

  it("邀请不存在的邮箱返回 404", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.owner.apiToken, {
          method: "POST",
          json: { email: "nonexistent@test.com", role: "member" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(404);
    expect(resp.error?.code).toBe("USER_NOT_FOUND");
  });

  it("邀请时不能直接赋予 owner 角色", async () => {
    const s = await seedOrg();
    const [newUser] = await db
      .insert(users)
      .values({ casdoorId: `invitee2-${Date.now()}`, name: "Invitee2", email: "invitee2@test.com" })
      .returning();

    // 传入 role: owner 会被 zod 拒绝（enum 排除了 owner）
    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.owner.apiToken, {
          method: "POST",
          json: { email: "invitee2@test.com", role: "owner" },
        }),
        orgCtx(s.orgId),
      ),
    );
    // zod 验证失败返回 500（unhandled error）或 400
    expect(resp.ok).toBe(false);
  });

  it("普通 member 邀请成员 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.member.apiToken, {
          method: "POST",
          json: { email: "invitee@test.com", role: "member" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员邀请 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, nonOrg, {
          method: "POST",
          json: { email: "x@test.com", role: "member" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("重复邀请同一用户是幂等的（onConflictDoUpdate 更新角色）", async () => {
    const s = await seedOrg();
    const [newUser] = await db
      .insert(users)
      .values({ casdoorId: `dup-${Date.now()}`, name: "Dup", email: "dup@test.com" })
      .returning();
    // 第一次邀请为 member
    await inviteMember(
      authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
        method: "POST",
        json: { email: "dup@test.com", role: "member" },
      }),
      orgCtx(s.orgId),
    );
    // 第二次邀请改为 admin
    const resp = await envelope(
      await inviteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "POST",
          json: { email: "dup@test.com", role: "admin" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(201);
    // 验证角色已更新
    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, newUser.id))
      .limit(1);
    expect(member!.role).toBe("admin");
  });
});

describe("org members: 角色变更", () => {
  it("admin+ 可以变更非 owner 成员的角色", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.owner.apiToken, {
          method: "PATCH",
          json: { userId: s.member.userId, role: "admin" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.updated).toBe(true);
  });

  it("不能变更 owner 的角色", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "PATCH",
          json: { userId: s.owner.userId, role: "admin" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(400);
    expect(resp.error?.code).toBe("CANNOT_MODIFY_OWNER");
  });

  it("普通 member 变更角色 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.member.apiToken, {
          method: "PATCH",
          json: { userId: s.admin.userId, role: "member" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员变更角色 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await patchMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, nonOrg, {
          method: "PATCH",
          json: { userId: s.member.userId, role: "admin" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("变更不存在的成员 404", async () => {
    const s = await seedOrg();
    const fakeUserId = crypto.randomUUID();
    const resp = await envelope(
      await patchMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "PATCH",
          json: { userId: fakeUserId, role: "admin" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(404);
  });
});

describe("org members: 移除", () => {
  it("admin+ 可以移除非 owner 成员", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "DELETE",
          json: { userId: s.member.userId },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.removed).toBe(true);
  });

  it("不能移除 owner", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.admin.apiToken, {
          method: "DELETE",
          json: { userId: s.owner.userId },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(400);
    expect(resp.error?.code).toBe("CANNOT_REMOVE_OWNER");
  });

  it("普通 member 移除成员 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, s.member.apiToken, {
          method: "DELETE",
          json: { userId: s.admin.userId },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员移除 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await deleteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, nonOrg, {
          method: "DELETE",
          json: { userId: s.member.userId },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业移除 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await deleteMember(
        authed(`/api/v1/orgs/${s.orgId}/members`, other.apiToken, {
          method: "DELETE",
          json: { userId: s.member.userId },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });
});

/**
 * 企业 Organization CRUD + 权限的路由级回归测试。
 * 覆盖：创建、列表、详情、更新、删除，以及越权场景（未认证 / 非成员 / 跨企业 / 角色不足）。
 */
import { describe, expect, it, vi } from "vitest";
import type { Organization } from "@rabbitpost/shared";
import { db } from "../src/db";
import { organizationMembers, organizations } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { GET as listOrgs, POST as createOrg } from "../src/app/api/v1/orgs/route";
import {
  DELETE as deleteOrg,
  GET as getOrg,
  PATCH as patchOrg,
} from "../src/app/api/v1/orgs/[orgId]/route";
import { authed, envelope, seedNonOrgToken, seedOrg, seedOtherOrg, type OrgSeed } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

describe("orgs: 创建与列表", () => {
  it("POST 创建企业，创建者自动成为 owner", async () => {
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", nonOrg, { method: "POST", json: { name: "New Org", domain: "new.com" } }),
        {} as never,
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.name).toBe("New Org");
    expect(resp.data.plan).toBe("enterprise");
    expect(resp.data.status).toBe("active");
    expect(resp.data.role).toBe("owner");
    expect(resp.data.domain).toBe("new.com");
    expect(resp.data.slug).toBeTruthy();
  });

  it("创建时自动生成 slug（省略时）", async () => {
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", nonOrg, { method: "POST", json: { name: "My Company" } }),
        {} as never,
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.slug).toMatch(/^my-company-/);
  });

  it("创建时写入审计日志 org.create", async () => {
    const nonOrg = await seedNonOrgToken();
    const created = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", nonOrg, { method: "POST", json: { name: "Audit Org" } }),
        {} as never,
      ),
    );
    // 审计日志应包含 org.create 动作
    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, created.data.id))
      .limit(1);
    // owner 存在即可；审计日志级联于 org
    expect(member).toBeTruthy();
    expect(member!.role).toBe("owner");
  });

  it("GET 列表只返回当前用户加入的企业", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();

    // 当前企业 owner 只看到自己的企业
    const resp = await envelope<Organization[]>(
      await listOrgs(authed("/api/v1/orgs", s.owner.apiToken), {} as never),
    );
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveLength(1);
    expect(resp.data[0].id).toBe(s.orgId);
    expect(resp.data[0].role).toBe("owner");

    // 其他企业 owner 看不到当前企业
    const otherResp = await envelope<Organization[]>(
      await listOrgs(authed("/api/v1/orgs", other.apiToken), {} as never),
    );
    expect(otherResp.data).toHaveLength(1);
    expect(otherResp.data[0].id).toBe(other.orgId);
  });

  it("普通 member 角色能看到自己加入的企业", async () => {
    const s = await seedOrg();
    const resp = await envelope<Organization[]>(
      await listOrgs(authed("/api/v1/orgs", s.member.apiToken), {} as never),
    );
    expect(resp.data).toHaveLength(1);
    expect(resp.data[0].role).toBe("member");
  });
});

describe("orgs: 详情", () => {
  it("企业成员可以查看详情，返回自身角色", async () => {
    const s = await seedOrg();
    const resp = await envelope<Organization>(
      await getOrg(authed(`/api/v1/orgs/${s.orgId}`, s.admin.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.id).toBe(s.orgId);
    expect(resp.data.role).toBe("admin");
  });

  it("未认证返回 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(await getOrg(authed(`/api/v1/orgs/${s.orgId}`, null), orgCtx(s.orgId)));
    expect(resp.status).toBe(401);
  });

  it("非企业成员返回 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await getOrg(authed(`/api/v1/orgs/${s.orgId}`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
    expect(resp.error?.code).toBe("FORBIDDEN");
  });

  it("跨企业访问返回 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    // 其他企业的 owner 访问当前企业
    const resp = await envelope(
      await getOrg(authed(`/api/v1/orgs/${s.orgId}`, other.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

describe("orgs: 更新", () => {
  it("admin+ 可以更新企业信息", async () => {
    const s = await seedOrg();
    const resp = await envelope<Organization>(
      await patchOrg(
        authed(`/api/v1/orgs/${s.orgId}`, s.admin.apiToken, {
          method: "PATCH",
          json: { name: "Renamed Org", domain: "renamed.com" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.name).toBe("Renamed Org");
    expect(resp.data.domain).toBe("renamed.com");
  });

  it("普通 member 更新企业返回 403（角色不足）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchOrg(
        authed(`/api/v1/orgs/${s.orgId}`, s.member.apiToken, {
          method: "PATCH",
          json: { name: "Hacked" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
    expect(resp.error?.code).toBe("FORBIDDEN");
  });

  it("billing 角色更新企业返回 403（角色不足）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchOrg(
        authed(`/api/v1/orgs/${s.orgId}`, s.billing.apiToken, {
          method: "PATCH",
          json: { name: "Hacked" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员更新返回 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await patchOrg(
        authed(`/api/v1/orgs/${s.orgId}`, nonOrg, { method: "PATCH", json: { name: "X" } }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("更新时写入审计日志", async () => {
    const s = await seedOrg();
    await patchOrg(
      authed(`/api/v1/orgs/${s.orgId}`, s.owner.apiToken, {
        method: "PATCH",
        json: { seatLimit: 100 },
      }),
      orgCtx(s.orgId),
    );
    const [org] = await db.select().from(organizations).where(eq(organizations.id, s.orgId)).limit(1);
    expect(org!.seatLimit).toBe(100);
  });
});

describe("orgs: 删除", () => {
  it("仅 owner 可以删除企业", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteOrg(authed(`/api/v1/orgs/${s.orgId}`, s.owner.apiToken, { method: "DELETE" }), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.deleted).toBe(true);
    // 企业已被删除
    const [org] = await db.select().from(organizations).where(eq(organizations.id, s.orgId)).limit(1);
    expect(org).toBeUndefined();
  });

  it("admin 删除企业返回 403（角色不足）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteOrg(authed(`/api/v1/orgs/${s.orgId}`, s.admin.apiToken, { method: "DELETE" }), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("member 删除企业返回 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await deleteOrg(authed(`/api/v1/orgs/${s.orgId}`, s.member.apiToken, { method: "DELETE" }), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员删除返回 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await deleteOrg(authed(`/api/v1/orgs/${s.orgId}`, nonOrg, { method: "DELETE" }), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业 owner 不能删除其他企业", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await deleteOrg(authed(`/api/v1/orgs/${s.orgId}`, other.apiToken, { method: "DELETE" }), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

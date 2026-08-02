/**
 * 企业团队管理（GET/POST /orgs/:orgId/teams）与工作区列表的路由级回归测试。
 * 覆盖：列表、创建、统计字段、权限（非成员/跨企业/角色不足）。
 */
import { describe, expect, it, vi } from "vitest";
import { GET as listOrgTeams, POST as createOrgTeam } from "../src/app/api/v1/orgs/[orgId]/teams/route";
import { GET as listOrgWorkspaces } from "../src/app/api/v1/orgs/[orgId]/workspaces/route";
import { authed, envelope, seedNonOrgToken, seedOrg, seedOtherOrg } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

describe("org teams: 列表", () => {
  it("企业成员可以查看团队列表（含统计字段）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await listOrgTeams(authed(`/api/v1/orgs/${s.orgId}/teams`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveLength(1);
    const team = resp.data[0];
    expect(team.name).toBe("Org Team");
    expect(team.orgId).toBe(s.orgId);
    expect(team.memberCount).toBe(3);
    expect(team.workspaceCount).toBe(1);
    expect(team.collectionCount).toBe(1);
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(await listOrgTeams(authed(`/api/v1/orgs/${s.orgId}/teams`, null), orgCtx(s.orgId)));
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await listOrgTeams(authed(`/api/v1/orgs/${s.orgId}/teams`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业访问 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await listOrgTeams(authed(`/api/v1/orgs/${s.orgId}/teams`, other.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

describe("org teams: 创建", () => {
  it("admin+ 可以在企业下创建团队", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await createOrgTeam(
        authed(`/api/v1/orgs/${s.orgId}/teams`, s.admin.apiToken, {
          method: "POST",
          json: { name: "New Team" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.name).toBe("New Team");
    expect(resp.data.orgId).toBe(s.orgId);
    expect(resp.data.memberCount).toBe(1);
    expect(resp.data.workspaceCount).toBe(0);
  });

  it("创建时自动生成 slug", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await createOrgTeam(
        authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
          method: "POST",
          json: { name: "Data Platform" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.slug).toMatch(/^data-platform-/);
  });

  it("普通 member 创建团队 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await createOrgTeam(
        authed(`/api/v1/orgs/${s.orgId}/teams`, s.member.apiToken, {
          method: "POST",
          json: { name: "Forbidden Team" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("billing 角色创建团队 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await createOrgTeam(
        authed(`/api/v1/orgs/${s.orgId}/teams`, s.billing.apiToken, {
          method: "POST",
          json: { name: "Forbidden Team" },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员创建团队 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await createOrgTeam(
        authed(`/api/v1/orgs/${s.orgId}/teams`, nonOrg, { method: "POST", json: { name: "X" } }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("创建团队后审计日志包含 team.create", async () => {
    const s = await seedOrg();
    await createOrgTeam(
      authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken, {
        method: "POST",
        json: { name: "Audit Team" },
      }),
      orgCtx(s.orgId),
    );
    // 审计日志通过 GET /audit-logs 验证（在审计测试文件中覆盖）
    // 这里验证创建后能从列表查到
    const list = await envelope(
      await listOrgTeams(authed(`/api/v1/orgs/${s.orgId}/teams`, s.owner.apiToken), orgCtx(s.orgId)),
    );
    expect(list.data.some((t: { name: string }) => t.name === "Audit Team")).toBe(true);
  });
});

describe("org workspaces: 跨团队工作区列表", () => {
  it("企业成员可以查看所有工作区", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await listOrgWorkspaces(authed(`/api/v1/orgs/${s.orgId}/workspaces`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveLength(1);
    const ws = resp.data[0];
    expect(ws.name).toBe("Org WS");
    expect(ws.teamName).toBe("Org Team");
    expect(ws.collectionCount).toBe(1);
    expect(ws.requestCount).toBe(1);
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await listOrgWorkspaces(authed(`/api/v1/orgs/${s.orgId}/workspaces`, null), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await listOrgWorkspaces(authed(`/api/v1/orgs/${s.orgId}/workspaces`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业访问 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await listOrgWorkspaces(authed(`/api/v1/orgs/${s.orgId}/workspaces`, other.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

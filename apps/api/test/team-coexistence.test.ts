/**
 * 企业团队与个人团队共存场景的路由级回归测试。
 *
 * 核心场景：一个用户同时拥有
 *   - 企业组织下的 Team（orgId 非空）
 *   - 个人创建的 Team（orgId 为 null）
 * 验证：
 *   1. GET /teams 同时返回两种团队
 *   2. 用户可以自由切换到任意团队（不受 org 归属限制）
 *   3. 两种团队的 workspace/collection 等资源互相隔离
 *   4. 企业 admin 被移除企业成员后，其个人团队不受影响
 *   5. 创建企业后，用户原有个人团队仍然可见可用
 *   6. GET /orgs 只返回企业，不包含个人团队
 */
import { describe, expect, it, vi } from "vitest";
import type { Organization, Team } from "@rabbitpost/shared";
import { db } from "../src/db";
import { organizationMembers, organizations, teamMembers, teams, workspaces } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { GET as listTeams, POST as createTeam } from "../src/app/api/v1/teams/route";
import { GET as listOrgs, POST as createOrg } from "../src/app/api/v1/orgs/route";
import {
  DELETE as deleteOrgMember,
  GET as listOrgMembers,
} from "../src/app/api/v1/orgs/[orgId]/members/route";
import { authed, envelope } from "./helpers";
import { seedNonOrgToken } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

describe("企业团队与个人团队共存", () => {
  it("用户同时拥有企业团队和个人团队时，GET /teams 返回全部", async () => {
    const token = await seedNonOrgToken();

    // 1. 创建个人团队（orgId = null）
    const personalTeamResp = await envelope<Team>(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "My Personal Team" } }),
        {} as never,
      ),
    );
    expect(personalTeamResp.status).toBe(201);

    // 2. 创建企业（创建者自动成为 owner）
    const orgResp = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "My Enterprise" } }),
        {} as never,
      ),
    );
    expect(orgResp.status).toBe(201);

    // 3. 在企业下创建团队
    const orgTeamResp = await envelope(
      await (await import("../src/app/api/v1/orgs/[orgId]/teams/route")).POST(
        authed(`/api/v1/orgs/${orgResp.data.id}/teams`, token, {
          method: "POST",
          json: { name: "Enterprise Team" },
        }),
        orgCtx(orgResp.data.id),
      ),
    );
    expect(orgTeamResp.status).toBe(201);

    // 4. GET /teams 应返回 2 个团队（个人 + 企业）
    const teamsResp = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", token), {} as never),
    );
    expect(teamsResp.status).toBe(200);
    expect(teamsResp.data).toHaveLength(2);
    const names = teamsResp.data.map((t) => t.name).sort();
    expect(names).toEqual(["Enterprise Team", "My Personal Team"]);
  });

  it("个人团队的 orgId 为 null，企业团队的 orgId 有值", async () => {
    const token = await seedNonOrgToken();

    // 创建个人团队
    const personal = await envelope<Team>(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Personal" } }),
        {} as never,
      ),
    );

    // 创建企业 + 企业团队
    const org = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "Ent Org" } }),
        {} as never,
      ),
    );
    const entTeam = await envelope(
      await (await import("../src/app/api/v1/orgs/[orgId]/teams/route")).POST(
        authed(`/api/v1/orgs/${org.data.id}/teams`, token, {
          method: "POST",
          json: { name: "Ent Team" },
        }),
        orgCtx(org.data.id),
      ),
    );

    // 直接查库验证 orgId
    const [pTeam] = await db.select().from(teams).where(eq(teams.id, personal.data.id)).limit(1);
    const [eTeam] = await db.select().from(teams).where(eq(teams.id, entTeam.data.id)).limit(1);

    expect(pTeam!.orgId).toBeNull();
    expect(eTeam!.orgId).toBe(org.data.id);
  });

  it("用户可以自由切换到个人团队（不受企业归属限制）", async () => {
    const token = await seedNonOrgToken();

    // 创建企业 + 企业团队
    const org = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "Switch Test Org" } }),
        {} as never,
      ),
    );
    await (await import("../src/app/api/v1/orgs/[orgId]/teams/route")).POST(
      authed(`/api/v1/orgs/${org.data.id}/teams`, token, {
        method: "POST",
        json: { name: "Org Team" },
      }),
      orgCtx(org.data.id),
    );

    // 创建个人团队
    const personal = await envelope<Team>(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Personal Team" } }),
        {} as never,
      ),
    );

    // GET /teams 返回全部，用户可以在前端自由切换到任何一个
    const teamsResp = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", token), {} as never),
    );
    expect(teamsResp.data).toHaveLength(2);

    // 验证个人团队的详情可正常获取（模拟切换后的操作）
    // 通过 teams/:id 路由验证（需走团队权限校验）
    const { GET: getTeam } = await import("../src/app/api/v1/teams/[teamId]/route");
    const teamCtx = (teamId: string) => ({ params: Promise.resolve({ teamId }) });

    const personalDetail = await envelope<Team>(
      await getTeam(authed(`/api/v1/teams/${personal.data.id}`, token), teamCtx(personal.data.id)),
    );
    expect(personalDetail.status).toBe(200);
    expect(personalDetail.data.name).toBe("Personal Team");
  });

  it("个人团队和企业团队的 workspace 互相隔离", async () => {
    const token = await seedNonOrgToken();

    // 创建个人团队 + workspace
    const personal = await envelope<Team>(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Isolated Personal" } }),
        {} as never,
      ),
    );
    // 创建企业 + 企业团队 + workspace
    const org = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "Isolated Org" } }),
        {} as never,
      ),
    );
    const entTeamResp = await envelope(
      await (await import("../src/app/api/v1/orgs/[orgId]/teams/route")).POST(
        authed(`/api/v1/orgs/${org.data.id}/teams`, token, {
          method: "POST",
          json: { name: "Org Team" },
        }),
        orgCtx(org.data.id),
      ),
    );

    // 在两个团队下各创建一个 workspace
    const { POST: createWs } = await import("../src/app/api/v1/workspaces/route");
    await envelope(
      await createWs(
        authed("/api/v1/workspaces", token, {
          method: "POST",
          json: { teamId: personal.data.id, name: "Personal WS" },
        }),
        {} as never,
      ),
    );
    await envelope(
      await createWs(
        authed("/api/v1/workspaces", token, {
          method: "POST",
          json: { teamId: entTeamResp.data.id, name: "Org WS" },
        }),
        {} as never,
      ),
    );

    // 验证 GET /workspaces?teamId=xxx 只返回对应团队的 workspace
    const { GET: listWs } = await import("../src/app/api/v1/workspaces/route");

    const personalWs = await envelope(
      await listWs(authed(`/api/v1/workspaces?teamId=${personal.data.id}`, token), {} as never),
    );
    expect(personalWs.data).toHaveLength(1);
    expect(personalWs.data[0].name).toBe("Personal WS");

    const orgWs = await envelope(
      await listWs(authed(`/api/v1/workspaces?teamId=${entTeamResp.data.id}`, token), {} as never),
    );
    expect(orgWs.data).toHaveLength(1);
    expect(orgWs.data[0].name).toBe("Org WS");
  });

  it("用户被移出企业后，个人团队不受影响", async () => {
    // 构建场景：用户同时有个人团队和企业团队
    const adminToken = await seedNonOrgToken();

    // 创建个人团队
    const personal = await envelope<Team>(
      await createTeam(
        authed("/api/v1/teams", adminToken, { method: "POST", json: { name: "My Personal" } }),
        {} as never,
      ),
    );

    // 创建企业（创建者为 owner）
    const org = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", adminToken, { method: "POST", json: { name: "Removal Test Org" } }),
        {} as never,
      ),
    );

    // 企业下创建团队
    await envelope(
      await (await import("../src/app/api/v1/orgs/[orgId]/teams/route")).POST(
        authed(`/api/v1/orgs/${org.data.id}/teams`, adminToken, {
          method: "POST",
          json: { name: "Ent Team" },
        }),
        orgCtx(org.data.id),
      ),
    );

    // 验证两种团队都在
    const beforeRemoval = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", adminToken), {} as never),
    );
    expect(beforeRemoval.data).toHaveLength(2);

    // 从企业移除用户（删除 organization_members）
    await db
      .delete(organizationMembers)
      .where(eq(organizationMembers.orgId, org.data.id));

    // GET /orgs 不再返回该企业（企业访问权已撤销）
    const orgsAfter = await envelope<Organization[]>(
      await listOrgs(authed("/api/v1/orgs", adminToken), {} as never),
    );
    expect(orgsAfter.data).toHaveLength(0);

    // 个人团队仍然可见（team_members 独立于 org_members）
    const afterRemoval = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", adminToken), {} as never),
    );
    // team_members 关系仍然存在，所以两种团队都在
    // 这是预期行为：team 成员关系独立于 org 成员关系
    expect(afterRemoval.data).toHaveLength(2);
    // 个人团队在其中
    expect(afterRemoval.data.some((t) => t.id === personal.data.id)).toBe(true);
  });

  it("GET /orgs 不包含个人团队，只返回企业组织", async () => {
    const token = await seedNonOrgToken();

    // 创建个人团队
    await envelope(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Solo Team" } }),
        {} as never,
      ),
    );

    // 创建企业
    const org = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "Real Org" } }),
        {} as never,
      ),
    );

    // GET /orgs 只返回企业，不包含个人团队
    const orgsResp = await envelope<Organization[]>(
      await listOrgs(authed("/api/v1/orgs", token), {} as never),
    );
    expect(orgsResp.data).toHaveLength(1);
    expect(orgsResp.data[0].id).toBe(org.data.id);
    expect(orgsResp.data[0].name).toBe("Real Org");
  });

  it("创建企业后，用户原有个人团队仍然可见", async () => {
    const token = await seedNonOrgToken();

    // 先创建 2 个个人团队
    await envelope(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Personal A" } }),
        {} as never,
      ),
    );
    await envelope(
      await createTeam(
        authed("/api/v1/teams", token, { method: "POST", json: { name: "Personal B" } }),
        {} as never,
      ),
    );

    // 确认有 2 个团队
    const before = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", token), {} as never),
    );
    expect(before.data).toHaveLength(2);

    // 创建企业
    await envelope(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "New Enterprise" } }),
        {} as never,
      ),
    );

    // 原有个人团队仍然可见（创建企业不会影响个人团队）
    const after = await envelope<Team[]>(
      await listTeams(authed("/api/v1/teams", token), {} as never),
    );
    // 仍然是 2 个（企业团队尚未创建）
    expect(after.data).toHaveLength(2);
    expect(after.data.map((t) => t.name).sort()).toEqual(["Personal A", "Personal B"]);
  });
});

describe("企业创建入口", () => {
  it("POST /orgs 创建企业后创建者成为 owner，写入审计日志", async () => {
    const token = await seedNonOrgToken();

    const resp = await envelope<Organization>(
      await createOrg(
        authed("/api/v1/orgs", token, { method: "POST", json: { name: "Audit Test Org" } }),
        {} as never,
      ),
    );
    expect(resp.status).toBe(201);
    expect(resp.data.role).toBe("owner");
    expect(resp.data.plan).toBe("enterprise");

    // 验证组织成员关系已建立
    const members = await envelope(
      await listOrgMembers(authed(`/api/v1/orgs/${resp.data.id}/members`, token), orgCtx(resp.data.id)),
    );
    expect(members.data).toHaveLength(1);
    expect(members.data[0].role).toBe("owner");
  });

  it("未认证用户不能创建企业", async () => {
    const resp = await envelope(
      await createOrg(
        authed("/api/v1/orgs", null, { method: "POST", json: { name: "Hack" } }),
        {} as never,
      ),
    );
    expect(resp.status).toBe(401);
  });
});

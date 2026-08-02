/**
 * 企业仪表盘 / 用量统计 / 审计日志 / 设置 / 计费 / API Keys / Runners 的路由级回归测试。
 * 覆盖：数据正确性、各端点权限矩阵（owner/admin/billing/member/非成员/跨企业）。
 */
import { describe, expect, it, vi } from "vitest";
import type { AuditLog, DashboardSummary, UsageSummary } from "@rabbitpost/shared";
import { db } from "../src/db";
import { histories } from "../src/db/schema";
import { GET as dashboard } from "../src/app/api/v1/orgs/[orgId]/dashboard/route";
import { GET as usage } from "../src/app/api/v1/orgs/[orgId]/usage/route";
import { GET as auditLogs } from "../src/app/api/v1/orgs/[orgId]/audit-logs/route";
import { GET as getSettings, PATCH as patchSettings } from "../src/app/api/v1/orgs/[orgId]/settings/route";
import { GET as billing } from "../src/app/api/v1/orgs/[orgId]/billing/route";
import { GET as orgApiKeys } from "../src/app/api/v1/orgs/[orgId]/api-keys/route";
import { GET as orgRunners } from "../src/app/api/v1/orgs/[orgId]/runners/route";
import { authed, envelope, seedNonOrgToken, seedOrg, seedOtherOrg } from "./org-helpers";

vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUser: async () => null,
}));

const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
describe("org dashboard", () => {
  it("企业成员可以查看仪表盘 KPI", async () => {
    const s = await seedOrg();
    const resp = await envelope<DashboardSummary>(
      await dashboard(authed(`/api/v1/orgs/${s.orgId}/dashboard`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.teamCount).toBe(1);
    expect(resp.data.memberCount).toBe(4);
    expect(resp.data.workspaceCount).toBe(1);
    expect(resp.data.collectionCount).toBe(1);
    expect(resp.data.recentActivity.length).toBeGreaterThan(0);
  });

  it("仪表盘审计日志包含动作和操作者名称", async () => {
    const s = await seedOrg();
    const resp = await envelope<DashboardSummary>(
      await dashboard(authed(`/api/v1/orgs/${s.orgId}/dashboard`, s.owner.apiToken), orgCtx(s.orgId)),
    );
    const log = resp.data.recentActivity[0];
    expect(log.action).toBeTruthy();
    expect(log.actorName).toBeTruthy();
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(await dashboard(authed(`/api/v1/orgs/${s.orgId}/dashboard`, null), orgCtx(s.orgId)));
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(await dashboard(authed(`/api/v1/orgs/${s.orgId}/dashboard`, nonOrg), orgCtx(s.orgId)));
    expect(resp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
describe("org usage", () => {
  it("企业成员可以查询用量统计", async () => {
    const s = await seedOrg();
    const resp = await envelope<UsageSummary>(
      await usage(
        authed(`/api/v1/orgs/${s.orgId}/usage?metric=request_sent&groupBy=total`, s.member.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.metric).toBe("request_sent");
    expect(resp.data.groupBy).toBe("total");
    expect(Array.isArray(resp.data.points)).toBe(true);
  });

  it("有 histories 数据时统计返回正确计数", async () => {
    const s = await seedOrg();
    // 手动插入 histories
    await db.insert(histories).values([
      {
        workspaceId: s.workspaceId,
        userId: s.owner.userId,
        request: { method: "GET", url: "http://test/1", params: [], headers: [], body: { type: "none" }, auth: { type: "none" }, scripts: {} },
      },
      {
        workspaceId: s.workspaceId,
        userId: s.owner.userId,
        request: { method: "GET", url: "http://test/2", params: [], headers: [], body: { type: "none" }, auth: { type: "none" }, scripts: {} },
      },
    ]);
    const resp = await envelope<UsageSummary>(
      await usage(
        authed(`/api/v1/orgs/${s.orgId}/usage?metric=request_sent&groupBy=total`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.data.total).toBe(2);
  });

  it("按团队分组返回各团队请求量", async () => {
    const s = await seedOrg();
    await db.insert(histories).values([
      {
        workspaceId: s.workspaceId,
        userId: s.owner.userId,
        request: { method: "GET", url: "http://test/1", params: [], headers: [], body: { type: "none" }, auth: { type: "none" }, scripts: {} },
      },
    ]);
    const resp = await envelope<UsageSummary>(
      await usage(
        authed(`/api/v1/orgs/${s.orgId}/usage?metric=request_sent&groupBy=team`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.data.total).toBe(1);
    expect(resp.data.points.length).toBe(1);
    expect(resp.data.points[0].group).toBe("Org Team");
  });

  it("未认证 401", async () => {
    const s = await seedOrg();
    const resp = await envelope(await usage(authed(`/api/v1/orgs/${s.orgId}/usage`, null), orgCtx(s.orgId)));
    expect(resp.status).toBe(401);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(await usage(authed(`/api/v1/orgs/${s.orgId}/usage`, nonOrg), orgCtx(s.orgId)));
    expect(resp.status).toBe(403);
  });

  it("跨企业 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(await usage(authed(`/api/v1/orgs/${s.orgId}/usage`, other.apiToken), orgCtx(s.orgId)));
    expect(resp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Audit Logs
// ---------------------------------------------------------------------------
describe("org audit logs", () => {
  it("admin+ 可以查看审计日志", async () => {
    const s = await seedOrg();
    const resp = await envelope<AuditLog[]>(
      await auditLogs(authed(`/api/v1/orgs/${s.orgId}/audit-logs`, s.admin.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.length).toBeGreaterThan(0);
    expect(resp.data[0].action).toBeTruthy();
    expect(resp.data[0].actorName).toBeTruthy();
  });

  it("按动作筛选", async () => {
    const s = await seedOrg();
    const resp = await envelope<AuditLog[]>(
      await auditLogs(
        authed(`/api/v1/orgs/${s.orgId}/audit-logs?action=org.create`, s.owner.apiToken),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.every((l) => l.action === "org.create")).toBe(true);
  });

  it("普通 member 查看审计日志 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await auditLogs(authed(`/api/v1/orgs/${s.orgId}/audit-logs`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("billing 角色查看审计日志 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await auditLogs(authed(`/api/v1/orgs/${s.orgId}/audit-logs`, s.billing.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await auditLogs(authed(`/api/v1/orgs/${s.orgId}/audit-logs`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
describe("org settings", () => {
  it("admin+ 可以查看企业设置", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await getSettings(authed(`/api/v1/orgs/${s.orgId}/settings`, s.admin.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.id).toBe(s.orgId);
    expect(resp.data.seatLimit).toBe(50);
    expect(resp.data.requestQuota).toBe(100000);
  });

  it("admin+ 可以更新设置", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchSettings(
        authed(`/api/v1/orgs/${s.orgId}/settings`, s.admin.apiToken, {
          method: "PATCH",
          json: { seatLimit: 100, requestQuota: 200000 },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.seatLimit).toBe(100);
    expect(resp.data.requestQuota).toBe(200000);
  });

  it("普通 member 查看设置 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await getSettings(authed(`/api/v1/orgs/${s.orgId}/settings`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("普通 member 更新设置 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await patchSettings(
        authed(`/api/v1/orgs/${s.orgId}/settings`, s.member.apiToken, {
          method: "PATCH",
          json: { seatLimit: 999 },
        }),
        orgCtx(s.orgId),
      ),
    );
    expect(resp.status).toBe(403);
  });

  it("billing 角色查看设置 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await getSettings(authed(`/api/v1/orgs/${s.orgId}/settings`, s.billing.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await getSettings(authed(`/api/v1/orgs/${s.orgId}/settings`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
describe("org billing", () => {
  it("billing+ 角色可以查看计费信息", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await billing(authed(`/api/v1/orgs/${s.orgId}/billing`, s.billing.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    expect(resp.data.plan).toBe("enterprise");
    expect(resp.data.seatLimit).toBe(50);
    expect(resp.data.seatUsed).toBe(4);
    expect(resp.data.requestQuota).toBe(100000);
  });

  it("owner 可以查看计费信息", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await billing(authed(`/api/v1/orgs/${s.orgId}/billing`, s.owner.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
  });

  it("普通 member 查看计费 403（需要 billing+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await billing(authed(`/api/v1/orgs/${s.orgId}/billing`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await billing(authed(`/api/v1/orgs/${s.orgId}/billing`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("跨企业 403", async () => {
    const s = await seedOrg();
    const other = await seedOtherOrg();
    const resp = await envelope(
      await billing(authed(`/api/v1/orgs/${s.orgId}/billing`, other.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// API Keys & Runners
// ---------------------------------------------------------------------------
describe("org api keys & runners", () => {
  it("admin+ 可以查看企业下所有 API Keys", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await orgApiKeys(authed(`/api/v1/orgs/${s.orgId}/api-keys`, s.admin.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    // seedOrg 为 4 个用户各创建了一个 key
    expect(resp.data.length).toBe(4);
    expect(resp.data[0].keyPrefix).toBeTruthy();
    expect(resp.data[0].userName).toBeTruthy();
  });

  it("普通 member 查看 API Keys 403（需要 admin+）", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await orgApiKeys(authed(`/api/v1/orgs/${s.orgId}/api-keys`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("非企业成员 403", async () => {
    const s = await seedOrg();
    const nonOrg = await seedNonOrgToken();
    const resp = await envelope(
      await orgApiKeys(authed(`/api/v1/orgs/${s.orgId}/api-keys`, nonOrg), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });

  it("admin+ 可以查看企业下所有 Runners", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await orgRunners(authed(`/api/v1/orgs/${s.orgId}/runners`, s.admin.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(200);
    // seedOrg 没有创建 runner，所以列表为空但接口正常
    expect(Array.isArray(resp.data)).toBe(true);
  });

  it("普通 member 查看 Runners 403", async () => {
    const s = await seedOrg();
    const resp = await envelope(
      await orgRunners(authed(`/api/v1/orgs/${s.orgId}/runners`, s.member.apiToken), orgCtx(s.orgId)),
    );
    expect(resp.status).toBe(403);
  });
});

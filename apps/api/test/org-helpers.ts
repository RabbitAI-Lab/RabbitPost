/**
 * 企业测试助手：构造完整企业数据链 + 多角色 API Key 凭证。
 * 复用 helpers.ts 的 sha256 / authed / envelope，追加企业级 seed。
 */
import crypto from "node:crypto";
import { db } from "../src/db";
import {
  apiKeys,
  auditLogs,
  collectionItems,
  collections,
  organizationMembers,
  organizations,
  teamMembers,
  teams,
  users,
  workspaces,
} from "../src/db/schema";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function makeToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

export interface OrgUser {
  userId: string;
  name: string;
  email: string;
  /** API Key 明文（用于 authed 的 Bearer header） */
  apiToken: string;
}

export interface OrgSeed {
  orgId: string;
  /** owner 用户 */
  owner: OrgUser;
  /** admin 用户 */
  admin: OrgUser;
  /** billing 用户（无 admin 权限） */
  billing: OrgUser;
  /** 普通 member 用户 */
  member: OrgUser;
  /** 企业下创建的团队 id */
  teamId: string;
  /** 团队下创建的 workspace id */
  workspaceId: string;
  /** workspace 下的 collection id */
  collectionId: string;
  /** collection 下的 request item id */
  itemId: string;
}

async function createUserWithToken(name: string, email: string): Promise<OrgUser> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [user] = await db
    .insert(users)
    .values({ casdoorId: `org-${suffix}`, name, email })
    .returning();
  const apiToken = makeToken("rpk_org");
  await db.insert(apiKeys).values({
    userId: user.id,
    name: `${name}-key`,
    keyHash: sha256(apiToken),
    keyPrefix: apiToken.slice(0, 12),
  });
  return { userId: user.id, name, email, apiToken };
}

/**
 * 构建一个完整企业数据链：
 * Organization → 4 种角色用户（owner/admin/billing/member）
 *   → Team（orgId 关联）→ Workspace → Collection → Request Item
 * 同时写入若干审计日志和用量事件。
 */
export async function seedOrg(): Promise<OrgSeed> {
  const id = crypto.randomBytes(3).toString("hex");
  const owner = await createUserWithToken("Org Owner", `org-owner-${id}@test.com`);
  const admin = await createUserWithToken("Org Admin", `org-admin-${id}@test.com`);
  const billing = await createUserWithToken("Org Billing", `org-billing-${id}@test.com`);
  const member = await createUserWithToken("Org Member", `org-member-${id}@test.com`);

  const [org] = await db
    .insert(organizations)
    .values({
      name: "Test Org",
      slug: `test-org-${crypto.randomBytes(3).toString("hex")}`,
      plan: "enterprise",
      status: "active",
      seatLimit: 50,
      requestQuota: 100000,
      createdBy: owner.userId,
    })
    .returning();

  await db.insert(organizationMembers).values([
    { orgId: org.id, userId: owner.userId, role: "owner" },
    { orgId: org.id, userId: admin.userId, role: "admin" },
    { orgId: org.id, userId: billing.userId, role: "billing" },
    { orgId: org.id, userId: member.userId, role: "member" },
  ]);

  const [team] = await db
    .insert(teams)
    .values({
      name: "Org Team",
      slug: `org-team-${crypto.randomBytes(3).toString("hex")}`,
      orgId: org.id,
      createdBy: owner.userId,
    })
    .returning();

  await db.insert(teamMembers).values([
    { teamId: team.id, userId: owner.userId, role: "owner" },
    { teamId: team.id, userId: admin.userId, role: "editor" },
    { teamId: team.id, userId: member.userId, role: "viewer" },
  ]);

  const [workspace] = await db
    .insert(workspaces)
    .values({ teamId: team.id, name: "Org WS", createdBy: owner.userId })
    .returning();

  const [collection] = await db
    .insert(collections)
    .values({ workspaceId: workspace.id, name: "Org Collection" })
    .returning();

  const [item] = await db
    .insert(collectionItems)
    .values({
      collectionId: collection.id,
      type: "request",
      name: "Health",
      request: { method: "GET", url: "{{baseUrl}}/health", params: [], headers: [], body: { type: "none" }, auth: { type: "none" }, scripts: {} },
    })
    .returning();

  // 写入审计日志
  await db.insert(auditLogs).values([
    { orgId: org.id, actorId: owner.userId, action: "org.create", targetType: "org", targetId: org.id, targetName: "Test Org" },
    { orgId: org.id, actorId: admin.userId, action: "team.create", targetType: "team", targetId: team.id, targetName: "Org Team" },
  ]);

  return {
    orgId: org.id,
    owner,
    admin,
    billing,
    member,
    teamId: team.id,
    workspaceId: workspace.id,
    collectionId: collection.id,
    itemId: item.id,
  };
}

/**
 * 创建一个完全独立的企业（用于跨企业越权测试）。
 * 返回 owner token 和 orgId。
 */
export async function seedOtherOrg(): Promise<{ orgId: string; apiToken: string; userId: string }> {
  const otherOwner = await createUserWithToken("Other Owner", `other-${crypto.randomBytes(3).toString("hex")}@test.com`);
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Other Org",
      slug: `other-org-${crypto.randomBytes(3).toString("hex")}`,
      plan: "enterprise",
      createdBy: otherOwner.userId,
    })
    .returning();
  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId: otherOwner.userId,
    role: "owner",
  });
  return { orgId: org.id, apiToken: otherOwner.apiToken, userId: otherOwner.userId };
}

/** 创建一个没有任何企业关联的独立用户 token（用于非成员越权测试） */
export async function seedNonOrgToken(): Promise<string> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [user] = await db
    .insert(users)
    .values({ casdoorId: `nonorg-${suffix}`, name: "Non Org User", email: `nonorg-${suffix}@test.com` })
    .returning();
  const token = makeToken("rpk_non");
  await db.insert(apiKeys).values({
    userId: user.id,
    name: "non-org-key",
    keyHash: sha256(token),
    keyPrefix: token.slice(0, 12),
  });
  return token;
}

export { authed, envelope } from "./helpers";

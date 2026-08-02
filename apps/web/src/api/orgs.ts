import type {
  AuditLog,
  DashboardSummary,
  OrgMember,
  OrgRole,
  Organization,
  UsageMetric,
  UsageSummary,
} from "@rabbitpost/shared";
import { api } from "./client";
export const orgsApi = {
  list: () => api<Organization[]>("/api/v1/orgs"),
  create: (input: { name: string; slug?: string; domain?: string; logoUrl?: string }) =>
    api<Organization>("/api/v1/orgs", { method: "POST", json: input }),
  get: (orgId: string) => api<Organization>(`/api/v1/orgs/${orgId}`),
  update: (orgId: string, patch: Partial<{ name: string; logoUrl: string | null; domain: string | null; status: "active" | "suspended"; seatLimit: number; requestQuota: number }>) =>
    api<Organization>(`/api/v1/orgs/${orgId}`, { method: "PATCH", json: patch }),
  remove: (orgId: string) => api(`/api/v1/orgs/${orgId}`, { method: "DELETE" }),

  // dashboard
  dashboard: (orgId: string) =>
    api<DashboardSummary>(`/api/v1/orgs/${orgId}/dashboard`),

  // teams
  teams: (orgId: string) =>
    api<{
      id: string;
      name: string;
      slug: string;
      avatarUrl: string | null;
      orgId: string | null;
      createdBy: string;
      createdAt: string;
      memberCount: number;
      workspaceCount: number;
      collectionCount: number;
    }[]>(`/api/v1/orgs/${orgId}/teams`),
  createTeam: (orgId: string, input: { name: string; slug?: string }) =>
    api(`/api/v1/orgs/${orgId}/teams`, { method: "POST", json: input }),

  // members
  members: (orgId: string) => api<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
  inviteMember: (orgId: string, email: string, role: Exclude<OrgRole, "owner">) =>
    api(`/api/v1/orgs/${orgId}/members`, { method: "POST", json: { email, role } }),
  updateMemberRole: (orgId: string, userId: string, role: Exclude<OrgRole, "owner">) =>
    api(`/api/v1/orgs/${orgId}/members`, { method: "PATCH", json: { userId, role } }),
  removeMember: (orgId: string, userId: string) =>
    api(`/api/v1/orgs/${orgId}/members`, { method: "DELETE", json: { userId } }),

  // workspaces
  workspaces: (orgId: string) =>
    api<{
      id: string;
      teamId: string;
      teamName: string;
      name: string;
      description: string | null;
      createdBy: string;
      createdAt: string;
      collectionCount: number;
      requestCount: number;
    }[]>(`/api/v1/orgs/${orgId}/workspaces`),

  // usage
  usage: (
    orgId: string,
    params: { metric?: UsageMetric; from?: string; to?: string; groupBy?: "team" | "member" | "workspace" | "total" },
  ) => {
    const sp = new URLSearchParams();
    if (params.metric) sp.set("metric", params.metric);
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    if (params.groupBy) sp.set("groupBy", params.groupBy);
    return api<UsageSummary>(`/api/v1/orgs/${orgId}/usage?${sp.toString()}`);
  },

  // audit logs
  auditLogs: (
    orgId: string,
    params?: { action?: string; actorId?: string; from?: string; to?: string; limit?: number },
  ) => {
    const sp = new URLSearchParams();
    if (params?.action) sp.set("action", params.action);
    if (params?.actorId) sp.set("actorId", params.actorId);
    if (params?.from) sp.set("from", params.from);
    if (params?.to) sp.set("to", params.to);
    if (params?.limit) sp.set("limit", String(params.limit));
    return api<AuditLog[]>(`/api/v1/orgs/${orgId}/audit-logs?${sp.toString()}`);
  },

  // api keys
  apiKeys: (orgId: string) =>
    api<{
      id: string;
      name: string;
      keyPrefix: string;
      lastUsedAt: string | null;
      createdAt: string;
      userId: string;
      userName: string;
      userEmail: string | null;
    }[]>(`/api/v1/orgs/${orgId}/api-keys`),

  // runners
  runners: (orgId: string) =>
    api<{
      id: string;
      name: string;
      description: string | null;
      tokenPrefix: string;
      status: string;
      lastSeenAt: string | null;
      version: string | null;
      platform: string | null;
      teamId: string;
      teamName: string;
      createdAt: string;
    }[]>(`/api/v1/orgs/${orgId}/runners`),

  // settings
  getSettings: (orgId: string) =>
    api<{
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
      domain: string | null;
      plan: string;
      status: string;
      seatLimit: number;
      requestQuota: number;
      ssoConfig: Record<string, unknown> | null;
    }>(`/api/v1/orgs/${orgId}/settings`),
  updateSettings: (orgId: string, patch: Record<string, unknown>) =>
    api(`/api/v1/orgs/${orgId}/settings`, { method: "PATCH", json: patch }),

  // billing
  billing: (orgId: string) =>
    api<{
      plan: string;
      status: string;
      seatLimit: number;
      seatUsed: number;
      requestQuota: number;
      requestUsedEstimate: number;
    }>(`/api/v1/orgs/${orgId}/billing`),
};

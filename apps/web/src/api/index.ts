import type {
  Collection,
  CollectionItem,
  DocumentItem,
  Environment,
  ExecuteRequestInput,
  ExecuteResult,
  HistoryEntry,
  RequestConfig,
  Spec,
  SpecFormat,
  SpecType,
  Team,
  TeamMember,
  TeamRole,
  User,
  Workspace,
} from "@rabbitpost/shared";
import { api } from "./client";

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
export const authApi = {
  loginUrl: () => api<{ authorizeUrl: string; state: string }>("/api/v1/auth/login"),
  callback: (code: string, redirectUri?: string) =>
    api<{ user: User }>("/api/v1/auth/callback", {
      method: "POST",
      json: { code, redirectUri },
    }),
  me: () => api<{ user: User | null }>("/api/v1/auth/me"),
  logout: () => api<{ signedOut: boolean }>("/api/v1/auth/logout", { method: "POST" }),
};

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------
export const teamsApi = {
  list: () => api<Team[]>("/api/v1/teams"),
  create: (name: string) => api<Team>("/api/v1/teams", { method: "POST", json: { name } }),
  update: (teamId: string, patch: { name?: string }) =>
    api(`/api/v1/teams/${teamId}`, { method: "PATCH", json: patch }),
  remove: (teamId: string) => api(`/api/v1/teams/${teamId}`, { method: "DELETE" }),
  members: (teamId: string) => api<TeamMember[]>(`/api/v1/teams/${teamId}/members`),
  addMember: (teamId: string, email: string, role: Exclude<TeamRole, "owner">) =>
    api(`/api/v1/teams/${teamId}/members`, { method: "POST", json: { email, role } }),
  updateMemberRole: (teamId: string, userId: string, role: Exclude<TeamRole, "owner">) =>
    api(`/api/v1/teams/${teamId}/members`, { method: "PATCH", json: { userId, role } }),
  removeMember: (teamId: string, userId: string) =>
    api(`/api/v1/teams/${teamId}/members`, { method: "DELETE", json: { userId } }),
};

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------
export const workspacesApi = {
  list: (teamId: string) => api<Workspace[]>(`/api/v1/workspaces?teamId=${teamId}`),
  create: (teamId: string, name: string, description?: string) =>
    api<Workspace>("/api/v1/workspaces", {
      method: "POST",
      json: { teamId, name, description },
    }),
  update: (workspaceId: string, patch: { name?: string; description?: string | null }) =>
    api(`/api/v1/workspaces/${workspaceId}`, { method: "PATCH", json: patch }),
  remove: (workspaceId: string) =>
    api(`/api/v1/workspaces/${workspaceId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// collections & items
// ---------------------------------------------------------------------------
export const collectionsApi = {
  list: (workspaceId: string) =>
    api<Collection[]>(`/api/v1/workspaces/${workspaceId}/collections`),
  create: (workspaceId: string, name: string, description?: string) =>
    api<Collection>(`/api/v1/workspaces/${workspaceId}/collections`, {
      method: "POST",
      json: { name, description },
    }),
  update: (collectionId: string, patch: { name?: string; description?: string | null }) =>
    api(`/api/v1/collections/${collectionId}`, { method: "PATCH", json: patch }),
  reorder: (workspaceId: string, orderedIds: string[]) =>
    api(`/api/v1/workspaces/${workspaceId}/collections`, {
      method: "PATCH",
      json: { orderedIds },
    }),
  remove: (collectionId: string) =>
    api(`/api/v1/collections/${collectionId}`, { method: "DELETE" }),
  tree: (collectionId: string) =>
    api<CollectionItem[]>(`/api/v1/collections/${collectionId}/tree`),
  createItem: (
    collectionId: string,
    input: { parentId?: string | null; type: "folder" | "request"; name: string },
  ) =>
    api<CollectionItem>(`/api/v1/collections/${collectionId}/items`, {
      method: "POST",
      json: input,
    }),
  updateItem: (
    itemId: string,
    patch: {
      name?: string;
      parentId?: string | null;
      sortOrder?: number;
      description?: string | null;
      request?: RequestConfig;
    },
  ) => api(`/api/v1/items/${itemId}`, { method: "PATCH", json: patch }),
  removeItem: (itemId: string) => api(`/api/v1/items/${itemId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// documents（workspace 级目录/文档树）
// ---------------------------------------------------------------------------
export const documentsApi = {
  tree: (workspaceId: string) =>
    api<DocumentItem[]>(`/api/v1/workspaces/${workspaceId}/documents`),
  createItem: (
    workspaceId: string,
    input: { parentId?: string | null; type: "folder" | "document"; name: string },
  ) =>
    api<DocumentItem>(`/api/v1/workspaces/${workspaceId}/documents`, {
      method: "POST",
      json: input,
    }),
  updateItem: (
    documentId: string,
    patch: {
      name?: string;
      parentId?: string | null;
      sortOrder?: number;
      content?: string | null;
    },
  ) => api(`/api/v1/documents/${documentId}`, { method: "PATCH", json: patch }),
  /** 拖拽后全量重排：parentId + 同级 sortOrder */
  reorderTree: (
    workspaceId: string,
    items: { id: string; parentId: string | null; sortOrder: number }[],
  ) =>
    api(`/api/v1/workspaces/${workspaceId}/documents`, {
      method: "PATCH",
      json: { items },
    }),
  removeItem: (documentId: string) =>
    api(`/api/v1/documents/${documentId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// specs（workspace 级 API 定义）
// ---------------------------------------------------------------------------
export const specsApi = {
  list: (workspaceId: string) => api<Spec[]>(`/api/v1/workspaces/${workspaceId}/specs`),
  create: (
    workspaceId: string,
    input: { name: string; type: SpecType; format?: SpecFormat; content?: string },
  ) =>
    api<Spec>(`/api/v1/workspaces/${workspaceId}/specs`, {
      method: "POST",
      json: input,
    }),
  get: (specId: string) => api<Spec>(`/api/v1/specs/${specId}`),
  update: (
    specId: string,
    patch: { name?: string; format?: SpecFormat; content?: string },
  ) => api<Spec>(`/api/v1/specs/${specId}`, { method: "PATCH", json: patch }),
  remove: (specId: string) => api(`/api/v1/specs/${specId}`, { method: "DELETE" }),
  /** 由定义生成 Collection；replaceLinked 为 true 时覆写已关联的 Collection */
  generateCollection: (specId: string, options: { replaceLinked?: boolean } = {}) =>
    api<{
      collectionId: string;
      reused: boolean;
      folderCount: number;
      requestCount: number;
    }>(`/api/v1/specs/${specId}/generate-collection`, {
      method: "POST",
      json: options,
    }),
};

// ---------------------------------------------------------------------------
// environments
// ---------------------------------------------------------------------------
export const environmentsApi = {
  list: (workspaceId: string) =>
    api<Environment[]>(`/api/v1/workspaces/${workspaceId}/environments`),
  create: (workspaceId: string, name: string, variables: Environment["variables"] = []) =>
    api<Environment>(`/api/v1/workspaces/${workspaceId}/environments`, {
      method: "POST",
      json: { name, variables },
    }),
  update: (environmentId: string, patch: { name?: string; variables?: Environment["variables"] }) =>
    api(`/api/v1/environments/${environmentId}`, { method: "PATCH", json: patch }),
  remove: (environmentId: string) =>
    api(`/api/v1/environments/${environmentId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// history & execute
// ---------------------------------------------------------------------------
export const historyApi = {
  list: (workspaceId: string, limit = 50) =>
    api<HistoryEntry[]>(`/api/v1/workspaces/${workspaceId}/history?limit=${limit}`),
  clear: (workspaceId: string) =>
    api(`/api/v1/workspaces/${workspaceId}/history`, { method: "DELETE" }),
};

export const executeApi = {
  run: (input: ExecuteRequestInput) =>
    api<ExecuteResult>("/api/v1/execute", { method: "POST", json: input }),
};

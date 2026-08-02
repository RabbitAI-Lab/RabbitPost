import type {
  ApiKey,
  ApiKeyWithToken,
  Collection,
  CollectionItem,
  CollectionShare,
  DocumentItem,
  Environment,
  ExecuteRequestInput,
  ExecuteResult,
  HistoryEntry,
  RequestCase,
  RequestConfig,
  RunJob,
  RunJobDetail,
  Runner,
  RunnerStatus,
  RunnerWithToken,
  RunReport,
  RunSource,
  RunTargetType,
  ScenarioStep,
  ScenarioStepWithDiff,
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

/** 个人 API Key（CLI 凭证；仅限浏览器会话管理） */
export const apiKeysApi = {
  list: () => api<ApiKey[]>("/api/v1/auth/api-keys"),
  /** 创建后明文 Token 仅此一次返回 */
  create: (name: string) =>
    api<ApiKeyWithToken>("/api/v1/auth/api-keys", { method: "POST", json: { name } }),
  remove: (keyId: string) => api(`/api/v1/auth/api-keys/${keyId}`, { method: "DELETE" }),
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
  update: (
    collectionId: string,
    patch: { name?: string; description?: string | null; variables?: Collection["variables"] },
  ) => api(`/api/v1/collections/${collectionId}`, { method: "PATCH", json: patch }),
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
    input: { parentId?: string | null; type: "folder" | "request" | "scenario"; name: string },
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
  /** 公开分享链接：未分享时 share 为 null */
  share: (collectionId: string) =>
    api<{ share: CollectionShare | null }>(
      `/api/v1/collections/${collectionId}/share`,
    ),
  createShare: (collectionId: string) =>
    api<{ share: CollectionShare }>(`/api/v1/collections/${collectionId}/share`, {
      method: "POST",
    }),
  revokeShare: (collectionId: string) =>
    api<{ revoked: boolean }>(`/api/v1/collections/${collectionId}/share`, {
      method: "DELETE",
    }),
};

// ---------------------------------------------------------------------------
// request cases（接口用例：新建时继承接口配置快照，之后独立修改执行）
// ---------------------------------------------------------------------------
export const casesApi = {
  list: (itemId: string) => api<RequestCase[]>(`/api/v1/items/${itemId}/cases`),
  /** 新建用例；默认服务端拷贝接口当前配置，传 request 可复制已有用例 */
  create: (
    itemId: string,
    input: { name?: string; description?: string; request?: RequestConfig } = {},
  ) =>
    api<RequestCase>(`/api/v1/items/${itemId}/cases`, {
      method: "POST",
      json: input,
    }),
  update: (
    caseId: string,
    patch: {
      name?: string;
      description?: string | null;
      request?: RequestConfig;
      sortOrder?: number;
    },
  ) => api<RequestCase>(`/api/v1/cases/${caseId}`, { method: "PATCH", json: patch }),
  remove: (caseId: string) =>
    api<{ deleted: boolean }>(`/api/v1/cases/${caseId}`, { method: "DELETE" }),
  /** 从接口当前配置重新继承（覆盖用例快照） */
  reset: (caseId: string) =>
    api<RequestCase>(`/api/v1/cases/${caseId}/reset`, { method: "POST" }),
  /** 用例运行历史（服务端持久化，targetType=case 的 run_jobs） */
  listRuns: (itemId: string, limit = 50) =>
    api<RunJob[]>(`/api/v1/items/${itemId}/case-runs?limit=${limit}`),
  /** 上报一次用例运行：single 单条（caseId 必填）/ batch Run All 聚合 */
  createRun: (
    itemId: string,
    input: {
      kind: "single" | "batch";
      caseId?: string | null;
      environmentId?: string | null;
      startedAt: string;
      finishedAt: string;
      results: {
        itemId?: string | null;
        caseId?: string | null;
        name: string;
        method: string;
        url: string;
        ok: boolean;
        status?: number | null;
        statusText?: string | null;
        sizeBytes?: number | null;
        durationMs?: number | null;
        error?: string | null;
        testResults?: { name: string; passed: boolean; error?: string }[] | null;
        consoleLogs?: { level: string; args: string[] }[] | null;
      }[];
    },
  ) =>
    api<RunJob>(`/api/v1/items/${itemId}/case-runs`, {
      method: "POST",
      json: input,
    }),
};

// ---------------------------------------------------------------------------
// scenarios（场景测试：步骤 CRUD + 同步）
// ---------------------------------------------------------------------------
export const scenariosApi = {
  /** 获取步骤列表（含差异状态） */
  listSteps: (scenarioId: string) =>
    api<ScenarioStepWithDiff[]>(`/api/v1/scenarios/${scenarioId}/steps`),
  /** 添加步骤（从已有接口导入快照或新建空步骤） */
  addStep: (
    scenarioId: string,
    input: { sourceItemId?: string; name?: string; request?: RequestConfig },
  ) =>
    api<ScenarioStep>(`/api/v1/scenarios/${scenarioId}/steps`, {
      method: "POST",
      json: input,
    }),
  /** 批量重排步骤 */
  reorderSteps: (scenarioId: string, orderedIds: string[]) =>
    api(`/api/v1/scenarios/${scenarioId}/steps`, {
      method: "PATCH",
      json: { orderedIds },
    }),
  /** 更新单个步骤 */
  updateStep: (
    stepId: string,
    patch: { name?: string; sortOrder?: number; request?: RequestConfig },
  ) => api(`/api/v1/scenario-steps/${stepId}`, { method: "PATCH", json: patch }),
  /** 删除步骤 */
  deleteStep: (stepId: string) =>
    api(`/api/v1/scenario-steps/${stepId}`, { method: "DELETE" }),
  /** 同步单个步骤的源接口最新配置 */
  syncStep: (stepId: string) =>
    api(`/api/v1/scenario-steps/${stepId}/sync`, { method: "POST" }),
  /** 批量同步 outdated 步骤 */
  syncAllSteps: (scenarioId: string, stepIds: string[]) =>
    api<{ synced: string[]; failed: { stepId: string; error: string }[] }>(
      `/api/v1/scenarios/${scenarioId}/steps/sync-all`,
      { method: "POST", json: { stepIds } },
    ),
};

// ---------------------------------------------------------------------------
// import（服务端代取在线链接，规避浏览器 CORS）
// ---------------------------------------------------------------------------
export const importApi = {
  fetchUrl: (url: string) =>
    api<{ text: string; contentType: string | null; finalUrl: string }>(
      "/api/v1/import/fetch",
      { method: "POST", json: { url } },
    ),
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

// ---------------------------------------------------------------------------
// runners & runs（Runner CLI：注册 / Token / 任务派发；均要求团队 admin+）
// ---------------------------------------------------------------------------
export const runnersApi = {
  list: (teamId: string) => api<Runner[]>(`/api/v1/teams/${teamId}/runners`),
  /** 注册 Runner；明文 Token 仅此一次返回 */
  register: (teamId: string, input: { name: string; description?: string }) =>
    api<RunnerWithToken>(`/api/v1/teams/${teamId}/runners`, {
      method: "POST",
      json: input,
    }),
  update: (
    runnerId: string,
    patch: { name?: string; description?: string | null; status?: RunnerStatus },
  ) => api<Runner>(`/api/v1/runners/${runnerId}`, { method: "PATCH", json: patch }),
  remove: (runnerId: string) =>
    api(`/api/v1/runners/${runnerId}`, { method: "DELETE" }),
  /** 重新生成 Token：旧 Token 立即失效 */
  regenerateToken: (runnerId: string) =>
    api<RunnerWithToken>(`/api/v1/runners/${runnerId}/token`, { method: "POST" }),
};

export const runsApi = {
  list: (teamId: string, limit = 50) =>
    api<RunJob[]>(`/api/v1/teams/${teamId}/runs?limit=${limit}`),
  /** 某个 Collection 的执行记录（派发 + CLI 上传），Runs tab 使用 */
  listByCollection: (collectionId: string, limit = 50) =>
    api<RunJob[]>(`/api/v1/collections/${collectionId}/runs?limit=${limit}`),
  dispatch: (
    teamId: string,
    input: {
      workspaceId: string;
      runnerId?: string | null;
      targetType: RunTargetType;
      targetId: string;
      environmentId?: string | null;
      concurrency?: number;
    },
  ) => api<RunJob>(`/api/v1/teams/${teamId}/runs`, { method: "POST", json: input }),
  /** 上传一次 Collection 级运行报告（Web Runner 直接执行后上报） */
  uploadRun: (
    collectionId: string,
    report: RunReport & { source?: RunSource },
  ) =>
    api<RunJob>(`/api/v1/collections/${collectionId}/runs`, {
      method: "POST",
      json: report,
    }),
  get: (jobId: string) => api<RunJobDetail>(`/api/v1/runs/${jobId}`),
  cancel: (jobId: string) => api(`/api/v1/runs/${jobId}`, { method: "DELETE" }),
  /** 下载执行报告（JUnit XML / 自包含 HTML），返回原始文本 */
  downloadReport: async (jobId: string, format: "junit" | "html"): Promise<string> => {
    const resp = await fetch(`/api/v1/runs/${jobId}/report?format=${format}`, {
      credentials: "include",
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || resp.statusText);
    }
    return resp.text();
  },
};

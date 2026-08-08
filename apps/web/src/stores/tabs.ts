import type {
  Collection,
  CollectionItem,
  DocumentItem,
  Environment,
  EnvironmentVariable,
  ExecuteResult,
  HistoryEntry,
  HttpMethod,
  KeyValueItem,
  RequestCase,
  RequestConfig,
  RequestProtocol,
  Spec,
  SpecFormat,
  SpecType,
} from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { createRequestConfigForProtocol } from "../lib/protocols";
import { create } from "zustand";

export interface RequestTab {
  kind: "request";
  key: string;
  /** 关联的 collection item；未保存的草稿为 null；用例 tab 为所属接口的 itemId */
  itemId: string | null;
  collectionId: string | null;
  /** 用例 tab：关联的 request case id（保存/重置的目标是 case）；普通请求 tab 为 null */
  caseId?: string | null;
  /** 场景步骤 tab：关联的 scenario step id（保存目标是 scenario_steps）；普通请求 tab 为 null */
  stepId?: string | null;
  name: string;
  config: RequestConfig;
  /** 打开时的快照，用于 dirty 判断（草稿/历史也记录初始快照，未修改不算 dirty） */
  savedSnapshot: string | null;
  response: ExecuteResult | null;
  sending: boolean;
  saving: boolean;
}

/** Collection 详情 tab（Overview/Authorization/Scripts/Variables/Runs） */
export interface CollectionTab {
  kind: "collection";
  key: string;
  collectionId: string;
  name: string;
  /** Overview 的 Markdown 内容（即 collection.description） */
  description: string;
  /** Collection 级变量（即 collection.variables） */
  variables: KeyValueItem[];
  /** 打开/保存时的快照（description + variables），用于 dirty 判断 */
  savedSnapshot: string;
  saving: boolean;
}

/** 文件夹详情 tab（Overview/Authorization/Scripts） */
export interface FolderTab {
  kind: "folder";
  key: string;
  itemId: string;
  collectionId: string;
  name: string;
  /** Overview 的 Markdown 内容（即 item.description） */
  description: string;
  /** 打开/保存时的快照，用于 dirty 判断 */
  savedSnapshot: string;
  saving: boolean;
}

/** Document 编辑 tab（Markdown 正文） */
export interface DocumentTab {
  kind: "document";
  key: string;
  documentId: string;
  name: string;
  /** 文档正文（Markdown，即 item.content）；字段名与 Collection/文件夹 tab 一致以复用保存逻辑 */
  description: string;
  /** 打开/保存时的快照，用于 dirty 判断 */
  savedSnapshot: string;
  saving: boolean;
}

/** Spec 编辑 tab（定义编辑器 + Issues + 文档预览） */
export interface SpecTab {
  kind: "spec";
  key: string;
  specId: string;
  name: string;
  type: SpecType;
  format: SpecFormat;
  /** 定义正文（YAML / JSON 文本） */
  content: string;
  /** 已关联的 Collection（由本 spec 生成） */
  generatedCollectionId: string | null;
  /** 打开/保存时的快照（name + format + content），用于 dirty 判断 */
  savedSnapshot: string;
  saving: boolean;
}

/** Environment 编辑 tab（标题 + 变量表格） */
export interface EnvironmentTab {
  kind: "environment";
  key: string;
  environmentId: string;
  name: string;
  variables: EnvironmentVariable[];
  /** 打开/保存时的快照（name + variables），用于 dirty 判断 */
  savedSnapshot: string;
  saving: boolean;
}

/**
 * CLI 中心 tab（团队 admin+ 可见）的分区：
 * runner-admin：Runner 注册与 Token 管理；runner-cli：Runner CLI 安装引导；
 * rabbitpost-cli：RabbitPost CLI（与 Runner 无关的本机命令行客户端）。
 */
export type CliSection = "runner-admin" | "runner-cli" | "rabbitpost-cli";

export interface CliTab {
  kind: "cli";
  key: string;
  name: string;
  section: CliSection;
}

/** 个人中心 tab（单例，key 固定 profile） */
export interface ProfileTab {
  kind: "profile";
  key: string;
  name: string;
}

/** Collection Runner tab：编排请求执行顺序并批量运行 */
export interface RunnerTab {
  kind: "runner";
  key: string;
  collectionId: string;
  name: string;
}

/** 场景测试编辑 tab（步骤列表 + 编排 + 执行） */
export interface ScenarioTab {
  kind: "scenario";
  key: string;
  scenarioId: string;
  collectionId: string;
  name: string;
  saving: boolean;
}

export type WorkTab =
  | RequestTab
  | CollectionTab
  | FolderTab
  | DocumentTab
  | SpecTab
  | EnvironmentTab
  | CliTab
  | ProfileTab
  | RunnerTab
  | ScenarioTab;

function envSnapshot(name: string, variables: EnvironmentVariable[]): string {
  return JSON.stringify({ name, variables });
}

/** Collection tab 快照：同时跟踪 Overview 文档与 Collection 变量 */
function collectionSnapshot(description: string, variables: KeyValueItem[]): string {
  return JSON.stringify({ description, variables });
}

function specSnapshot(tab: Pick<SpecTab, "name" | "format" | "content">): string {
  return JSON.stringify({ name: tab.name, format: tab.format, content: tab.content });
}

let draftSeq = 1;

function snapshot(config: RequestConfig): string {
  return JSON.stringify(config);
}

interface TabsState {
  tabs: WorkTab[];
  activeKey: string | null;

  /** 新建草稿；method 缺省为 GET，可传入以继承上一个 tab 的请求方法 */
  openDraft: (method?: HttpMethod, protocol?: RequestProtocol) => void;
  openFromItem: (item: CollectionItem) => void;
  /** 打开接口用例编辑 tab（复用 RequestEditor；同一用例复用同一 tab） */
  openCase: (item: Pick<CollectionItem, "id" | "collectionId">, caseRow: RequestCase) => void;
  openFromHistory: (entry: HistoryEntry) => void;
  openCollection: (collection: Collection) => void;
  openFolder: (item: CollectionItem) => void;
  openDocument: (item: DocumentItem) => void;
  openSpec: (spec: Spec) => void;
  openEnvironment: (env: Environment) => void;
  /** 打开 CLI 中心并定位到指定分区；已打开则复用同一个 tab */
  openCli: (section: CliSection) => void;
  openProfile: () => void;
  /** 打开 Collection Runner tab（同一 Collection 复用同一 tab） */
  openRunner: (collection: Collection) => void;
  /** 打开场景测试编辑 tab（同一场景复用同一 tab） */
  openScenario: (item: CollectionItem) => void;
  /** 打开场景步骤的请求编辑 tab（复用 RequestEditor，保存时写回 scenario_steps） */
  openScenarioStep: (step: { id: string; name: string; request: RequestConfig }, scenarioItem: Pick<CollectionItem, "id" | "collectionId">) => void;
  /** 切换 CLI 中心的分区 */
  setCliSection: (key: string, section: CliSection) => void;
  /** 更新 Spec tab 的名称 / 格式 / 定义正文 */
  updateSpec: (
    key: string,
    patch: Partial<Pick<SpecTab, "name" | "format" | "content" | "generatedCollectionId">>,
  ) => void;
  /** Spec 保存后刷新快照 */
  markSpecSaved: (key: string) => void;
  /** 更新 Environment tab 的名称 / 变量 */
  updateEnvironment: (
    key: string,
    patch: Partial<Pick<EnvironmentTab, "name" | "variables">>,
  ) => void;
  /** Environment 保存后刷新快照 */
  markEnvironmentSaved: (key: string) => void;
  /** 更新 Collection/文件夹/Document tab 的 Markdown 内容 */
  updateDocDescription: (key: string, description: string) => void;
  /** 更新 Collection tab 的变量列表 */
  updateCollectionVariables: (key: string, variables: KeyValueItem[]) => void;
  /** Overview 文档 / Collection 变量保存后刷新快照 */
  markDocSaved: (key: string) => void;
  closeTab: (key: string) => void;
  /** 关闭除 key 外的所有 tab（调用方需先处理未保存确认） */
  closeOtherTabs: (key: string) => void;
  /** 关闭所有 tab（调用方需先处理未保存确认） */
  closeAllTabs: () => void;
  /** 复制请求 tab 为新草稿（紧跟在原 tab 之后）；仅支持普通请求 tab */
  duplicateTab: (key: string) => void;
  setActive: (key: string) => void;
  updateConfig: (key: string, patch: Partial<RequestConfig>) => void;
  /** 整体替换请求配置（用例 Reset from request 后同步 tab 内容） */
  replaceConfig: (key: string, config: RequestConfig) => void;
  setSending: (key: string, sending: boolean) => void;
  setSaving: (key: string, saving: boolean) => void;
  setResponse: (key: string, response: ExecuteResult | null) => void;
  markSaved: (key: string, itemId: string, collectionId: string, name: string) => void;
  renameTab: (key: string, name: string) => void;
  /** 场景步骤保存后的回调（由 ScenarioEditor 注册，用于刷新步骤列表） */
  onScenarioStepSaved: (() => void) | null;
  setOnScenarioStepSaved: (cb: (() => void) | null) => void;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeKey: null,
  onScenarioStepSaved: null,
  setOnScenarioStepSaved: (cb) => set({ onScenarioStepSaved: cb }),

  openDraft: (method, protocol) => {
    const key = `draft-${draftSeq++}`;
    // 指定协议时按协议生成初始配置（含 GraphQL 的 POST + body 联动）；否则空 HTTP 配置
    const config = protocol
      ? createRequestConfigForProtocol(protocol)
      : createEmptyRequestConfig();
    if (method) config.method = method;
    const tab: RequestTab = {
      kind: "request",
      key,
      itemId: null,
      collectionId: null,
      name: "New Request",
      config,
      savedSnapshot: snapshot(config),
      response: null,
      sending: false,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openFromItem: (item) => {
    // 用例 tab 的 itemId 也是所属接口 id，查重时需排除，避免打开接口时激活到用例 tab
    const existing = get().tabs.find(
      (t) => t.kind === "request" && t.itemId === item.id && !t.caseId,
    );
    if (existing) {
      set({ activeKey: existing.key });
      return;
    }
    const config = item.request ?? createEmptyRequestConfig();
    const tab: RequestTab = {
      kind: "request",
      key: `item-${item.id}`,
      itemId: item.id,
      collectionId: item.collectionId,
      name: item.name,
      config,
      savedSnapshot: snapshot(config),
      response: null,
      sending: false,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: tab.key }));
  },

  openCase: (item, caseRow) => {
    const key = `case-${caseRow.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: RequestTab = {
      kind: "request",
      key,
      itemId: item.id,
      collectionId: item.collectionId,
      caseId: caseRow.id,
      name: caseRow.name,
      config: caseRow.request,
      savedSnapshot: snapshot(caseRow.request),
      response: null,
      sending: false,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openFromHistory: (entry) => {
    const key = `history-${entry.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const config = entry.request;
    // 从历史记录的响应摘要重构 ExecuteResult，使响应区能回填当时的返回数据
    const response: ExecuteResult | null = entry.response
      ? {
          ok: true,
          status: entry.response.status,
          statusText: entry.response.statusText,
          sizeBytes: entry.response.sizeBytes,
          durationMs: entry.response.durationMs,
          headers: entry.response.headers,
          bodyText: entry.response.bodyText,
          bodyBase64: entry.response.bodyBase64,
          cookies: entry.response.cookies,
          testResults: entry.response.testResults ?? [],
          consoleLogs: entry.response.consoleLogs ?? [],
        }
      : entry.error
        ? { ok: false, error: entry.error, testResults: [], consoleLogs: [] }
        : null;
    const tab: RequestTab = {
      kind: "request",
      key,
      itemId: null,
      collectionId: null,
      name: entry.name || config.url || "History Request",
      config,
      savedSnapshot: snapshot(config),
      response,
      sending: false,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openCollection: (collection) => {
    const key = `col-${collection.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: CollectionTab = {
      kind: "collection",
      key,
      collectionId: collection.id,
      name: collection.name,
      description: collection.description ?? "",
      variables: collection.variables ?? [],
      savedSnapshot: collectionSnapshot(
        collection.description ?? "",
        collection.variables ?? [],
      ),
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openFolder: (item) => {
    const key = `folder-${item.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: FolderTab = {
      kind: "folder",
      key,
      itemId: item.id,
      collectionId: item.collectionId,
      name: item.name,
      description: item.description ?? "",
      savedSnapshot: item.description ?? "",
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openDocument: (item) => {
    const key = `doc-${item.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: DocumentTab = {
      kind: "document",
      key,
      documentId: item.id,
      name: item.name,
      description: item.content ?? "",
      savedSnapshot: item.content ?? "",
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openEnvironment: (env) => {
    const key = `env-${env.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: EnvironmentTab = {
      kind: "environment",
      key,
      environmentId: env.id,
      name: env.name,
      variables: env.variables,
      savedSnapshot: envSnapshot(env.name, env.variables),
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  updateEnvironment: (key, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "environment" ? { ...t, ...patch } : t,
      ),
    })),

  openSpec: (spec) => {
    const key = `spec-${spec.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: SpecTab = {
      kind: "spec",
      key,
      specId: spec.id,
      name: spec.name,
      type: spec.type,
      format: spec.format,
      content: spec.content,
      generatedCollectionId: spec.generatedCollectionId,
      savedSnapshot: specSnapshot(spec),
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  updateSpec: (key, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key && t.kind === "spec" ? { ...t, ...patch } : t)),
    })),

  openCli: (section) => {
    const key = "cli";
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key && t.kind === "cli" ? { ...t, section } : t,
        ),
        activeKey: key,
      }));
      return;
    }
    const tab: CliTab = { kind: "cli", key, name: "CLI", section };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  setCliSection: (key, section) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key && t.kind === "cli" ? { ...t, section } : t)),
    })),

  openProfile: () => {
    const key = "profile";
    if (get().tabs.some((t) => t.key === key)) {
      set({ activeKey: key });
      return;
    }
    const tab: ProfileTab = { kind: "profile", key, name: "个人中心" };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openRunner: (collection) => {
    const key = `runner-${collection.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: RunnerTab = {
      kind: "runner",
      key,
      collectionId: collection.id,
      name: `Run ${collection.name}`,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openScenario: (item) => {
    const key = `scenario-${item.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: ScenarioTab = {
      kind: "scenario",
      key,
      scenarioId: item.id,
      collectionId: item.collectionId,
      name: item.name,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  openScenarioStep: (step, scenarioItem) => {
    const key = `step-${step.id}`;
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    const tab: RequestTab = {
      kind: "request",
      key,
      itemId: scenarioItem.id,
      collectionId: scenarioItem.collectionId,
      stepId: step.id,
      name: step.name,
      config: step.request,
      savedSnapshot: snapshot(step.request),
      response: null,
      sending: false,
      saving: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
  },

  markSpecSaved: (key) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "spec" ? { ...t, savedSnapshot: specSnapshot(t) } : t,
      ),
    })),

  markEnvironmentSaved: (key) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "environment"
          ? { ...t, savedSnapshot: envSnapshot(t.name, t.variables) }
          : t,
      ),
    })),

  updateDocDescription: (key, description) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key &&
        (t.kind === "collection" || t.kind === "folder" || t.kind === "document")
          ? { ...t, description }
          : t,
      ),
    })),

  updateCollectionVariables: (key, variables) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "collection" ? { ...t, variables } : t,
      ),
    })),

  markDocSaved: (key) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.key !== key) return t;
        // Collection tab 的快照含 description + variables
        if (t.kind === "collection") {
          return {
            ...t,
            savedSnapshot: collectionSnapshot(t.description, t.variables),
          };
        }
        if (t.kind === "folder" || t.kind === "document") {
          return { ...t, savedSnapshot: t.description };
        }
        return t;
      }),
    })),

  closeTab: (key) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeKey =
        s.activeKey === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeKey;
      return { tabs, activeKey };
    });
  },

  closeOtherTabs: (key) => {
    set((s) => {
      if (!s.tabs.some((t) => t.key === key)) return s;
      return { tabs: s.tabs.filter((t) => t.key === key), activeKey: key };
    });
  },

  closeAllTabs: () => set({ tabs: [], activeKey: null }),

  duplicateTab: (key) => {
    const source = get().tabs.find((t) => t.key === key);
    // 用例 / 场景步骤 tab 有独立保存目标，不允许复制
    if (!source || source.kind !== "request" || source.caseId || source.stepId) return;
    const config = JSON.parse(JSON.stringify(source.config)) as RequestConfig;
    const tab: RequestTab = {
      kind: "request",
      key: `draft-${draftSeq++}`,
      itemId: null,
      collectionId: source.collectionId,
      name: `${source.name} 副本`,
      config,
      // 副本内容与快照一致，初始不算 dirty
      savedSnapshot: snapshot(config),
      response: null,
      sending: false,
      saving: false,
    };
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.key === key);
      const tabs = [...s.tabs];
      tabs.splice(idx + 1, 0, tab);
      return { tabs, activeKey: tab.key };
    });
  },

  setActive: (key) => set({ activeKey: key }),

  updateConfig: (key, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request"
          ? { ...t, config: { ...t.config, ...patch } }
          : t,
      ),
    })),

  replaceConfig: (key, config) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request" ? { ...t, config } : t,
      ),
    })),

  setSending: (key, sending) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request" ? { ...t, sending } : t,
      ),
    })),

  setSaving: (key, saving) =>
    set((s) => ({
      // CLI 中心无保存态，跳过
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind !== "cli" ? { ...t, saving } : t,
      ),
    })),

  setResponse: (key, response) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request" ? { ...t, response } : t,
      ),
    })),

  markSaved: (key, itemId, collectionId, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request"
          ? {
              ...t,
              itemId,
              collectionId,
              name,
              savedSnapshot: snapshot(t.config),
            }
          : t,
      ),
    })),

  renameTab: (key, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, name } : t)),
    })),
}));

export function isTabDirty(tab: WorkTab): boolean {
  if (tab.kind === "cli" || tab.kind === "profile" || tab.kind === "runner" || tab.kind === "scenario") return false;
  if (tab.kind === "environment")
    return envSnapshot(tab.name, tab.variables) !== tab.savedSnapshot;
  if (tab.kind === "spec") return specSnapshot(tab) !== tab.savedSnapshot;
  if (tab.kind === "collection") {
    return collectionSnapshot(tab.description, tab.variables) !== tab.savedSnapshot;
  }
  if (tab.kind !== "request") return tab.description !== tab.savedSnapshot;
  if (tab.savedSnapshot === null) return true;
  return snapshot(tab.config) !== tab.savedSnapshot;
}

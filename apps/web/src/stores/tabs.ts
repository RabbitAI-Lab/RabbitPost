import type {
  Collection,
  CollectionItem,
  DocumentItem,
  Environment,
  EnvironmentVariable,
  ExecuteResult,
  HttpMethod,
  RequestConfig,
  Spec,
  SpecFormat,
  SpecType,
} from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { create } from "zustand";

export interface RequestTab {
  kind: "request";
  key: string;
  /** 关联的 collection item；未保存的草稿为 null */
  itemId: string | null;
  collectionId: string | null;
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
  /** 打开/保存时的快照，用于 dirty 判断 */
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

export type WorkTab =
  | RequestTab
  | CollectionTab
  | FolderTab
  | DocumentTab
  | SpecTab
  | EnvironmentTab;

function envSnapshot(name: string, variables: EnvironmentVariable[]): string {
  return JSON.stringify({ name, variables });
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
  openDraft: (method?: HttpMethod) => void;
  openFromItem: (item: CollectionItem) => void;
  openFromHistory: (name: string, config: RequestConfig) => void;
  openCollection: (collection: Collection) => void;
  openFolder: (item: CollectionItem) => void;
  openDocument: (item: DocumentItem) => void;
  openSpec: (spec: Spec) => void;
  openEnvironment: (env: Environment) => void;
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
  /** Overview 文档保存后刷新快照 */
  markDocSaved: (key: string) => void;
  closeTab: (key: string) => void;
  setActive: (key: string) => void;
  updateConfig: (key: string, patch: Partial<RequestConfig>) => void;
  setSending: (key: string, sending: boolean) => void;
  setSaving: (key: string, saving: boolean) => void;
  setResponse: (key: string, response: ExecuteResult | null) => void;
  markSaved: (key: string, itemId: string, collectionId: string, name: string) => void;
  renameTab: (key: string, name: string) => void;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeKey: null,

  openDraft: (method) => {
    const key = `draft-${draftSeq++}`;
    const config = createEmptyRequestConfig();
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
    const existing = get().tabs.find(
      (t) => t.kind === "request" && t.itemId === item.id,
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

  openFromHistory: (name, config) => {
    const key = `history-${Date.now()}`;
    const tab: RequestTab = {
      kind: "request",
      key,
      itemId: null,
      collectionId: null,
      name: name || config.url || "History Request",
      config,
      savedSnapshot: snapshot(config),
      response: null,
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
      savedSnapshot: collection.description ?? "",
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

  markDocSaved: (key) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key &&
        (t.kind === "collection" || t.kind === "folder" || t.kind === "document")
          ? { ...t, savedSnapshot: t.description }
          : t,
      ),
    })),

  closeTab: (key) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeKey =
        s.activeKey === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeKey;
      return { tabs, activeKey };
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

  setSending: (key, sending) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key && t.kind === "request" ? { ...t, sending } : t,
      ),
    })),

  setSaving: (key, saving) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, saving } : t)),
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
  if (tab.kind === "environment")
    return envSnapshot(tab.name, tab.variables) !== tab.savedSnapshot;
  if (tab.kind === "spec") return specSnapshot(tab) !== tab.savedSnapshot;
  if (tab.kind !== "request") return tab.description !== tab.savedSnapshot;
  if (tab.savedSnapshot === null) return true;
  return snapshot(tab.config) !== tab.savedSnapshot;
}

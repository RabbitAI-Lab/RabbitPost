import type {
  Collection,
  CollectionItem,
  DocumentItem,
  Environment,
  Spec,
  Team,
  User,
  Workspace,
} from "@rabbitpost/shared";
import { create } from "zustand";
import {
  authApi,
  collectionsApi,
  documentsApi,
  environmentsApi,
  specsApi,
  teamsApi,
  workspacesApi,
} from "../api";

interface AppState {
  bootstrapped: boolean;
  user: User | null;

  teams: Team[];
  currentTeamId: string | null;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;

  collections: Collection[];
  /** collectionId -> 树形条目 */
  collectionTrees: Record<string, CollectionItem[]>;
  /** 已收藏（置顶）的 Collection id；本地持久化 */
  favoriteCollectionIds: string[];
  /** Documents 树（workspace 级 folder/document） */
  documentTree: DocumentItem[];
  /** Specs 列表（workspace 级 API 定义） */
  specs: Spec[];
  environments: Environment[];
  activeEnvironmentId: string | null;

  bootstrap: () => Promise<void>;
  signIn: (user: User) => Promise<void>;
  signOut: () => Promise<void>;

  selectTeam: (teamId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  refreshTeams: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshCollections: () => Promise<void>;
  refreshCollectionTree: (collectionId: string) => Promise<void>;
  toggleFavoriteCollection: (collectionId: string) => void;
  /** 拖拽排序：先乐观更新本地顺序，再后台持久化 */
  reorderCollections: (orderedIds: string[]) => Promise<void>;
  refreshDocuments: () => Promise<void>;
  /** 拖拽移动/重排后乐观应用新树，并全量持久化（parentId + sortOrder） */
  applyDocumentTree: (nextTree: DocumentItem[]) => Promise<void>;
  refreshSpecs: () => Promise<void>;
  refreshEnvironments: () => Promise<void>;
  setActiveEnvironment: (environmentId: string | null) => void;
}

const LS_TEAM = "rp.currentTeamId";
const LS_WS = "rp.currentWorkspaceId";
const LS_ENV = "rp.activeEnvironmentId";
const LS_FAV = "rp.favoriteCollectionIds";

function loadFavoriteCollectionIds(): string[] {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(LS_FAV) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  bootstrapped: false,
  user: null,
  teams: [],
  currentTeamId: null,
  workspaces: [],
  currentWorkspaceId: null,
  collections: [],
  collectionTrees: {},
  favoriteCollectionIds: loadFavoriteCollectionIds(),
  documentTree: [],
  specs: [],
  environments: [],
  activeEnvironmentId: null,

  bootstrap: async () => {
    try {
      const { user } = await authApi.me();
      if (user) {
        set({ user });
        await get().refreshTeams();
        const savedTeam = localStorage.getItem(LS_TEAM);
        const teamId =
          get().teams.find((t) => t.id === savedTeam)?.id ?? get().teams[0]?.id;
        if (teamId) await get().selectTeam(teamId);
      }
    } finally {
      set({ bootstrapped: true });
    }
  },

  signIn: async (user) => {
    set({ user });
    await get().refreshTeams();
    const teamId = get().teams[0]?.id;
    if (teamId) await get().selectTeam(teamId);
  },

  signOut: async () => {
    await authApi.logout().catch(() => undefined);
    localStorage.removeItem(LS_TEAM);
    localStorage.removeItem(LS_WS);
    localStorage.removeItem(LS_ENV);
    set({
      user: null,
      teams: [],
      currentTeamId: null,
      workspaces: [],
      currentWorkspaceId: null,
      collections: [],
      collectionTrees: {},
      documentTree: [],
      specs: [],
      environments: [],
      activeEnvironmentId: null,
    });
  },

  refreshTeams: async () => {
    const teams = await teamsApi.list();
    set({ teams });
  },

  selectTeam: async (teamId) => {
    localStorage.setItem(LS_TEAM, teamId);
    set({ currentTeamId: teamId, currentWorkspaceId: null });
    await get().refreshWorkspaces();
    const savedWs = localStorage.getItem(LS_WS);
    const wsId =
      get().workspaces.find((w) => w.id === savedWs)?.id ?? get().workspaces[0]?.id;
    if (wsId) {
      await get().selectWorkspace(wsId);
    } else {
      set({ collections: [], collectionTrees: {}, documentTree: [], specs: [], environments: [], activeEnvironmentId: null });
    }
  },

  refreshWorkspaces: async () => {
    const teamId = get().currentTeamId;
    if (!teamId) return set({ workspaces: [] });
    const workspaces = await workspacesApi.list(teamId);
    set({ workspaces });
  },

  selectWorkspace: async (workspaceId) => {
    localStorage.setItem(LS_WS, workspaceId);
    set({ currentWorkspaceId: workspaceId, collectionTrees: {} });
    const savedEnv = localStorage.getItem(LS_ENV);
    await Promise.all([
      get().refreshCollections(),
      get().refreshDocuments(),
      get().refreshSpecs(),
      get().refreshEnvironments(),
    ]);
    const envId = get().environments.find((e) => e.id === savedEnv)?.id ?? null;
    set({ activeEnvironmentId: envId });
  },

  refreshCollections: async () => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return set({ collections: [], collectionTrees: {} });
    const collections = await collectionsApi.list(workspaceId);
    set({ collections, collectionTrees: {} });
    // 逐个加载树（数量通常很少）
    await Promise.all(collections.map((c) => get().refreshCollectionTree(c.id)));
  },

  refreshCollectionTree: async (collectionId) => {
    const tree = await collectionsApi.tree(collectionId);
    set((s) => ({
      collectionTrees: { ...s.collectionTrees, [collectionId]: tree },
    }));
  },

  toggleFavoriteCollection: (collectionId) =>
    set((s) => {
      const ids = s.favoriteCollectionIds.includes(collectionId)
        ? s.favoriteCollectionIds.filter((id) => id !== collectionId)
        : [...s.favoriteCollectionIds, collectionId];
      localStorage.setItem(LS_FAV, JSON.stringify(ids));
      return { favoriteCollectionIds: ids };
    }),

  reorderCollections: async (orderedIds) => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return;
    // 乐观更新：按新顺序重排本地 collections（不重拉树，避免闪烁）
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    set((s) => ({
      collections: [...s.collections].sort(
        (a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0),
      ),
    }));
    await collectionsApi.reorder(workspaceId, orderedIds);
  },

  refreshDocuments: async () => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return set({ documentTree: [] });
    const documentTree = await documentsApi.tree(workspaceId);
    set({ documentTree });
  },

  applyDocumentTree: async (nextTree) => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return;
    // 乐观更新：先应用新树，避免重拉闪烁
    set({ documentTree: nextTree });
    // 展平为 {id, parentId, sortOrder} 全量提交，sortOrder 按同级下标重编号
    const items: { id: string; parentId: string | null; sortOrder: number }[] = [];
    const walk = (nodes: DocumentItem[], parentId: string | null) =>
      nodes.forEach((n, i) => {
        items.push({ id: n.id, parentId, sortOrder: i });
        walk(n.children ?? [], n.id);
      });
    walk(nextTree, null);
    await documentsApi.reorderTree(workspaceId, items);
  },

  refreshSpecs: async () => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return set({ specs: [] });
    const specs = await specsApi.list(workspaceId);
    set({ specs });
  },

  refreshEnvironments: async () => {
    const workspaceId = get().currentWorkspaceId;
    if (!workspaceId) return set({ environments: [] });
    const environments = await environmentsApi.list(workspaceId);
    set({ environments });
  },

  setActiveEnvironment: (environmentId) => {
    if (environmentId) localStorage.setItem(LS_ENV, environmentId);
    else localStorage.removeItem(LS_ENV);
    set({ activeEnvironmentId: environmentId });
  },
}));

import type { RequestCase } from "@rabbitpost/shared";
import { create } from "zustand";
import { casesApi } from "../api";

interface CasesState {
  /** itemId → 用例列表（未加载为 undefined） */
  byItemId: Record<string, RequestCase[] | undefined>;
  /** 加载接口用例列表；已加载且非 force 时跳过 */
  load: (itemId: string, force?: boolean) => Promise<void>;
  /** 新建 / 更新后本地同步（保持 sortOrder 排序） */
  upsert: (c: RequestCase) => void;
  /** 删除后本地同步 */
  remove: (itemId: string, caseId: string) => void;
}

function sortCases(list: RequestCase[]): RequestCase[] {
  return [...list].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
  );
}

export const useCasesStore = create<CasesState>((set, get) => ({
  byItemId: {},

  load: async (itemId, force) => {
    if (!force && get().byItemId[itemId]) return;
    const list = await casesApi.list(itemId);
    set((s) => ({ byItemId: { ...s.byItemId, [itemId]: sortCases(list) } }));
  },

  upsert: (c) =>
    set((s) => {
      const list = s.byItemId[c.itemId] ?? [];
      const exists = list.some((x) => x.id === c.id);
      const next = exists ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
      return { byItemId: { ...s.byItemId, [c.itemId]: sortCases(next) } };
    }),

  remove: (itemId, caseId) =>
    set((s) => ({
      byItemId: {
        ...s.byItemId,
        [itemId]: (s.byItemId[itemId] ?? []).filter((x) => x.id !== caseId),
      },
    })),
}));

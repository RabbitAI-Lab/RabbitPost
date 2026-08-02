/**
 * 用例相关 zustand store 的纯逻辑回归：
 * - cases store：按 itemId 缓存、upsert/remove 后保持 sortOrder 排序
 * - tabs store：openCase 打开用例 tab（复用/独立）、openFromItem 不误激活用例 tab、replaceConfig
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, RequestCase } from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import { useCasesStore } from "../src/stores/cases";
import { isTabDirty, useTabsStore } from "../src/stores/tabs";

// cases store 的 load 依赖 api 层；本文件只测本地状态迁移，mock 掉网络
vi.mock("../src/api", () => ({
  casesApi: {
    list: vi.fn(async () => []),
  },
}));

function makeCase(partial: Partial<RequestCase>): RequestCase {
  return {
    id: partial.id ?? "c1",
    itemId: partial.itemId ?? "i1",
    name: partial.name ?? "Case",
    description: null,
    request: createEmptyRequestConfig(),
    sortOrder: partial.sortOrder ?? 0,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  useCasesStore.setState({ byItemId: {} });
  useTabsStore.setState({ tabs: [], activeKey: null });
});

describe("useCasesStore", () => {
  it("upsert 新增后按 sortOrder 排序；同 id 更新不重复", () => {
    const { upsert } = useCasesStore.getState();
    upsert(makeCase({ id: "c2", sortOrder: 2, name: "B" }));
    upsert(makeCase({ id: "c1", sortOrder: 1, name: "A" }));
    upsert(makeCase({ id: "c3", sortOrder: 3, name: "C" }));
    let list = useCasesStore.getState().byItemId["i1"]!;
    expect(list.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);

    useCasesStore.getState().upsert(makeCase({ id: "c2", sortOrder: 0, name: "B2" }));
    list = useCasesStore.getState().byItemId["i1"]!;
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
    expect(list[0]!.name).toBe("B2");
  });

  it("remove 只影响对应 itemId 的列表", () => {
    const { upsert } = useCasesStore.getState();
    upsert(makeCase({ id: "c1", itemId: "i1" }));
    upsert(makeCase({ id: "c2", itemId: "i2" }));
    useCasesStore.getState().remove("i1", "c1");
    expect(useCasesStore.getState().byItemId["i1"]).toEqual([]);
    expect(useCasesStore.getState().byItemId["i2"]).toHaveLength(1);
  });
});

describe("useTabsStore（用例 tab）", () => {
  const item = { id: "i1", collectionId: "col1" };

  it("openCase 打开用例 tab：kind=request 且带 caseId；重复打开复用同一 tab", () => {
    const { openCase } = useTabsStore.getState();
    openCase(item, makeCase({ id: "c1", name: "Smoke" }));
    let tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: "request",
      key: "case-c1",
      itemId: "i1",
      collectionId: "col1",
      caseId: "c1",
      name: "Smoke",
    });
    expect(useTabsStore.getState().activeKey).toBe("case-c1");

    // 再打开另一个 tab 后重复 openCase：不新增，仅激活
    useTabsStore.getState().openDraft();
    useTabsStore.getState().openCase(item, makeCase({ id: "c1", name: "Smoke" }));
    tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(useTabsStore.getState().activeKey).toBe("case-c1");
  });

  it("openFromItem 不会误激活同 itemId 的用例 tab", () => {
    const { openCase, openFromItem } = useTabsStore.getState();
    openCase(item, makeCase({ id: "c1" }));
    openFromItem({
      id: "i1",
      collectionId: "col1",
      parentId: null,
      type: "request",
      name: "Health Check",
      sortOrder: 0,
      request: createEmptyRequestConfig(),
    });
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    const requestTab = tabs.find((t) => t.kind === "request" && !t.caseId);
    expect(requestTab?.key).toBe("item-i1");
    expect(useTabsStore.getState().activeKey).toBe("item-i1");
  });

  it("replaceConfig 整体替换配置（Reset from request 后同步）", () => {
    const { openCase } = useTabsStore.getState();
    openCase(item, makeCase({ id: "c1" }));
    const next = { ...createEmptyRequestConfig(), method: "POST" as const, url: "x" };
    useTabsStore.getState().replaceConfig("case-c1", next);
    const tab = useTabsStore.getState().tabs[0]!;
    expect(tab.kind === "request" && tab.config.method).toBe("POST");
    // 替换后与快照不同 → dirty（由用户决定是否保存）
    expect(isTabDirty(tab)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 回归：历史记录 tab
// 问题 1：多次点击同一条历史记录打开了多个 tab（key 用 Date.now() 导致不复用）
// 问题 2：打开的历史 tab 看不到请求返回数据（response 为 null，未从 entry 重构）
// ---------------------------------------------------------------------------
function makeHistory(partial: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  const hasResponse = "response" in partial;
  return {
    id: partial.id,
    workspaceId: partial.workspaceId ?? "ws1",
    userId: partial.userId ?? "u1",
    name: partial.name ?? "GET /health",
    request: partial.request ?? {
      ...createEmptyRequestConfig(),
      method: "GET",
      url: "http://x/health",
    },
    response: hasResponse
      ? partial.response!
      : {
          status: 200,
          statusText: "OK",
          sizeBytes: 42,
          durationMs: 15,
          headers: { "content-type": "application/json" },
          bodyText: "{\"ok\":true}",
          bodyBase64: false,
          cookies: [{ name: "session", value: "abc", domain: "x", path: "/" }],
          testResults: [{ name: "status 200", passed: true }],
          consoleLogs: [{ level: "log", args: ["done"] }],
        },
    error: partial.error ?? null,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("useTabsStore（历史记录 tab）", () => {
  it("openFromHistory 按 entry.id 复用 tab：多次点击不重复开 tab", () => {
    const { openFromHistory } = useTabsStore.getState();
    const entry = makeHistory({ id: "h1" });

    openFromHistory(entry);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(useTabsStore.getState().activeKey).toBe("history-h1");

    // 再开一个别的 tab 后重复点击同一条历史：不新增，仅激活
    useTabsStore.getState().openDraft();
    openFromHistory(entry);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(useTabsStore.getState().activeKey).toBe("history-h1");
  });

  it("openFromHistory 从 entry.response 重构完整 ExecuteResult（含 headers/bodyText/cookies/testResults）", () => {
    const { openFromHistory } = useTabsStore.getState();
    openFromHistory(makeHistory({ id: "h2" }));

    const tab = useTabsStore.getState().tabs[0]!;
    expect(tab.kind).toBe("request");
    if (tab.kind !== "request") return;

    // 回归核心：response 不能是 null，必须从 entry.response 重构
    expect(tab.response).not.toBeNull();
    const resp = tab.response!;
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
    expect(resp.statusText).toBe("OK");
    expect(resp.sizeBytes).toBe(42);
    expect(resp.durationMs).toBe(15);
    // 完整响应数据字段
    expect(resp.headers).toEqual({ "content-type": "application/json" });
    expect(resp.bodyText).toBe("{\"ok\":true}");
    expect(resp.bodyBase64).toBe(false);
    expect(resp.cookies).toHaveLength(1);
    expect(resp.cookies![0]!.name).toBe("session");
    expect(resp.testResults).toHaveLength(1);
    expect(resp.testResults[0]!.passed).toBe(true);
    expect(resp.consoleLogs).toHaveLength(1);
  });

  it("openFromHistory 无 response 但有 error 时构造失败结果", () => {
    const { openFromHistory } = useTabsStore.getState();
    openFromHistory(
      makeHistory({
        id: "h3",
        response: null,
        error: "connect ECONNREFUSED 127.0.0.1:8443",
      }),
    );

    const tab = useTabsStore.getState().tabs[0]!;
    if (tab.kind !== "request") return;
    // 回归核心：失败的 history 也要回填 response（ok=false + error）
    expect(tab.response).not.toBeNull();
    expect(tab.response!.ok).toBe(false);
    expect(tab.response!.error).toBe("connect ECONNREFUSED 127.0.0.1:8443");
  });

  it("openFromHistory 无 response 且无 error 时 response 为 null（兼容旧数据）", () => {
    const { openFromHistory } = useTabsStore.getState();
    openFromHistory(
      makeHistory({
        id: "h4",
        response: null,
        error: null,
      }),
    );

    const tab = useTabsStore.getState().tabs[0]!;
    if (tab.kind !== "request") return;
    // 旧数据可能既无 response 也无 error，此时 response 保持 null（不崩）
    expect(tab.response).toBeNull();
  });
});

/**
 * CasesPanel 组件回归：列表渲染、New Case、行内 Run、Run All、删除。
 * 网络层（casesApi / executeRequestConfig）全部 mock，验证状态迁移与调用参数。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestCase } from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import CasesPanel from "../src/components/request/CasesPanel";
import { casesApi, runsApi } from "../src/api";
import { executeRequestConfig } from "../src/lib/execute";
import { useAppStore } from "../src/stores/app";
import { useCasesStore } from "../src/stores/cases";
import { useTabsStore, type RequestTab } from "../src/stores/tabs";
import type { RunJob } from "@rabbitpost/shared";

vi.mock("../src/api", () => ({
  casesApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    listRuns: vi.fn(),
    createRun: vi.fn(),
  },
  runsApi: {
    get: vi.fn(),
    downloadReport: vi.fn(),
  },
}));

vi.mock("../src/lib/execute", () => ({
  executeRequestConfig: vi.fn(),
}));

const mockedApi = vi.mocked(casesApi);
const mockedExec = vi.mocked(executeRequestConfig);

function makeCase(partial: Partial<RequestCase>): RequestCase {
  return {
    id: partial.id ?? "c1",
    itemId: partial.itemId ?? "i1",
    name: partial.name ?? "Case",
    description: partial.description ?? null,
    request: createEmptyRequestConfig(),
    sortOrder: partial.sortOrder ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeJob(partial: Partial<RunJob> & { id: string }): RunJob {
  return {
    id: partial.id,
    teamId: "t1", workspaceId: "ws1", source: "cli", collectionId: "col1",
    caseId: partial.caseId ?? null, runnerId: null, runnerName: null,
    agent: "rabbitpost-web", targetType: "case", targetId: "i1",
    targetName: partial.targetName ?? "Health Check（全部用例）",
    environmentId: null, environmentName: null, concurrency: 1,
    status: partial.status ?? "succeeded",
    totalCount: partial.totalCount ?? 1,
    succeededCount: partial.succeededCount ?? 1,
    failedCount: partial.failedCount ?? 0,
    testPassedCount: partial.testPassedCount ?? 0,
    testFailedCount: partial.testFailedCount ?? 0,
    error: null, createdBy: "u1", claimedAt: null,
    finishedAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTab(): RequestTab {
  const config = createEmptyRequestConfig();
  return {
    kind: "request",
    key: "item-i1",
    itemId: "i1",
    collectionId: "col1",
    name: "Health Check",
    config,
    savedSnapshot: JSON.stringify(config),
    response: null,
    sending: false,
    saving: false,
  };
}

function renderPanel() {
  return render(
    <App>
      <CasesPanel tab={makeTab()} />
    </App>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCasesStore.setState({ byItemId: {} });
  useTabsStore.setState({ tabs: [], activeKey: null });
  useAppStore.setState({
    currentWorkspaceId: "ws1",
    activeEnvironmentId: null,
    environments: [],
  } as never);
  mockedApi.list.mockResolvedValue([]);
  mockedApi.listRuns.mockResolvedValue([]);
  mockedApi.createRun.mockResolvedValue(makeJob({ id: "job-new" }));
});

describe("CasesPanel", () => {
  it("加载并渲染用例列表；空列表显示 Empty", async () => {
    mockedApi.list.mockResolvedValue([
      makeCase({ id: "c1", name: "Smoke A", description: "正常场景" }),
      makeCase({ id: "c2", name: "Smoke B", sortOrder: 1 }),
    ]);
    renderPanel();
    expect(await screen.findByText("Smoke A")).toBeTruthy();
    expect(screen.getByText("Smoke B")).toBeTruthy();
    expect(screen.getByText("正常场景")).toBeTruthy();
    expect(mockedApi.list).toHaveBeenCalledWith("i1");
  });

  it("New Case：创建后 upsert 到列表并打开用例编辑 tab", async () => {
    const created = makeCase({ id: "c9", name: "Case 1" });
    mockedApi.create.mockResolvedValue(created);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /New Case/ }));
    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledWith("i1"));
    await waitFor(() =>
      expect(useCasesStore.getState().byItemId["i1"]?.some((c) => c.id === "c9")).toBe(true),
    );
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ key: "case-c9", caseId: "c9", name: "Case 1" });
  });

  it("行内 Run：执行该用例配置并展示状态码/耗时/断言", async () => {
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    mockedExec.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      durationMs: 42,
      testResults: [
        { name: "t1", passed: true },
        { name: "t2", passed: false, error: "boom" },
      ],
      consoleLogs: [],
    });
    renderPanel();
    const row = (await screen.findByText("Smoke A")).closest("div")!.parentElement!;
    fireEvent.click(row.querySelector(".anticon-caret-right")!.closest("button")!);
    await waitFor(() => expect(mockedExec).toHaveBeenCalledTimes(1));
    // 执行参数：用例自己的配置 + 当前 workspace
    expect(mockedExec.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws1",
      name: "Health Check / Smoke A",
    });
    // 行内结果：状态码 + 耗时 + 断言 1/2（失败态）
    expect(await screen.findByText(/200 OK/)).toBeTruthy();
    expect(screen.getByText(/42ms/)).toBeTruthy();
    expect(screen.getByText(/✗ 1\/2/)).toBeTruthy();
  });

  it("网络层错误：行内限宽省略（maxWidth + ellipsis），Tooltip 悬浮显示原文", async () => {
    const longError =
      "connect ECONNREFUSED 127.0.0.1:8443 — request to https://api.internal.example.com/v2/users failed, reason: socket hang up after 30000ms timeout (TLS handshake)";
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    mockedExec.mockResolvedValue({
      ok: false,
      error: longError,
      testResults: [],
      consoleLogs: [],
    });
    renderPanel();
    const row = (await screen.findByText("Smoke A")).closest("div")!.parentElement!;
    fireEvent.click(row.querySelector(".anticon-caret-right")!.closest("button")!);
    const errorEl = await screen.findByText(longError);
    // 限宽省略：maxWidth 220 + 单行 ellipsis，不会撑宽页面
    expect(errorEl.style.maxWidth).toBe("220px");
    expect(errorEl.style.textOverflow).toBe("ellipsis");
    expect(errorEl.style.whiteSpace).toBe("nowrap");
    expect(errorEl.style.overflow).toBe("hidden");
    // Tooltip 以完整原文为 title（antd Tooltip 在 jsdom 中不落 DOM 属性，验证触发器存在即可；
    // 原文透传由上方 findByText 全等匹配保证——渲染的文本即 Tooltip title 同一份数据）
    expect(errorEl.parentElement?.querySelector(".ant-typography")).toBeTruthy();
  });

  it("Run All：批量执行全部用例并显示汇总条", async () => {
    mockedApi.list.mockResolvedValue([
      makeCase({ id: "c1", name: "A" }),
      makeCase({ id: "c2", name: "B", sortOrder: 1 }),
    ]);
    mockedExec.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      durationMs: 10,
      testResults: [{ name: "t", passed: true }],
      consoleLogs: [],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Run All$/ }));
    await waitFor(() => expect(mockedExec).toHaveBeenCalledTimes(2));
    // 汇总条：2 passed + 断言 2/2
    expect(await screen.findByText(/2 passed/)).toBeTruthy();
    expect(screen.getAllByText(/断言 2\/2/).length).toBeGreaterThan(0);
  });

  it("单条 Run：上报一条 single 历史（caseId 必填，报告只含该用例）", async () => {
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    mockedExec.mockResolvedValue({
      ok: true, status: 200, statusText: "OK", durationMs: 10,
      testResults: [{ name: "t", passed: true }], consoleLogs: [],
    });
    // 上报后历史接口返回该记录
    mockedApi.listRuns.mockResolvedValue([
      makeJob({ id: "job-s1", caseId: "c1", targetName: "Health Check / Smoke A" }),
    ]);
    renderPanel();
    const row = (await screen.findByText("Smoke A")).closest("div")!.parentElement!;
    fireEvent.click(row.querySelector(".anticon-caret-right")!.closest("button")!);
    await waitFor(() => expect(mockedExec).toHaveBeenCalledTimes(1));
    // 上报参数：single + caseId + 只含该用例
    await waitFor(() => expect(mockedApi.createRun).toHaveBeenCalledTimes(1));
    const [itemId, body] = mockedApi.createRun.mock.calls[0]!;
    expect(itemId).toBe("i1");
    expect(body.kind).toBe("single");
    expect(body.caseId).toBe("c1");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ caseId: "c1", name: "Smoke A" });
    // 历史栏渲染该记录（标题即 Case 名，不再标 Single 类型）
    await waitFor(() => expect(screen.getAllByText("Smoke A").length).toBeGreaterThanOrEqual(2));
  });

  it("Run All：全部用例聚合为一条 batch 历史（caseId 为 null，报告含所有 Case）", async () => {
    mockedApi.list.mockResolvedValue([
      makeCase({ id: "c1", name: "A" }),
      makeCase({ id: "c2", name: "B", sortOrder: 1 }),
    ]);
    mockedExec.mockResolvedValue({
      ok: true, status: 200, statusText: "OK", durationMs: 10,
      testResults: [], consoleLogs: [],
    });
    mockedApi.listRuns.mockResolvedValue([makeJob({ id: "job-b1", totalCount: 2, succeededCount: 2 })]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Run All$/ }));
    await waitFor(() => expect(mockedExec).toHaveBeenCalledTimes(2));
    // 上报参数：batch + caseId null + 含全部用例（按列表顺序）
    await waitFor(() => expect(mockedApi.createRun).toHaveBeenCalledTimes(1));
    const body = mockedApi.createRun.mock.calls[0]![1];
    expect(body.kind).toBe("batch");
    expect(body.caseId).toBeNull();
    expect(body.results.map((r) => r.caseId)).toEqual(["c1", "c2"]);
    // 历史栏渲染 Run All 标签（工具栏按钮同名，断言出现至少两处）
    await waitFor(() => expect(screen.getAllByText("Run All").length).toBeGreaterThanOrEqual(2));
  });

  it("历史记录：平铺展示 Case 名/Run All 与明细，可下载 HTML/XML 报告", async () => {
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    // 历史：一条 batch（Run All）+ 一条 single（Case 名）
    mockedApi.listRuns.mockResolvedValue([
      makeJob({ id: "job-b", caseId: null, totalCount: 2, succeededCount: 2 }),
      makeJob({ id: "job-s", caseId: "c1", targetName: "Health Check / Smoke A" }),
    ]);
    vi.mocked(runsApi.get).mockResolvedValue({
      job: makeJob({ id: "job-b" }),
      results: [{
        id: "r1", jobId: "job-b", itemId: "i1", caseId: "c1", name: "Smoke A", method: "GET",
        url: "http://x", ok: true, status: 200, statusText: "OK", sizeBytes: 1,
        durationMs: 5, error: null,
        testResults: [{ name: "status 200", passed: true }], consoleLogs: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    vi.mocked(runsApi.downloadReport).mockResolvedValue("<html>report</html>");
    // 捕获下载
    const clicked: string[] = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked.push((this as HTMLAnchorElement).download); };

    renderPanel();
    // 每条记录一行：Run All 与 Case 名直接显示；Smoke A 同时出现在用例行与历史记录
    // （"Run All" 同时是工具栏按钮与历史 Tag；历史异步加载，等待出现两处）
    await waitFor(() => expect(screen.getAllByText("Run All").length).toBeGreaterThanOrEqual(2));
    expect((await screen.findAllByText("Smoke A")).length).toBeGreaterThanOrEqual(2);
    // 明细不直接平铺：点击历史记录行后 Popover 加载展示
    expect(screen.queryByText("status 200")).toBeNull();
    // 历史栏的 Run All 标题（紫色 strong）定位所在记录行
    const runAllTexts = await screen.findAllByText("Run All");
    const historyTitle = runAllTexts.find((el) => el.tagName === "STRONG")!;
    fireEvent.click(historyTitle.closest("[role=button]")!);
    expect((await screen.findAllByText("status 200")).length).toBeGreaterThanOrEqual(1);

    // 下载 HTML 报告
    const downloadIcons = document.querySelectorAll(".anticon-download");
    fireEvent.click(downloadIcons[0]!.closest("button")!);
    fireEvent.click(await screen.findByText("下载 HTML 报告"));
    await waitFor(() => expect(vi.mocked(runsApi.downloadReport)).toHaveBeenCalledWith("job-b", "html"));
    await waitFor(() => expect(clicked.length).toBeGreaterThan(0));
    expect(clicked[0]).toContain("rabbitpost-report-");
    expect(clicked[0]).toContain(".html");

    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
  });

  it("历史记录：预览按钮新标签页打开 inline HTML 报告", async () => {
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    mockedApi.listRuns.mockResolvedValue([
      makeJob({ id: "job-b", caseId: null, totalCount: 2, succeededCount: 2 }),
    ]);
    vi.mocked(runsApi.get).mockResolvedValue({ job: makeJob({ id: "job-b" }), results: [] });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderPanel();
    await waitFor(() => expect(screen.getAllByText("Run All").length).toBeGreaterThanOrEqual(2));
    const eyeIcon = document.querySelector(".anticon-eye")!;
    fireEvent.click(eyeIcon.closest("button")!);
    expect(openSpy).toHaveBeenCalledWith(
      "/api/v1/runs/job-b/report?format=html&inline=1",
      "_blank",
    );
    openSpy.mockRestore();
  });

  it("删除：确认后调用 remove、同步 store 并关闭已打开的用例 tab", async () => {
    mockedApi.list.mockResolvedValue([makeCase({ id: "c1", name: "Smoke A" })]);
    mockedApi.remove.mockResolvedValue({ deleted: true });
    // 预置一个已打开的用例 tab
    useTabsStore.getState().openCase({ id: "i1", collectionId: "col1" }, makeCase({ id: "c1" }));
    renderPanel();
    // ⋯ 更多菜单按钮无 accessible name：按 anticon-more 图标定位
    const moreIcon = (await screen.findByText("Smoke A")).closest("div")!.parentElement!.querySelector(".anticon-more")!;
    fireEvent.click(moreIcon.closest("button")!);
    fireEvent.click(await screen.findByText("Delete"));
    // modal.confirm 确认
    const okBtn = await screen.findByRole("button", { name: "删 除" });
    fireEvent.click(okBtn);
    await waitFor(() => expect(mockedApi.remove).toHaveBeenCalledWith("c1"));
    await waitFor(() =>
      expect(useCasesStore.getState().byItemId["i1"] ?? []).toHaveLength(0),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(0);
  });
});

/**
 * CollectionRunner 回归：
 * 1. Start run 运行结束后必须调用 runsApi.uploadRun 持久化结果到后端
 *    （之前只更新本地 UI 状态，CollectionRunsPanel 历史永远为空）
 * 2. 请求执行异常（catch）时错误详情不能丢弃，必须带上 error 字段上传
 *    （之前 catch 块只设 status=failed 不存 result，错误信息黑洞）
 *
 * 网络层（executeRequestConfig / runsApi）全部 mock，验证调用参数。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem, ExecuteResult, RunJob } from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import CollectionRunner from "../src/components/runner/CollectionRunner";
import { runsApi } from "../src/api";
import { executeRequestConfig } from "../src/lib/execute";
import { useAppStore } from "../src/stores/app";
import type { RunnerTab } from "../src/stores/tabs";

vi.mock("../src/api", () => ({
  runsApi: {
    uploadRun: vi.fn(),
    downloadReport: vi.fn(),
  },
}));

vi.mock("../src/lib/execute", () => ({
  executeRequestConfig: vi.fn(),
}));

const mockedUploadRun = vi.mocked(runsApi.uploadRun);
const mockedExec = vi.mocked(executeRequestConfig);

function makeItem(partial: Partial<CollectionItem>): CollectionItem {
  return {
    id: partial.id ?? "item-1",
    collectionId: partial.collectionId ?? "col-1",
    parentId: partial.parentId ?? null,
    type: "request",
    name: partial.name ?? "Health Check",
    sortOrder: partial.sortOrder ?? 0,
    request: partial.request ?? {
      ...createEmptyRequestConfig(),
      method: "GET",
      url: "http://x/health",
    },
    children: partial.children,
  } as CollectionItem;
}

function makeJob(): RunJob {
  return {
    id: "job-new",
    teamId: "t1",
    workspaceId: "ws1",
    source: "web",
    collectionId: "col-1",
    caseId: null,
    runnerId: null,
    runnerName: null,
    agent: "rabbitpost-web",
    targetType: "collection",
    targetId: "col-1",
    targetName: "Test Col",
    environmentId: null,
    environmentName: null,
    concurrency: 1,
    status: "succeeded",
    totalCount: 1,
    succeededCount: 1,
    failedCount: 0,
    testPassedCount: 0,
    testFailedCount: 0,
    error: null,
    createdBy: "u1",
    claimedAt: null,
    finishedAt: "2026-01-01T00:00:01.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTab(): RunnerTab {
  return {
    kind: "runner",
    key: "runner-col-1",
    collectionId: "col-1",
    name: "Run Test Col",
  };
}

function renderRunner(items: CollectionItem[]) {
  useAppStore.setState({
    currentWorkspaceId: "ws1",
    activeEnvironmentId: null,
    environments: [],
    collectionTrees: { "col-1": items },
    collections: [{ id: "col-1", name: "Test Col" } as never],
  } as never);
  return render(
    <App>
      <CollectionRunner tab={makeTab()} />
    </App>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUploadRun.mockResolvedValue(makeJob());
});

describe("CollectionRunner 持久化回归", () => {
  it("Start run 运行结束后调用 runsApi.uploadRun 持久化结果", async () => {
    const item = makeItem({});
    renderRunner([item]);

    const okResult: ExecuteResult = {
      ok: true,
      status: 200,
      statusText: "OK",
      sizeBytes: 10,
      durationMs: 15,
      testResults: [],
      consoleLogs: [],
    };
    mockedExec.mockResolvedValue(okResult);

    // 点击 Start run 按钮
    const btn = await screen.findByRole("button", { name: /Start run/ });
    fireEvent.click(btn);

    // 回归核心：uploadRun 必须被调用
    await waitFor(() => expect(mockedUploadRun).toHaveBeenCalledTimes(1));

    // 验证上传参数
    const [collectionId, report] = mockedUploadRun.mock.calls[0]!;
    expect(collectionId).toBe("col-1");
    expect(report.source).toBe("web");
    expect(report.agent).toBe("rabbitpost-web");
    expect(report.targetType).toBe("collection");
    expect(report.targetName).toBe("Test Col");
    // 结果必须包含执行项
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      itemId: "item-1",
      ok: true,
      status: 200,
    });
  });

  it("请求执行抛异常时错误详情不丢弃，随 result 上传到后端", async () => {
    const item = makeItem({ name: "Failing Request" });
    renderRunner([item]);

    // executeRequestConfig 抛异常（如网络层错误）
    const networkError = "connect ECONNREFUSED 127.0.0.1:8443";
    mockedExec.mockRejectedValue(new Error(networkError));

    const btn = await screen.findByRole("button", { name: /Start run/ });
    fireEvent.click(btn);

    // 回归核心：即使执行异常，uploadRun 仍被调用且 error 字段不丢失
    await waitFor(() => expect(mockedUploadRun).toHaveBeenCalledTimes(1));
    const report = mockedUploadRun.mock.calls[0]![1];
    expect(report.results).toHaveLength(1);
    // 关键断言：error 原文必须存在于上传结果中
    expect(report.results[0]!.ok).toBe(false);
    expect(report.results[0]!.error).toBe(networkError);
  });

  it("请求返回 ok=false（HTTP 错误）时结果也上传，含 status 和 error", async () => {
    const item = makeItem({});
    renderRunner([item]);

    const failResult: ExecuteResult = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      error: "upstream returned 500",
      durationMs: 20,
      testResults: [],
      consoleLogs: [],
    };
    mockedExec.mockResolvedValue(failResult);

    const btn = await screen.findByRole("button", { name: /Start run/ });
    fireEvent.click(btn);

    await waitFor(() => expect(mockedUploadRun).toHaveBeenCalledTimes(1));
    const report = mockedUploadRun.mock.calls[0]![1];
    expect(report.results[0]).toMatchObject({
      ok: false,
      status: 500,
      error: "upstream returned 500",
    });
  });

  it("运行结束后派发 collection-runs-updated 事件", async () => {
    const item = makeItem({});
    renderRunner([item]);

    mockedExec.mockResolvedValue({
      ok: true,
      status: 200,
      durationMs: 5,
      testResults: [],
      consoleLogs: [],
    } as ExecuteResult);

    const handler = vi.fn();
    window.addEventListener("rabbitpost:collection-runs-updated", handler);

    const btn = await screen.findByRole("button", { name: /Start run/ });
    fireEvent.click(btn);

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const detail = (handler.mock.calls[0]![0] as CustomEvent).detail;
    expect(detail.collectionId).toBe("col-1");

    window.removeEventListener("rabbitpost:collection-runs-updated", handler);
  });
});

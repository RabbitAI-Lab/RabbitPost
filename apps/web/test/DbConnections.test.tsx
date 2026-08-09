/**
 * 数据库连接 / 数据库操作（workspace 级，侧边栏 Databases）回归：
 * 1. DbConnectionsPanel：列表渲染、新建（创建默认连接并打开编辑 tab）、删除
 * 2. DbOperationsEditor：添加/删除前置操作、提取行，patch 进 RequestConfig.dbOperations
 * 3. executeRequestConfig：local-agent 路径经 resolve 端点解密后随 payload 明文下发 dbConnections
 *
 * 网络层（dbConnectionsApi 等）与 local-agent 探测全部 mock。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyRequestConfig } from "@rabbitpost/shared";
import type { DbConnectionDto } from "../src/api";
import { dbConnectionsApi } from "../src/api";
import DbConnectionsPanel from "../src/components/sidebar/DbConnectionsPanel";
import DbOperationsEditor from "../src/components/request/DbOperationsEditor";
import { executeRequestConfig } from "../src/lib/execute";
import { detectLocalAgent } from "../src/lib/local-agent";
import { useAppStore } from "../src/stores/app";
import { useTabsStore, type RequestTab } from "../src/stores/tabs";

vi.mock("../src/api", () => ({
  dbConnectionsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    resolve: vi.fn(),
  },
  executeApi: { run: vi.fn() },
  historyApi: { report: vi.fn().mockResolvedValue({}) },
}));

vi.mock("../src/lib/local-agent", () => ({
  detectLocalAgent: vi.fn(),
  invalidateLocalAgent: vi.fn(),
}));

const mocked = vi.mocked(dbConnectionsApi);
const mockedDetect = vi.mocked(detectLocalAgent);

function makeConn(partial: Partial<DbConnectionDto> = {}): DbConnectionDto {
  return {
    id: "conn-1",
    workspaceId: "ws1",
    name: "订单库",
    type: "mysql",
    config: { type: "mysql", host: "db.local", port: 3306, database: "orders" },
    hasPassword: true,
    envOverrides: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function makeRequestTab(): RequestTab {
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

function currentTab(): RequestTab {
  const tab = useTabsStore.getState().tabs.find((t) => t.key === "item-i1");
  if (!tab || tab.kind !== "request") throw new Error("request tab missing");
  return tab;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    currentWorkspaceId: "ws1",
    dbConnections: [],
    environments: [],
    activeEnvironmentId: null,
  });
  useTabsStore.setState({ tabs: [], activeKey: null });
  mockedDetect.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DbConnectionsPanel", () => {
  it("渲染连接列表：类型徽标 / 名称 / host:port/database 摘要", () => {
    useAppStore.setState({ dbConnections: [makeConn()] });
    render(
      <App>
        <DbConnectionsPanel />
      </App>,
    );
    expect(screen.getByText("订单库")).toBeTruthy();
    expect(screen.getByText("mysql")).toBeTruthy();
    expect(screen.getByText("db.local:3306/orders")).toBeTruthy();
  });

  it("新建连接：调用 create 并打开编辑 tab", async () => {
    const created = makeConn({ id: "conn-2", name: "New Connection" });
    mocked.create.mockResolvedValue(created);
    mocked.list.mockResolvedValue([created]);
    render(
      <App>
        <DbConnectionsPanel />
      </App>,
    );
    fireEvent.click(screen.getByRole("button", { name: /新建连接/ }));
    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    expect(mocked.create.mock.calls[0]![0]).toBe("ws1");
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.some((t) => t.key === "db-conn-2"),
      ).toBe(true),
    );
  });

  it("删除连接：确认后调用 remove 并关闭对应 tab", async () => {
    const conn = makeConn();
    useAppStore.setState({ dbConnections: [conn] });
    useTabsStore.getState().openDbConnection(conn);
    mocked.remove.mockResolvedValue({ deleted: true });
    mocked.list.mockResolvedValue([]);
    render(
      <App>
        <DbConnectionsPanel />
      </App>,
    );
    const row = screen.getByText("订单库").closest("div")!;
    const buttons = row.parentElement!.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1]!); // 删除图标按钮
    const confirmBtn = await screen.findByRole("button", { name: "删 除" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith("conn-1"));
    await waitFor(() =>
      expect(useTabsStore.getState().tabs.some((t) => t.key === "db-conn-1")).toBe(false),
    );
  });
});

describe("DbOperationsEditor", () => {
  /** 与真实用法一致：从 store 订阅最新 tab（updateConfig 后重新渲染） */
  function EditorHarness() {
    const tab = useTabsStore((s) => s.tabs.find((t) => t.key === "item-i1"));
    if (!tab || tab.kind !== "request") return null;
    return <DbOperationsEditor tab={tab} />;
  }

  function renderEditor(connections: DbConnectionDto[] = [makeConn()]) {
    const tab = makeRequestTab();
    useTabsStore.setState({ tabs: [tab], activeKey: tab.key });
    useAppStore.setState({ dbConnections: connections });
    return render(
      <App>
        <EditorHarness />
      </App>,
    );
  }

  it("添加前置操作：写入 config.dbOperations.pre（默认 kind=sql）", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /添加操作/ }));
    await waitFor(() => {
      const pre = currentTab().config.dbOperations?.pre;
      expect(pre).toHaveLength(1);
      expect(pre![0]!.kind).toBe("sql");
    });
  });

  it("选择连接：kind 按连接类型自动推导（redis）", async () => {
    renderEditor([
      makeConn(),
      makeConn({ id: "conn-r", name: "缓存", type: "redis", config: { type: "redis", host: "r.local" } }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /添加操作/ }));
    // 打开连接下拉并选择「缓存 (redis)」（antd v6：根节点即触发区）
    await waitFor(() => expect(document.querySelector(".ant-select")).toBeTruthy());
    fireEvent.mouseDown(document.querySelector(".ant-select")!);
    const option = await screen.findByText("缓存 (redis)", {
      selector: ".ant-select-item-option-content",
    });
    fireEvent.click(option);
    await waitFor(() => {
      const op = currentTab().config.dbOperations?.pre?.[0];
      expect(op?.connection).toBe("缓存");
      expect(op?.kind).toBe("redis");
    });
  });

  it("添加提取行：extract 追加 { variable, source }", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /添加操作/ }));
    fireEvent.click(screen.getByRole("button", { name: /添加提取/ }));
    await waitFor(() => {
      const op = currentTab().config.dbOperations?.pre?.[0];
      expect(op?.extract).toHaveLength(1);
      expect(op?.extract?.[0]?.source).toBe("rows");
    });
  });

  it("删除操作：pre 列表清空", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /添加操作/ }));
    await waitFor(() =>
      expect(currentTab().config.dbOperations?.pre).toHaveLength(1),
    );
    const card = document.querySelector(".ant-tag")!.closest("div")!;
    const buttons = card.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1]!); // 卡片头部删除按钮
    await waitFor(() =>
      expect(currentTab().config.dbOperations?.pre).toHaveLength(0),
    );
  });
});

describe("executeRequestConfig（local-agent 路径）", () => {
  it("workspace 有连接时：经 resolve 解密后随 payload 下发 dbConnections", async () => {
    mockedDetect.mockResolvedValue("http://127.0.0.1:3939");
    mocked.resolve.mockResolvedValue([
      { name: "订单库", config: { type: "mysql", host: "db.local" }, password: "secret" },
    ]);
    useAppStore.setState({ dbConnections: [makeConn()] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { ok: true, testResults: [], consoleLogs: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = createEmptyRequestConfig();
    config.dbOperations = {
      pre: [{ id: "op1", connection: "订单库", kind: "sql", statement: "SELECT 1" }],
    };
    await executeRequestConfig({
      workspaceId: "ws1",
      environmentId: null,
      environments: [],
      name: "req",
      config,
    });

    expect(mocked.resolve).toHaveBeenCalledWith("ws1", null);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.dbConnections).toHaveLength(1);
    expect(body.dbConnections[0].password).toBe("secret");
  });

  it("resolve 失败（如 viewer 角色）：降级为不带 dbConnections 执行", async () => {
    mockedDetect.mockResolvedValue("http://127.0.0.1:3939");
    mocked.resolve.mockRejectedValue(new Error("FORBIDDEN"));
    useAppStore.setState({ dbConnections: [makeConn()] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { ok: true, testResults: [], consoleLogs: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeRequestConfig({
      workspaceId: "ws1",
      environmentId: null,
      environments: [],
      name: "req",
      config: createEmptyRequestConfig(),
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect("dbConnections" in body).toBe(false);
  });
});

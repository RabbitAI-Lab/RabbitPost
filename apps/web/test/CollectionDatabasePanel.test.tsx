/**
 * 「数据库管理」tab 测试：
 * 1. CollectionEditor 的 tab 顺序：数据库管理 位于 全局变量 与 Runs 之间
 * 2. CollectionDatabasePanel 表单字段按数据库类型切换（redis 显示 Database Index、sqlite 显示文件路径、
 *    oracle 显示服务名、mongodb 显示连接串、mysql 的 SSL 模式联动证书字段）
 * 3. 提交 payload：redis 的 Database Index 映射为 config.database 字符串；oracle 服务名 → config.database；
 *    mongodb connectionString 透传；sqlserver SSL Switch → config.ssl；mysql sslMode/sslCa 透传
 * 4. 编辑已有连接时密码留空则不传 password 字段（保留原密码）
 * 5. 对话框内「测试连接」按钮调 testInline（不落库），编辑且密码留空时不调用
 *
 * 网络层（dbConnectionsApi 等）全部 mock，验证调用参数。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConnectionDto } from "../src/api";
import { dbConnectionsApi } from "../src/api";
import CollectionDatabasePanel from "../src/components/collection/CollectionDatabasePanel";
import CollectionEditor from "../src/components/collection/CollectionEditor";
import { useAppStore } from "../src/stores/app";
import type { CollectionTab } from "../src/stores/tabs";

vi.mock("../src/api", () => ({
  dbConnectionsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    testInline: vi.fn(),
    resolve: vi.fn(),
  },
  collectionsApi: { update: vi.fn() },
  workspacesApi: { update: vi.fn() },
  runsApi: { listByCollection: vi.fn(), downloadReport: vi.fn() },
}));

// Cherry Markdown 编辑器在 jsdom 下不可用，Overview 内容与本测试无关
vi.mock("../src/components/common/MarkdownEditor", () => ({
  default: () => null,
}));

const mockedList = vi.mocked(dbConnectionsApi.list);
const mockedCreate = vi.mocked(dbConnectionsApi.create);
const mockedUpdate = vi.mocked(dbConnectionsApi.update);
const mockedTestInline = vi.mocked(dbConnectionsApi.testInline);

function makeConn(partial: Partial<DbConnectionDto> = {}): DbConnectionDto {
  return {
    id: "conn-1",
    workspaceId: "ws1",
    name: "主库",
    type: "mysql",
    config: { type: "mysql", host: "db.local", port: 3306, database: "app", username: "root" },
    hasPassword: true,
    envOverrides: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function renderPanel() {
  return render(
    <App>
      <CollectionDatabasePanel />
    </App>,
  );
}

/** 打开「新建连接」对话框（空列表时页面有两个新建按钮，取第一个即可） */
async function openCreateModal() {
  const [btn] = await screen.findAllByRole("button", { name: /新建连接/ });
  fireEvent.click(btn!);
  await screen.findByText("数据库类型");
}

/** 切换某个 antd Select（按表单 label 定位）到指定选项 */
async function selectOption(label: string, optionLabel: string) {
  fireEvent.mouseDown(screen.getByLabelText(label));
  const option = await screen.findByText(optionLabel, {
    selector: ".ant-select-item-option-content",
  });
  fireEvent.click(option);
}

/** 切换数据库类型 Select */
async function selectDbType(label: string) {
  await selectOption("数据库类型", label);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([]);
  useAppStore.setState({ currentWorkspaceId: "ws1", dbConnections: [] });
});

describe("CollectionEditor tab 顺序", () => {
  it("数据库管理 tab 位于 全局变量 与 Runs 之间", () => {
    const tab: CollectionTab = {
      kind: "collection",
      key: "col-col-1",
      collectionId: "col-1",
      name: "Test Col",
      description: "",
      variables: [],
      globals: [],
      savedSnapshot: JSON.stringify({ description: "", variables: [], globals: [] }),
      saving: false,
    };
    useAppStore.setState({
      collections: [{ id: "col-1", name: "Test Col", workspaceId: "ws1" } as never],
      collectionTrees: { "col-1": [] },
    });
    render(
      <App>
        <CollectionEditor tab={tab} />
      </App>,
    );
    const labels = Array.from(document.querySelectorAll(".ant-tabs-tab")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      "Overview",
      "Authorization",
      "Scripts",
      "Variables",
      "全局变量",
      "数据库管理",
      "Runs",
    ]);
  });
});

describe("CollectionDatabasePanel 表单字段按类型切换", () => {
  it("默认 MySQL：显示 数据库地址/端口/数据库名/用户名/密码/SSL 模式/只读模式", async () => {
    renderPanel();
    await openCreateModal();
    expect(screen.getByLabelText("连接名称")).toBeTruthy();
    expect(screen.getByLabelText("数据库地址")).toBeTruthy();
    expect(screen.getByLabelText("端口")).toBeTruthy();
    expect(screen.getByLabelText("数据库名")).toBeTruthy();
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByText("SSL 模式")).toBeTruthy();
    expect(screen.getByText("只读模式")).toBeTruthy();
    // SSL 模式默认 Prefer，不显示证书字段
    expect(screen.queryByLabelText("CA 证书")).toBeNull();
    expect(screen.queryByLabelText("Database Index")).toBeNull();
    expect(screen.queryByLabelText("文件路径")).toBeNull();
  });

  it("切换 Redis：显示 Database Index，隐藏 数据库名/用户名/SSL/只读模式", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("Redis");
    // useWatch 触发的字段切换是异步的，用 findBy 等待渲染完成
    expect(await screen.findByLabelText("Database Index")).toBeTruthy();
    expect(screen.getByLabelText("数据库地址")).toBeTruthy();
    expect(screen.queryByLabelText("数据库名")).toBeNull();
    expect(screen.queryByLabelText("用户名")).toBeNull();
    expect(screen.queryByText("SSL 模式")).toBeNull();
    expect(screen.queryByText("只读模式")).toBeNull();
  });

  it("切换 SQLite：显示 文件路径，隐藏 地址/端口/密码/超时", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("SQLite");
    expect(await screen.findByLabelText("文件路径")).toBeTruthy();
    expect(screen.getByText("只读模式")).toBeTruthy();
    expect(screen.queryByLabelText("数据库地址")).toBeNull();
    expect(screen.queryByLabelText("端口")).toBeNull();
    expect(screen.queryByLabelText("密码")).toBeNull();
    expect(screen.queryByLabelText("Database Index")).toBeNull();
  });
});

describe("CollectionDatabasePanel 提交 payload", () => {
  it("新建 Redis 连接：Database Index 映射为 config.database 字符串，端口默认 6379", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("Redis");
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "缓存" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "redis.local" } });
    fireEvent.change(await screen.findByLabelText("Database Index"), { target: { value: "3" } });

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const [workspaceId, input] = mockedCreate.mock.calls[0]!;
    expect(workspaceId).toBe("ws1");
    expect(input.name).toBe("缓存");
    expect(input.type).toBe("redis");
    expect(input.config).toEqual({
      type: "redis",
      host: "redis.local",
      port: 6379,
      database: "3",
      connectTimeoutMs: 5000,
    });
    expect(input).not.toHaveProperty("password");
  });

  it("编辑已有连接：密码框提示已保存，留空提交不传 password 字段", async () => {
    useAppStore.setState({ dbConnections: [makeConn()] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /编 辑|编辑/ }));
    // 已保存密码时 placeholder 提示留空保持不变
    expect(screen.getByPlaceholderText("已保存密码，留空保持不变")).toBeTruthy();
    // 类型不可改
    expect(screen.getByLabelText("数据库类型").closest(".ant-select")!.className).toContain(
      "ant-select-disabled",
    );

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    const [id, patch] = mockedUpdate.mock.calls[0]!;
    expect(id).toBe("conn-1");
    expect(patch.name).toBe("主库");
    expect(patch.config).toEqual({
      type: "mysql",
      host: "db.local",
      port: 3306,
      database: "app",
      username: "root",
      connectTimeoutMs: 5000,
    });
    // 关键断言：留空 = 不传 password（保留原密码）
    expect(patch).not.toHaveProperty("password");
  });

  it("编辑时填入新密码则随 patch 提交", async () => {
    useAppStore.setState({ dbConnections: [makeConn()] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /编 辑|编辑/ }));
    fireEvent.change(screen.getByPlaceholderText("已保存密码，留空保持不变"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]![1].password).toBe("new-secret");
  });
});

describe("CollectionDatabasePanel 新类型字段切换", () => {
  it("切换 Oracle：显示 服务名/用户名（均必填），端口默认 1521", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("Oracle");
    expect(await screen.findByLabelText("服务名")).toBeTruthy();
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByText("只读模式")).toBeTruthy();
    expect(screen.queryByLabelText("Database Index")).toBeNull();
    expect(screen.queryByText("SSL 模式")).toBeNull();
    // 端口联动为 1521
    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("1521");
  });

  it("切换 MongoDB：显示 数据库名（必填）/连接串，隐藏 只读模式", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("MongoDB");
    expect(await screen.findByLabelText("数据库名")).toBeTruthy();
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByLabelText("连接串")).toBeTruthy();
    expect(screen.getByPlaceholderText("mongodb://host:27017/dbname，填写后优先使用")).toBeTruthy();
    expect(screen.queryByText("只读模式")).toBeNull();
    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("27017");
  });

  it("切换 SQL Server：显示 SSL（加密连接）Switch，端口默认 1433", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("SQL Server");
    expect(await screen.findByText("SSL（加密连接）")).toBeTruthy();
    expect(screen.getByLabelText("数据库名")).toBeTruthy();
    expect(screen.queryByText("SSL 模式")).toBeNull();
    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("1433");
  });

  it("切换 ClickHouse：数据库名/用户名带 default 占位，端口默认 8123", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("ClickHouse");
    // 数据库名与用户名均带 default 占位
    expect((await screen.findAllByPlaceholderText("默认 default")).length).toBe(2);
    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("8123");
  });

  it("MySQL SSL 模式选 Verify CA：显示 CA 证书/客户端证书/私钥输入框", async () => {
    renderPanel();
    await openCreateModal();
    expect(screen.queryByLabelText("CA 证书")).toBeNull();
    await selectOption("SSL 模式", "Verify CA");
    expect(await screen.findByLabelText("CA 证书")).toBeTruthy();
    expect(screen.getByLabelText("客户端证书")).toBeTruthy();
    expect(screen.getByLabelText("私钥")).toBeTruthy();
  });

  it("MySQL SSL 模式选 Require：显示 客户端证书/私钥，但不显示 CA 证书", async () => {
    renderPanel();
    await openCreateModal();
    await selectOption("SSL 模式", "Require");
    expect(await screen.findByLabelText("客户端证书")).toBeTruthy();
    expect(screen.getByLabelText("私钥")).toBeTruthy();
    expect(screen.queryByLabelText("CA 证书")).toBeNull();
  });
});

describe("CollectionDatabasePanel 新类型提交 payload", () => {
  it("新建 Oracle：服务名存 config.database，端口默认 1521", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("Oracle");
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "Oracle 库" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "ora.local" } });
    fireEvent.change(await screen.findByLabelText("服务名"), { target: { value: "ORCLPDB1" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "scott" } });

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const [, input] = mockedCreate.mock.calls[0]!;
    expect(input.type).toBe("oracle");
    expect(input.config).toEqual({
      type: "oracle",
      host: "ora.local",
      port: 1521,
      database: "ORCLPDB1",
      username: "scott",
      connectTimeoutMs: 5000,
    });
  });

  it("新建 MongoDB：connectionString 透传，不落 readOnly", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("MongoDB");
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "文档库" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "mongo.local" } });
    fireEvent.change(await screen.findByLabelText("数据库名"), { target: { value: "shop" } });
    fireEvent.change(screen.getByLabelText("连接串"), {
      target: { value: "mongodb://mongo.local:27017/shop" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const [, input] = mockedCreate.mock.calls[0]!;
    expect(input.type).toBe("mongodb");
    expect(input.config).toEqual({
      type: "mongodb",
      host: "mongo.local",
      port: 27017,
      database: "shop",
      connectionString: "mongodb://mongo.local:27017/shop",
      connectTimeoutMs: 5000,
    });
    expect(input.config).not.toHaveProperty("readOnly");
  });

  it("新建 SQL Server：SSL Switch 开启映射为 config.ssl", async () => {
    renderPanel();
    await openCreateModal();
    await selectDbType("SQL Server");
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "MSSQL" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "ms.local" } });
    // SSL（加密连接）Switch（Form.Item name=ssl 的 inner control id 为 ssl）
    await screen.findByText("SSL（加密连接）");
    fireEvent.click(document.getElementById("ssl")!);

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const [, input] = mockedCreate.mock.calls[0]!;
    expect(input.type).toBe("sqlserver");
    expect(input.config).toEqual({
      type: "sqlserver",
      host: "ms.local",
      port: 1433,
      ssl: true,
      connectTimeoutMs: 5000,
    });
  });

  it("新建 MySQL + Verify CA：sslMode/sslCa 透传进 config", async () => {
    renderPanel();
    await openCreateModal();
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "安全库" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "db.local" } });
    await selectOption("SSL 模式", "Verify CA");
    fireEvent.change(await screen.findByLabelText("CA 证书"), { target: { value: "CA-PEM" } });

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const [, input] = mockedCreate.mock.calls[0]!;
    expect(input.config).toEqual({
      type: "mysql",
      host: "db.local",
      port: 3306,
      sslMode: "verify-ca",
      sslCa: "CA-PEM",
      connectTimeoutMs: 5000,
    });
  });

  it("SSL 模式为 Prefer（默认）时 config 不落 sslMode", async () => {
    renderPanel();
    await openCreateModal();
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "普通库" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "db.local" } });

    fireEvent.click(screen.getByRole("button", { name: "保 存" }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]![1].config).not.toHaveProperty("sslMode");
  });
});

describe("CollectionDatabasePanel 对话框内测试连接", () => {
  it("点击「测试连接」调 testInline，payload 为当前表单配置且不落库", async () => {
    mockedTestInline.mockResolvedValue({ success: true, latencyMs: 7 });
    renderPanel();
    await openCreateModal();
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "主库" } });
    fireEvent.change(screen.getByLabelText("数据库地址"), { target: { value: "db.local" } });

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(mockedTestInline).toHaveBeenCalledTimes(1));
    expect(mockedTestInline).toHaveBeenCalledWith({
      workspaceId: "ws1",
      type: "mysql",
      config: { type: "mysql", host: "db.local", port: 3306, connectTimeoutMs: 5000 },
    });
    // 未填密码则不带 password；且不触发 create/update
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("必填项未填时不调 testInline（停留在表单校验）", async () => {
    renderPanel();
    await openCreateModal();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(within(dialog).getByText("请输入连接名称")).toBeTruthy(),
    );
    expect(mockedTestInline).not.toHaveBeenCalled();
  });

  it("编辑已存密码的连接且密码留空：提示先输入密码，不调 testInline", async () => {
    useAppStore.setState({ dbConnections: [makeConn()] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /编 辑|编辑/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(screen.getByText("该连接已保存密码，请先输入密码再测试")).toBeTruthy(),
    );
    expect(mockedTestInline).not.toHaveBeenCalled();
  });

  it("编辑时填入密码后测试：password 随 payload 提交", async () => {
    mockedTestInline.mockResolvedValue({ success: false, error: "拒绝连接" });
    useAppStore.setState({ dbConnections: [makeConn()] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /编 辑|编辑/ }));
    fireEvent.change(screen.getByPlaceholderText("已保存密码，留空保持不变"), {
      target: { value: "secret" },
    });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(mockedTestInline).toHaveBeenCalledTimes(1));
    const payload = mockedTestInline.mock.calls[0]![0];
    expect(payload.password).toBe("secret");
    expect(payload.type).toBe("mysql");
    expect(payload.config.host).toBe("db.local");
  });
});

import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import type { DbConnectionConfig, DbConnectionType, DbSslMode } from "@rabbitpost/shared";
import type { DbConnectionDto } from "../../api";
import { dbConnectionsApi } from "../../api";
import { useAppStore } from "../../stores/app";

const TYPE_LABELS: Record<DbConnectionType, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlserver: "SQL Server",
  oracle: "Oracle",
  clickhouse: "ClickHouse",
  mongodb: "MongoDB",
  redis: "Redis",
  sqlite: "SQLite",
};

const TYPE_COLORS: Record<DbConnectionType, string> = {
  mysql: "blue",
  postgres: "geekblue",
  sqlserver: "purple",
  oracle: "orange",
  clickhouse: "gold",
  mongodb: "lime",
  redis: "red",
  sqlite: "green",
};

/** 各类型默认端口（sqlite 无端口） */
const DEFAULT_PORTS: Partial<Record<DbConnectionType, number>> = {
  mysql: 3306,
  postgres: 5432,
  sqlserver: 1433,
  oracle: 1521,
  clickhouse: 8123,
  mongodb: 27017,
  redis: 6379,
};

/** MySQL/PostgreSQL 的 SSL 模式选项；prefer 为默认行为，不落 config */
const SSL_MODE_OPTIONS: { value: DbSslMode; label: string }[] = [
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "verify-ca", label: "Verify CA" },
  { value: "verify-full", label: "Verify Full" },
];

/** SQL 类连接（host/port/database/username + 只读模式） */
const SQL_TYPES: DbConnectionType[] = ["mysql", "postgres", "sqlserver", "oracle", "clickhouse"];

/** 连接表单值（redis 的 Database Index 用数字输入，提交时转字符串存 config.database） */
interface ConnFormValues {
  name: string;
  type: DbConnectionType;
  host?: string;
  port?: number;
  database?: string;
  dbIndex?: number;
  username?: string;
  password?: string;
  filepath?: string;
  connectionString?: string;
  ssl?: boolean;
  sslMode?: DbSslMode;
  sslCa?: string;
  sslCert?: string;
  sslKey?: string;
  connectTimeoutMs?: number;
  readOnly?: boolean;
}

/** 表单值 → 非密连接配置；空串/未填字段不落进 config */
function buildConfig(values: ConnFormValues): DbConnectionConfig {
  const config: DbConnectionConfig = { type: values.type };
  if (values.type === "sqlite") {
    if (values.filepath) config.filepath = values.filepath;
    if (values.readOnly) config.readOnly = true;
    return config;
  }
  if (values.host) config.host = values.host;
  if (values.port != null) config.port = values.port;
  if (values.type === "redis") {
    // redis 的 Database Index 存 config.database（字符串）
    if (values.dbIndex != null) config.database = String(values.dbIndex);
    if (values.connectTimeoutMs != null) config.connectTimeoutMs = values.connectTimeoutMs;
    return config;
  }
  if (values.database) config.database = values.database;
  if (values.username) config.username = values.username;
  if (values.type === "mongodb") {
    // mongodb 连接串给出时优先于离散字段
    if (values.connectionString) config.connectionString = values.connectionString;
  } else if (values.type === "mysql" || values.type === "postgres") {
    // prefer 即默认行为，不落 config；Require 及以上可附客户端证书/私钥
    if (values.sslMode && values.sslMode !== "prefer") config.sslMode = values.sslMode;
    if (values.sslCa) config.sslCa = values.sslCa;
    if (values.sslCert) config.sslCert = values.sslCert;
    if (values.sslKey) config.sslKey = values.sslKey;
  } else if (values.type === "sqlserver") {
    // sqlserver 用 ssl 布尔（映射驱动的 encrypt）
    if (values.ssl) config.ssl = true;
  }
  if (values.connectTimeoutMs != null) config.connectTimeoutMs = values.connectTimeoutMs;
  if (values.type !== "mongodb" && values.readOnly) config.readOnly = true;
  return config;
}

/** 已有连接 → 表单初始值（密码不回填，留空 = 保持不变） */
function formValuesOf(conn: DbConnectionDto): ConnFormValues {
  const c = conn.config;
  return {
    name: conn.name,
    type: conn.type,
    host: c.host,
    port: c.port ?? DEFAULT_PORTS[conn.type],
    database: conn.type === "redis" ? undefined : c.database,
    dbIndex: conn.type === "redis" && c.database ? Number(c.database) : undefined,
    username: c.username,
    filepath: c.filepath,
    connectionString: c.connectionString,
    ssl: c.ssl ?? false,
    // ssl=true 等价 sslMode="require"
    sslMode: c.sslMode ?? (c.ssl ? "require" : "prefer"),
    sslCa: c.sslCa,
    sslCert: c.sslCert,
    sslKey: c.sslKey,
    connectTimeoutMs: c.connectTimeoutMs ?? 5000,
    readOnly: c.readOnly ?? false,
  };
}

/** 列表「地址」列：优先连接串；sqlite 显示文件路径；其余 host:port */
function addressOf(conn: DbConnectionDto): string {
  const c = conn.config;
  if (c.connectionString) return c.connectionString;
  if (conn.type === "sqlite") return c.filepath ?? "-";
  if (!c.host) return "-";
  return c.port != null ? `${c.host}:${c.port}` : c.host;
}

/** 列表「数据库」列：redis 显示 Database Index；oracle 的 database 即服务名 */
function databaseOf(conn: DbConnectionDto): string {
  const c = conn.config;
  if (conn.type === "sqlite") return "-";
  if (conn.type === "redis") return c.database ?? "0";
  return c.database ?? "-";
}

interface ModalProps {
  /** null = 新建 */
  editing: DbConnectionDto | null;
  onClose: () => void;
}

/** 新建 / 编辑连接共用对话框：字段按数据库类型切换，提交即调 API 保存 */
function ConnectionModal({ editing, onClose }: ModalProps) {
  const { message } = App.useApp();
  const { currentWorkspaceId, refreshDbConnections } = useAppStore();
  const [form] = Form.useForm<ConnFormValues>();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const type = Form.useWatch("type", form) ?? "mysql";
  const sslMode: DbSslMode = Form.useWatch("sslMode", form) ?? "prefer";
  const isSql = SQL_TYPES.includes(type);
  const hasSslMode = type === "mysql" || type === "postgres";

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const config = buildConfig(values);
    // 密码留空 = 不传（新建即无密码，编辑即保留原密码）
    const password = values.password ? { password: values.password } : {};
    setSaving(true);
    try {
      if (editing) {
        await dbConnectionsApi.update(editing.id, { name: values.name, config, ...password });
        message.success("连接已保存");
      } else {
        if (!currentWorkspaceId) return;
        await dbConnectionsApi.create(currentWorkspaceId, {
          name: values.name,
          type: values.type,
          config,
          ...password,
        });
        message.success("连接已创建");
      }
      await refreshDbConnections();
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** 对话框内「测试连接」：不落库，直接以当前表单配置调内联测试接口 */
  const handleTestInline = async () => {
    // 先校验必填项，不通过则停留在表单错误提示
    let values: ConnFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!currentWorkspaceId) return;
    // 编辑已有连接时拿不到已保存密码，留空则提示先输入再测
    if (editing?.hasPassword && !values.password) {
      message.warning("该连接已保存密码，请先输入密码再测试");
      return;
    }
    setTesting(true);
    try {
      const result = await dbConnectionsApi.testInline({
        workspaceId: currentWorkspaceId,
        type: values.type,
        config: buildConfig(values),
        ...(values.password ? { password: values.password } : {}),
      });
      if (result.success) message.success(`连接成功（${result.latencyMs}ms）`);
      else message.error(`连接失败：${result.error}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      open
      title={editing ? "编辑连接" : "新建连接"}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Button loading={testing} onClick={() => void handleTestInline()}>
            测试连接
          </Button>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSubmit()}>
              保存
            </Button>
          </span>
        </div>
      }
    >
      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={
          editing
            ? formValuesOf(editing)
            : {
                type: "mysql",
                port: 3306,
                ssl: false,
                sslMode: "prefer",
                connectTimeoutMs: 5000,
                readOnly: false,
              }
        }
      >
        <Form.Item
          name="name"
          label="连接名称"
          rules={[{ required: true, message: "请输入连接名称" }]}
        >
          <Input placeholder="例如：订单库（测试）" />
        </Form.Item>
        <Form.Item name="type" label="数据库类型" rules={[{ required: true }]}>
          <Select
            // 类型决定存储结构与可用字段，编辑时不可改
            disabled={!!editing}
            options={(Object.keys(TYPE_LABELS) as DbConnectionType[]).map((t) => ({
              value: t,
              label: TYPE_LABELS[t],
            }))}
            onChange={(t: DbConnectionType) => {
              // 切换类型时联动默认端口
              if (!editing) form.setFieldValue("port", DEFAULT_PORTS[t]);
            }}
          />
        </Form.Item>

        {type === "sqlite" ? (
          <Form.Item
            name="filepath"
            label="文件路径"
            rules={[{ required: true, message: "请输入 SQLite 文件路径" }]}
          >
            <Input placeholder="/path/to/database.db" />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              name="host"
              label="数据库地址"
              rules={[{ required: true, message: "请输入数据库地址" }]}
            >
              <Input placeholder="127.0.0.1" />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true, message: "请输入端口" }]}>
              <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </>
        )}

        {isSql || type === "mongodb" ? (
          <Form.Item
            name="database"
            // oracle 的数据库名字段即服务名
            label={type === "oracle" ? "服务名" : "数据库名"}
            rules={
              type === "oracle"
                ? [{ required: true, message: "请输入服务名" }]
                : type === "mongodb"
                  ? [{ required: true, message: "请输入数据库名" }]
                  : undefined
            }
          >
            <Input
              placeholder={
                type === "oracle"
                  ? "例如：ORCLPDB1"
                  : type === "clickhouse"
                    ? "默认 default"
                    : "数据库名称"
              }
            />
          </Form.Item>
        ) : null}

        {isSql || type === "mongodb" ? (
          <Form.Item
            name="username"
            label="用户名"
            rules={type === "oracle" ? [{ required: true, message: "请输入用户名" }] : undefined}
          >
            <Input
              placeholder={type === "clickhouse" ? "默认 default" : "登录用户名"}
              autoComplete="off"
            />
          </Form.Item>
        ) : null}

        {type === "redis" ? (
          <Form.Item name="dbIndex" label="Database Index">
            <InputNumber min={0} max={15} precision={0} style={{ width: "100%" }} placeholder="0" />
          </Form.Item>
        ) : null}

        {type !== "sqlite" ? (
          <Form.Item name="password" label="密码">
            <Input.Password
              autoComplete="new-password"
              placeholder={
                editing?.hasPassword ? "已保存密码，留空保持不变" : "登录密码（可选）"
              }
            />
          </Form.Item>
        ) : null}

        {type === "mongodb" ? (
          <Form.Item name="connectionString" label="连接串" extra="填写后优先使用连接串连接">
            <Input placeholder="mongodb://host:27017/dbname，填写后优先使用" />
          </Form.Item>
        ) : null}

        {hasSslMode ? (
          <>
            <Form.Item name="sslMode" label="SSL 模式">
              <Select options={SSL_MODE_OPTIONS} />
            </Form.Item>
            {sslMode === "verify-ca" || sslMode === "verify-full" ? (
              <Form.Item name="sslCa" label="CA 证书">
                <Input.TextArea rows={3} placeholder="-----BEGIN CERTIFICATE-----" />
              </Form.Item>
            ) : null}
            {sslMode !== "prefer" ? (
              <>
                <Form.Item name="sslCert" label="客户端证书">
                  <Input.TextArea rows={3} placeholder="-----BEGIN CERTIFICATE-----（可选）" />
                </Form.Item>
                <Form.Item name="sslKey" label="私钥">
                  <Input.TextArea rows={3} placeholder="-----BEGIN PRIVATE KEY-----（可选）" />
                </Form.Item>
              </>
            ) : null}
          </>
        ) : null}

        {type === "sqlserver" ? (
          <Form.Item
            name="ssl"
            label="SSL（加密连接）"
            valuePropName="checked"
            extra="映射为驱动的 encrypt 选项"
          >
            <Switch />
          </Form.Item>
        ) : null}

        {type !== "sqlite" ? (
          <Form.Item name="connectTimeoutMs" label="连接超时（毫秒）">
            <InputNumber min={0} step={1000} precision={0} style={{ width: "100%" }} placeholder="5000" />
          </Form.Item>
        ) : null}

        {type !== "redis" && type !== "mongodb" ? (
          <Form.Item
            name="readOnly"
            label="只读模式"
            valuePropName="checked"
            extra={isSql ? "开启后仅允许 SELECT 查询" : undefined}
          >
            <Switch />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

/**
 * Collection 详情页的「数据库管理」tab。
 * 连接作用域为当前 Workspace，可在前后置数据库操作与脚本（rp.db）中引用；
 * 列表数据直接读 app store（workspace 切换时已加载），增删改即时保存并刷新。
 */
export default function CollectionDatabasePanel() {
  const { message } = App.useApp();
  const { dbConnections, refreshDbConnections } = useAppStore();
  // 对话框状态：undefined = 关闭；null = 新建；Dto = 编辑
  const [modalTarget, setModalTarget] = useState<DbConnectionDto | null | undefined>(undefined);
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleTest = async (conn: DbConnectionDto) => {
    setTestingId(conn.id);
    try {
      const result = await dbConnectionsApi.test(conn.id);
      if (result.success) message.success(`连接成功（${result.latencyMs}ms）`);
      else message.error(`连接失败：${result.error}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (conn: DbConnectionDto) => {
    try {
      await dbConnectionsApi.remove(conn.id);
      await refreshDbConnections();
      message.success("已删除");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
          数据库连接作用域为当前 Workspace，可在请求的前后置数据库操作与脚本（rp.db）中引用。
        </Typography.Text>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalTarget(null)}
        >
          新建连接
        </Button>
      </div>

      <Table<DbConnectionDto>
        size="small"
        rowKey="id"
        dataSource={dbConnections}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有数据库连接"
            >
              <Button size="small" type="primary" onClick={() => setModalTarget(null)}>
                新建连接
              </Button>
            </Empty>
          ),
        }}
        columns={[
          { title: "名称", dataIndex: "name", ellipsis: true },
          {
            title: "类型",
            dataIndex: "type",
            width: 110,
            render: (t: DbConnectionType) => (
              <Tag color={TYPE_COLORS[t]} style={{ marginInlineEnd: 0 }}>
                {TYPE_LABELS[t]}
              </Tag>
            ),
          },
          {
            title: "地址",
            key: "address",
            ellipsis: true,
            render: (_, conn) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {addressOf(conn)}
              </Typography.Text>
            ),
          },
          {
            title: "数据库",
            key: "database",
            width: 90,
            render: (_, conn) => databaseOf(conn),
          },
          {
            title: "用户名",
            key: "username",
            width: 90,
            ellipsis: true,
            render: (_, conn) => conn.config.username ?? "-",
          },
          {
            title: "密码",
            key: "password",
            width: 90,
            render: (_, conn) => (conn.hasPassword ? "●●●●●●" : "-"),
          },
          {
            title: "操作",
            key: "actions",
            width: 200,
            render: (_, conn) => (
              <span style={{ display: "inline-flex", gap: 4 }}>
                <Button
                  type="link"
                  size="small"
                  loading={testingId === conn.id}
                  onClick={() => void handleTest(conn)}
                >
                  测试连接
                </Button>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setModalTarget(conn)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="删除连接"
                  description={`确定删除「${conn.name}」吗？引用它的数据库操作将执行失败。`}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleDelete(conn)}
                >
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </span>
            ),
          },
        ]}
      />

      {modalTarget !== undefined ? (
        <ConnectionModal editing={modalTarget} onClose={() => setModalTarget(undefined)} />
      ) : null}
    </div>
  );
}

import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Empty, Modal, Tag, Typography } from "antd";
import type { DbConnectionDto } from "../../api";
import { dbConnectionsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";

const TYPE_COLORS: Record<string, string> = {
  mysql: "blue",
  postgres: "geekblue",
  sqlite: "green",
  redis: "red",
};

/** 列表摘要：host:port/database（sqlite 显示 filepath，redis 显示 db 索引） */
function summaryOf(conn: DbConnectionDto): string {
  const c = conn.config;
  if (conn.type === "sqlite") return c.filepath ?? "";
  const host = c.port ? `${c.host ?? ""}:${c.port}` : (c.host ?? "");
  if (conn.type === "redis") return c.database ? `${host} db${c.database}` : host;
  return c.database ? `${host}/${c.database}` : host;
}

/** 新建默认连接（MySQL）；创建成功后在右侧打开编辑 tab */
export async function createDefaultDbConnection(workspaceId: string) {
  const conn = await dbConnectionsApi.create(workspaceId, {
    name: "New Connection",
    type: "mysql",
    config: { type: "mysql", host: "127.0.0.1", port: 3306 },
  });
  await useAppStore.getState().refreshDbConnections();
  useTabsStore.getState().openDbConnection(conn);
}

export default function DbConnectionsPanel() {
  const { message } = App.useApp();
  const { currentWorkspaceId, dbConnections, refreshDbConnections } = useAppStore();
  const openDbConnection = useTabsStore((s) => s.openDbConnection);
  const closeTab = useTabsStore((s) => s.closeTab);

  const handleCreate = async () => {
    if (!currentWorkspaceId) return;
    await createDefaultDbConnection(currentWorkspaceId);
  };

  const handleDelete = (conn: DbConnectionDto) => {
    Modal.confirm({
      title: "删除连接",
      content: `确定删除数据库连接「${conn.name}」吗？引用它的数据库操作将执行失败。`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await dbConnectionsApi.remove(conn.id);
        closeTab(`db-${conn.id}`);
        await refreshDbConnections();
        message.success("已删除");
      },
    });
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "8px 8px 0",
      }}
    >
      {/* 新建按钮吸顶，不随列表滚动 */}
      <Button
        size="small"
        type="primary"
        ghost
        icon={<PlusOutlined />}
        block
        disabled={!currentWorkspaceId}
        onClick={() => void handleCreate()}
        style={{ marginBottom: 8, flexShrink: 0 }}
      >
        新建连接
      </Button>

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 8 }}
      >
        {dbConnections.length === 0 ? (
          <Empty description="还没有数据库连接" style={{ marginTop: 24 }} />
        ) : (
          <div>
            {dbConnections.map((conn) => (
              <div
                key={conn.id}
                className="sidebar-hover"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  padding: "7px 4px",
                  borderRadius: 4,
                  borderBottom: "1px solid #f5f5f5",
                }}
                onClick={() => openDbConnection(conn)}
              >
                <Tag color={TYPE_COLORS[conn.type]} style={{ marginInlineEnd: 0 }}>
                  {conn.type}
                </Tag>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text
                    ellipsis
                    style={{ fontSize: 12, display: "block", color: "#6b6b6b" }}
                  >
                    {conn.name}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summaryOf(conn)}
                  </Typography.Text>
                </div>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    openDbConnection(conn);
                  }}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(conn);
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import {
  CheckCircleFilled,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { App, Button, Empty, Modal, Typography } from "antd";
import type { Environment } from "@rabbitpost/shared";
import { environmentsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";

export default function EnvironmentsPanel() {
  const { message } = App.useApp();
  const {
    currentWorkspaceId,
    environments,
    activeEnvironmentId,
    refreshEnvironments,
    setActiveEnvironment,
  } = useAppStore();
  const openEnvironment = useTabsStore((s) => s.openEnvironment);
  const closeTab = useTabsStore((s) => s.closeTab);

  // 新建环境：直接创建默认名称 New Environment，并在右侧打开编辑
  const handleCreate = async () => {
    if (!currentWorkspaceId) return;
    const env = await environmentsApi.create(currentWorkspaceId, "New Environment");
    await refreshEnvironments();
    openEnvironment(env);
  };

  const handleDelete = (env: Environment) => {
    Modal.confirm({
      title: "删除环境",
      content: `确定删除环境「${env.name}」吗？`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await environmentsApi.remove(env.id);
        if (activeEnvironmentId === env.id) setActiveEnvironment(null);
        closeTab(`env-${env.id}`);
        await refreshEnvironments();
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
        新建环境
      </Button>

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 8 }}
      >
      {environments.length === 0 ? (
        <Empty description="还没有环境" style={{ marginTop: 24 }} />
      ) : (
        <div>
          {environments.map((env) => (
            <div
              key={env.id}
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
              onClick={() =>
                setActiveEnvironment(activeEnvironmentId === env.id ? null : env.id)
              }
            >
              {activeEnvironmentId === env.id ? (
                <CheckCircleFilled style={{ color: "#52c41a" }} />
              ) : (
                <span style={{ width: 14, display: "inline-block" }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text ellipsis style={{ fontSize: 12, display: "block" }}>
                  {env.name}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {env.variables.length} 个变量
                </Typography.Text>
              </div>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  openEnvironment(env);
                }}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(env);
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

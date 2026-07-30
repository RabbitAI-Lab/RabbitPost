import {
  CheckOutlined,
  DownOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { workspacesApi } from "../api";
import { useAppStore } from "../stores/app";

/** 列表单项 32px，最大高度取 10 项 + 上下 4px 内边距，保证至少直接显示 10 个 Workspace */
const LIST_MAX_HEIGHT = 32 * 10 + 8;

/**
 * Header 中间的 Workspace 切换器：
 * 下拉框内含搜索框、固定高度（内部滚动）的 Workspace 列表、新建 Workspace 按钮。
 */
export default function WorkspaceSwitcher() {
  const { message } = App.useApp();
  const {
    currentTeamId,
    workspaces,
    currentWorkspaceId,
    selectWorkspace,
    refreshWorkspaces,
  } = useAppStore();

  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ name: string; description?: string }>();

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(kw));
  }, [workspaces, keyword]);

  const handleSelect = async (workspaceId: string) => {
    setOpen(false);
    await selectWorkspace(workspaceId);
  };

  const handleCreate = async () => {
    if (!currentTeamId) return;
    const values = await form.validateFields();
    const ws = await workspacesApi.create(
      currentTeamId,
      values.name,
      values.description,
    );
    await refreshWorkspaces();
    await selectWorkspace(ws.id);
    setCreateOpen(false);
    form.resetFields();
    message.success(`Workspace「${ws.name}」已创建`);
  };

  return (
    <>
      <Dropdown
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setKeyword("");
        }}
        trigger={["click"]}
        placement="bottom"
        popupRender={() => (
          <div className="popup-panel" style={{ width: 260 }}>
            {/* 搜索框 */}
            <div style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>
              <Input
                size="small"
                allowClear
                autoFocus
                prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
                placeholder="搜索 Workspace"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>

            {/* Workspace 列表：固定最大高度（10 项），超出内部滚动 */}
            <div
              className="slim-scroll"
              style={{
                maxHeight: LIST_MAX_HEIGHT,
                overflowY: "auto",
                padding: "4px 0",
              }}
            >
              {filtered.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="无匹配的 Workspace"
                  style={{ padding: "12px 0" }}
                />
              ) : (
                filtered.map((w) => {
                  const selected = w.id === currentWorkspaceId;
                  return (
                    <div
                      key={w.id}
                      className="sidebar-hover"
                      onClick={() => void handleSelect(w.id)}
                      style={{
                        height: 32,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "0 10px",
                        cursor: "pointer",
                      }}
                    >
                      {selected ? (
                        <CheckOutlined
                          style={{ fontSize: 12, color: "#ff6c37" }}
                        />
                      ) : (
                        <span style={{ width: 12, flexShrink: 0 }} />
                      )}
                      <Typography.Text
                        strong={selected}
                        ellipsis
                        style={{ fontSize: 13, flex: 1, minWidth: 0 }}
                      >
                        {w.name}
                      </Typography.Text>
                    </div>
                  );
                })
              )}
            </div>

            {/* 新建 Workspace */}
            <div style={{ borderTop: "1px solid #f0f0f0", padding: 4 }}>
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                style={{ width: "100%", textAlign: "left" }}
                disabled={!currentTeamId}
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
              >
                新建 Workspace
              </Button>
            </div>
          </div>
        )}
      >
        <div
          className="sidebar-hover"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 6,
            cursor: "pointer",
            maxWidth: 280,
          }}
        >
          <TeamOutlined style={{ color: "#ff6c37", fontSize: 13 }} />
          <Typography.Text
            strong
            ellipsis
            style={{ fontSize: 13, maxWidth: 220 }}
          >
            {currentWorkspace?.name ?? "选择 Workspace"}
          </Typography.Text>
          <DownOutlined style={{ fontSize: 9, color: "#999" }} />
        </div>
      </Dropdown>

      <Modal
        title="新建 Workspace"
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input maxLength={64} placeholder="例如：交易网关 API" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} maxLength={512} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

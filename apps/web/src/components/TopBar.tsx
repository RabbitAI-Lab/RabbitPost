import {
  CheckOutlined,
  DownOutlined,
  LogoutOutlined,
  PlusOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  App,
  Avatar,
  Dropdown,
  Form,
  Input,
  Modal,
  Space,
} from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";
import { teamsApi } from "../api";
import { useAppStore } from "../stores/app";
import TeamManagerModal from "./TeamManagerModal";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

export default function TopBar() {
  const { message } = App.useApp();
  const {
    user,
    teams,
    currentTeamId,
    selectTeam,
    refreshTeams,
    signOut,
  } = useAppStore();

  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [teamForm] = Form.useForm<{ name: string }>();

  const currentTeam = teams.find((t) => t.id === currentTeamId);

  const menuItems: MenuProps["items"] = [
    {
      key: "email",
      label: user?.email ?? user?.name,
      disabled: true,
    },
    { type: "divider" },
    {
      key: "team",
      icon: <TeamOutlined />,
      label: currentTeam ? `团队：${currentTeam.name}` : "选择团队",
      children: [
        ...teams.map((t) => ({
          key: `team-${t.id}`,
          icon: t.id === currentTeamId ? <CheckOutlined /> : undefined,
          label: t.name,
          onClick: () => void selectTeam(t.id),
        })),
        { type: "divider" as const },
        {
          key: "team-create",
          icon: <PlusOutlined />,
          label: "新建团队",
          onClick: () => setCreateTeamOpen(true),
        },
        {
          key: "team-manage",
          icon: <SettingOutlined />,
          label: "团队管理",
          disabled: !currentTeamId,
          onClick: () => setTeamModalOpen(true),
        },
      ],
    },
    { type: "divider" },
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "退出登录",
      onClick: () => void signOut(),
    },
  ];

  const handleCreateTeam = async () => {
    const { name } = await teamForm.validateFields();
    const team = await teamsApi.create(name);
    await refreshTeams();
    await selectTeam(team.id);
    setCreateTeamOpen(false);
    teamForm.resetFields();
    message.success(`团队「${team.name}」已创建`);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px",
        height: "100%",
      }}
    >
      <span style={{ color: "#ff6c37", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}>
        🥕 RabbitPost
      </span>

      {/* 中间：Workspace 切换 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <WorkspaceSwitcher />
      </div>

      {/* 用户菜单 */}
      <Dropdown menu={{ items: menuItems }}>
        <Space style={{ cursor: "pointer" }}>
          <Avatar size="small" src={user?.avatarUrl}>
            {user?.name?.slice(0, 1)}
          </Avatar>
          <span style={{ fontSize: 13 }}>{user?.name}</span>
          <DownOutlined style={{ fontSize: 10 }} />
        </Space>
      </Dropdown>

      <TeamManagerModal
        open={teamModalOpen}
        team={currentTeam ?? null}
        onClose={() => setTeamModalOpen(false)}
      />

      <Modal
        title="新建团队"
        open={createTeamOpen}
        onOk={() => void handleCreateTeam()}
        onCancel={() => setCreateTeamOpen(false)}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={teamForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="团队名称" rules={[{ required: true, message: "请输入团队名称" }]}>
            <Input maxLength={64} placeholder="例如：支付团队" />
          </Form.Item>
        </Form>
      </Modal>

    </div>
  );
}

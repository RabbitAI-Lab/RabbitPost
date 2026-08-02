import {
  BankOutlined,
  CheckOutlined,
  CodeOutlined,
  DownOutlined,
  LogoutOutlined,
  PlusOutlined,
  ReadOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  App,
  Avatar,
  Dropdown,
  Form,
  Input,
  Modal,
  Space,
  Tooltip,
} from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { teamsApi } from "../api";
import { useAppStore } from "../stores/app";
import { useTabsStore } from "../stores/tabs";
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
  const openCli = useTabsStore((s) => s.openCli);
  const openProfile = useTabsStore((s) => s.openProfile);
  const navigate = useNavigate();

  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [teamForm] = Form.useForm<{ name: string }>();

  const currentTeam = teams.find((t) => t.id === currentTeamId);
  // CLI 菜单仅团队管理员可见（Runner Token 属于团队级凭证）
  const isTeamAdmin = currentTeam?.role === "owner" || currentTeam?.role === "admin";

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
      key: "enterprise-console",
      icon: <BankOutlined />,
      label: "企业控制台",
      onClick: () => navigate("/console"),
    },
    { type: "divider" },
    {
      key: "profile",
      icon: <UserOutlined />,
      label: "个人中心",
      onClick: () => openProfile(),
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

      {/* CLI 入口：团队管理员可见，点击直接进入 RabbitPost CLI */}
      {isTeamAdmin && (
        <Tooltip title="CLI">
          <CodeOutlined
            style={{ cursor: "pointer", fontSize: 15 }}
            onClick={() => openCli("rabbitpost-cli")}
          />
        </Tooltip>
      )}

      {/* 企业控制台入口 */}
      <Tooltip title="企业控制台">
        <BankOutlined
          style={{ cursor: "pointer", fontSize: 15 }}
          onClick={() => navigate("/console")}
        />
      </Tooltip>

      {/* 文档入口：新标签页打开独立 docs 站 */}
      <ReadOutlined
        style={{ cursor: "pointer", fontSize: 14 }}
        onClick={() => window.open(import.meta.env.VITE_DOCS_URL ?? "http://localhost:5180", "_blank")}
      />

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

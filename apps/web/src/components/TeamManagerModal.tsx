import { DeleteOutlined, UserAddOutlined } from "@ant-design/icons";
import {
  App,
  Avatar,
  Button,
  Input,
  Modal,
  Select,
  Table,
  Tag,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import type { Team, TeamMember, TeamRole } from "@rabbitpost/shared";
import { teamsApi } from "../api";
import { useAppStore } from "../stores/app";

interface Props {
  open: boolean;
  team: Team | null;
  onClose: () => void;
}

const ROLE_COLORS: Record<TeamRole, string> = {
  owner: "gold",
  admin: "volcano",
  editor: "blue",
  viewer: "default",
};

export default function TeamManagerModal({ open, team, onClose }: Props) {
  const { message } = App.useApp();
  const currentUser = useAppStore((s) => s.user);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, "owner">>("editor");
  const [inviting, setInviting] = useState(false);

  const canManage = team?.role === "owner" || team?.role === "admin";

  const load = useCallback(async () => {
    if (!team) return;
    setLoading(true);
    try {
      setMembers(await teamsApi.members(team.id));
    } finally {
      setLoading(false);
    }
  }, [team]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleInvite = async () => {
    if (!team || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      await teamsApi.addMember(team.id, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      await load();
      message.success("成员已添加");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (userId: string, role: Exclude<TeamRole, "owner">) => {
    if (!team) return;
    await teamsApi.updateMemberRole(team.id, userId, role);
    await load();
    message.success("角色已更新");
  };

  const handleRemove = async (userId: string) => {
    if (!team) return;
    await teamsApi.removeMember(team.id, userId);
    await load();
    message.success("成员已移除");
  };

  return (
    <Modal
      title={team ? `团队管理 · ${team.name}` : "团队管理"}
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
    >
      {canManage && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Input
            placeholder="成员邮箱（需已登录过一次）"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onPressEnter={() => void handleInvite()}
          />
          <Select
            value={inviteRole}
            style={{ width: 120 }}
            options={[
              { value: "editor", label: "Editor" },
              { value: "viewer", label: "Viewer" },
              { value: "admin", label: "Admin" },
            ]}
            onChange={setInviteRole}
          />
          <Button
            type="primary"
            icon={<UserAddOutlined />}
            loading={inviting}
            onClick={() => void handleInvite()}
          >
            邀请
          </Button>
        </div>
      )}

      <Table<TeamMember>
        size="small"
        rowKey="userId"
        loading={loading}
        dataSource={members}
        pagination={false}
        columns={[
          {
            title: "成员",
            dataIndex: "user",
            render: (user: TeamMember["user"]) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Avatar size="small" src={user?.avatarUrl}>
                  {user?.name?.slice(0, 1)}
                </Avatar>
                <span>
                  {user?.name}
                  {userIdIsMe(user?.id, currentUser?.id) && "（我）"}
                  <br />
                  <span style={{ color: "#999", fontSize: 12 }}>{user?.email}</span>
                </span>
              </span>
            ),
          },
          {
            title: "角色",
            dataIndex: "role",
            width: 140,
            render: (role: TeamRole, row) =>
              canManage && role !== "owner" ? (
                <Select
                  size="small"
                  value={role}
                  style={{ width: 110 }}
                  options={[
                    { value: "admin", label: "Admin" },
                    { value: "editor", label: "Editor" },
                    { value: "viewer", label: "Viewer" },
                  ]}
                  onChange={(r) => void handleRoleChange(row.userId, r)}
                />
              ) : (
                <Tag color={ROLE_COLORS[role]}>{role}</Tag>
              ),
          },
          {
            title: "",
            width: 48,
            render: (_: unknown, row) =>
              canManage && row.role !== "owner" ? (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => void handleRemove(row.userId)}
                />
              ) : null,
          },
        ]}
      />
    </Modal>
  );
}

function userIdIsMe(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a === b);
}

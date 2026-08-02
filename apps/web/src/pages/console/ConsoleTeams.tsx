import { DeleteOutlined, PlusOutlined, RightOutlined, TeamOutlined } from "@ant-design/icons";
import { App, Avatar, Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { TeamMember, TeamRole } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";
import { useAppStore } from "../../stores/app";

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  orgId: string | null;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  workspaceCount: number;
  collectionCount: number;
}

interface TeamDetail {
  id: string;
  name: string;
  memberCount: number;
  admins: {
    userId: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
    role: TeamRole;
  }[];
  members: TeamMember[];
}

const TEAM_ROLE_OPTIONS: { value: Exclude<TeamRole, "owner">; label: string; color: string }[] = [
  { value: "editor", label: "Editor", color: "blue" },
  { value: "viewer", label: "Viewer", color: "default" },
  { value: "admin", label: "Admin", color: "orange" },
];

const ROLE_COLOR: Record<string, string> = {
  owner: "red",
  admin: "orange",
  editor: "blue",
  viewer: "default",
};

export default function ConsoleTeams() {
  const { message } = App.useApp();
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const currentUser = useAppStore((s) => s.user);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();

  // 团队详情抽屉
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [addMemberRole, setAddMemberRole] = useState<Exclude<TeamRole, "owner">>("editor");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setTeams(await orgsApi.teams(orgId));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const { name } = await form.validateFields();
    await orgsApi.createTeam(orgId!, { name });
    await load();
    setCreateOpen(false);
    form.resetFields();
    message.success(`团队「${name}」已创建`);
  };

  const openDetail = async (teamId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const d = await orgsApi.teamDetail(orgId!, teamId);
      setDetail(d);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleAddMember = async () => {
    if (!detail || !addMemberEmail.trim()) return;
    setAdding(true);
    try {
      await orgsApi.addTeamMember(orgId!, detail.id, addMemberEmail.trim(), addMemberRole);
      setAddMemberEmail("");
      await openDetail(detail.id);
      message.success("成员已添加到团队");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleTeamRoleChange = async (userId: string, role: Exclude<TeamRole, "owner">) => {
    if (!detail) return;
    await orgsApi.updateTeamMemberRole(orgId!, detail.id, userId, role);
    await openDetail(detail.id);
    message.success("角色已更新");
  };

  const handleRemoveMember = async (userId: string) => {
    if (!detail) return;
    await orgsApi.removeTeamMember(orgId!, detail.id, userId);
    await openDetail(detail.id);
    message.success("成员已移除");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          团队管理
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建团队
        </Button>
      </div>

      <Table<TeamRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={teams}
        pagination={false}
        onRow={(r) => ({ onClick: () => void openDetail(r.id), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "团队",
            dataIndex: "name",
            key: "name",
            render: (name: string, row) => (
              <Space>
                <TeamOutlined style={{ color: "#1890ff" }} />
                <span style={{ fontWeight: 500 }}>{name}</span>
                <RightOutlined style={{ fontSize: 10, color: "#ccc" }} />
              </Space>
            ),
          },
          { title: "Slug", dataIndex: "slug", key: "slug", render: (s: string) => <Tag>{s}</Tag> },
          { title: "成员", dataIndex: "memberCount", key: "memberCount", align: "right" as const },
          { title: "工作区", dataIndex: "workspaceCount", key: "workspaceCount", align: "right" as const },
          { title: "Collection", dataIndex: "collectionCount", key: "collectionCount", align: "right" as const },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            key: "createdAt",
            render: (t: string) => new Date(t).toLocaleDateString(),
          },
        ]}
      />

      {/* 团队详情抽屉 */}
      <Drawer
        title={detail ? `团队 · ${detail.name}` : "团队详情"}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={640}
        loading={detailLoading}
      >
        {detail && (
          <>
            {/* Team Admin 区 */}
            <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
              Team Admin（{detail.admins.length}）
            </Typography.Text>
            <Space wrap style={{ marginBottom: 24 }}>
              {detail.admins.map((a) => (
                <Space key={a.userId} style={{ background: "#fafafa", padding: "4px 12px", borderRadius: 6 }}>
                  <Avatar size="small" src={a.avatarUrl}>{a.name[0]}</Avatar>
                  <span style={{ fontSize: 13 }}>
                    {a.name}
                    {a.userId === currentUser?.id && <Tag style={{ marginLeft: 4, fontSize: 11 }}>You</Tag>}
                  </span>
                  <Tag color={ROLE_COLOR[a.role]} style={{ fontSize: 11 }}>{a.role}</Tag>
                </Space>
              ))}
            </Space>

            {/* 添加成员 */}
            <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
              添加成员到团队
            </Typography.Text>
            <Space style={{ marginBottom: 16, width: "100%" }}>
              <Input
                placeholder="成员邮箱（需已是企业成员）"
                value={addMemberEmail}
                onChange={(e) => setAddMemberEmail(e.target.value)}
                onPressEnter={() => void handleAddMember()}
                style={{ flex: 1 }}
              />
              <Select
                value={addMemberRole}
                style={{ width: 110 }}
                options={TEAM_ROLE_OPTIONS}
                onChange={setAddMemberRole}
              />
              <Button type="primary" icon={<PlusOutlined />} loading={adding} onClick={() => void handleAddMember()}>
                添加
              </Button>
            </Space>

            {/* 成员列表 */}
            <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
              全部成员（{detail.members.length}）
            </Typography.Text>
            <Table<TeamMember>
              size="small"
              rowKey="userId"
              pagination={false}
              dataSource={detail.members}
              columns={[
                {
                  title: "成员",
                  key: "user",
                  render: (_, r) => (
                    <Space>
                      <Avatar size="small" src={r.user?.avatarUrl}>{r.user?.name?.[0]}</Avatar>
                      <div>
                        <div style={{ fontWeight: 500 }}>{r.user?.name}</div>
                        <div style={{ fontSize: 12, color: "#888" }}>{r.user?.email}</div>
                      </div>
                    </Space>
                  ),
                },
                {
                  title: "团队角色",
                  key: "role",
                  width: 130,
                  render: (_, r) => {
                    if (r.role === "owner") return <Tag color="red">Owner</Tag>;
                    return (
                      <Select
                        size="small"
                        value={r.role}
                        style={{ width: 100 }}
                        options={TEAM_ROLE_OPTIONS}
                        onChange={(v) => void handleTeamRoleChange(r.userId, v)}
                      />
                    );
                  },
                },
                {
                  title: "",
                  key: "action",
                  width: 50,
                  render: (_, r) =>
                    r.role !== "owner" ? (
                      <Popconfirm title="移除该成员？" onConfirm={() => void handleRemoveMember(r.userId)}>
                        <Tooltip title="移除">
                          <Button danger size="small" icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />
          </>
        )}
      </Drawer>

      <Modal
        title="创建团队"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="团队名称" rules={[{ required: true, message: "请输入团队名称" }]}>
            <Input placeholder="如：API Platform Team" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

import { DeleteOutlined, UserAddOutlined } from "@ant-design/icons";
import { App, Avatar, Button, Input, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { OrgMember, OrgRole } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";
import { useAppStore } from "../../stores/app";

const ROLE_OPTIONS: { value: Exclude<OrgRole, "owner">; label: string; color: string }[] = [
  { value: "member", label: "Member", color: "default" },
  { value: "billing", label: "Billing", color: "blue" },
  { value: "admin", label: "Admin", color: "orange" },
];

export default function ConsoleMembers() {
  const { message } = App.useApp();
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const currentUser = useAppStore((s) => s.user);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(false);

  // 添加企业成员（先添加到企业，再可选择加入哪个团队）
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<Exclude<OrgRole, "owner">>("member");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setMembers(await orgsApi.members(orgId));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAddMember = async () => {
    if (!addEmail.trim()) return;
    setAdding(true);
    try {
      await orgsApi.inviteMember(orgId!, addEmail.trim(), addRole);
      setAddEmail("");
      await load();
      message.success("成员已添加到企业");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleRoleChange = async (userId: string, role: Exclude<OrgRole, "owner">) => {
    await orgsApi.updateMemberRole(orgId!, userId, role);
    await load();
    message.success("角色已更新");
  };

  const handleRemove = async (userId: string) => {
    await orgsApi.removeMember(orgId!, userId);
    await load();
    message.success("成员已移除");
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        成员管理
      </Typography.Title>

      <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
        在此添加企业成员。添加到团队请前往「团队管理」→ 点击团队 → 添加成员。
      </Typography.Text>

      {/* 添加成员到企业 */}
      <Space style={{ marginBottom: 16, width: "100%" }}>
        <Input
          placeholder="成员邮箱（需已登录过一次）"
          value={addEmail}
          onChange={(e) => setAddEmail(e.target.value)}
          onPressEnter={() => void handleAddMember()}
          style={{ width: 320 }}
        />
        <Select
          value={addRole}
          style={{ width: 120 }}
          options={ROLE_OPTIONS}
          onChange={setAddRole}
        />
        <Button
          type="primary"
          icon={<UserAddOutlined />}
          loading={adding}
          onClick={() => void handleAddMember()}
        >
          添加成员
        </Button>
      </Space>

      <Table<OrgMember>
        size="small"
        rowKey="userId"
        loading={loading}
        dataSource={members}
        pagination={false}
        columns={[
          {
            title: "成员",
            key: "user",
            render: (_, r) => (
              <Space>
                <Avatar size="small" src={r.user.avatarUrl}>
                  {r.user.name[0]}
                </Avatar>
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {r.user.name}
                    {r.userId === currentUser?.id && (
                      <Tag style={{ marginLeft: 8, fontSize: 11 }}>You</Tag>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#888" }}>{r.user.email}</div>
                </div>
              </Space>
            ),
          },
          {
            title: "企业角色",
            key: "role",
            width: 160,
            render: (_, r) => {
              if (r.role === "owner") {
                return <Tag color="red">Owner</Tag>;
              }
              return (
                <Select
                  size="small"
                  value={r.role}
                  style={{ width: 120 }}
                  options={ROLE_OPTIONS}
                  onChange={(v) => void handleRoleChange(r.userId, v)}
                />
              );
            },
          },
          {
            title: "所属团队",
            key: "teamIds",
            render: (_, r) =>
              r.teamIds && r.teamIds.length > 0 ? (
                <Tag color="blue">{r.teamIds.length} 个团队</Tag>
              ) : (
                <span style={{ color: "#ccc" }}>未加入团队</span>
              ),
          },
          {
            title: "加入时间",
            dataIndex: "joinedAt",
            key: "joinedAt",
            render: (t: string) => new Date(t).toLocaleDateString(),
          },
          {
            title: "操作",
            key: "action",
            width: 80,
            render: (_, r) => {
              if (r.role === "owner") return null;
              return (
                <Popconfirm
                  title="确定移除该成员？"
                  description="移除后该用户将失去企业下所有团队的访问权限"
                  onConfirm={() => void handleRemove(r.userId)}
                >
                  <Tooltip title="移除">
                    <Button danger size="small" icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              );
            },
          },
        ]}
      />
    </div>
  );
}

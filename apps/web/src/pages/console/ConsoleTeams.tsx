import { PlusOutlined } from "@ant-design/icons";
import { App, Button, Form, Input, Modal, Table, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

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

export default function ConsoleTeams() {
  const { message } = App.useApp();
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();

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
        columns={[
          {
            title: "团队",
            dataIndex: "name",
            key: "name",
            render: (name: string, row) => (
              <span style={{ fontWeight: 500 }}>
                {row.avatarUrl ? (
                  <img src={row.avatarUrl} alt="" style={{ width: 20, height: 20, borderRadius: 4, marginRight: 8 }} />
                ) : null}
                {name}
              </span>
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

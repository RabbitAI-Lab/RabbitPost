import { Table, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  userId: string;
  userName: string;
  userEmail: string | null;
}

export default function ConsoleApiKeys() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setRows(await orgsApi.apiKeys(orgId));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        API Keys 管理
      </Typography.Title>
      <Table<KeyRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: "名称", dataIndex: "name", key: "name" },
          {
            title: "Key 前缀",
            dataIndex: "keyPrefix",
            key: "keyPrefix",
            render: (p: string) => <Tag color="orange">{p}••••</Tag>,
          },
          { title: "所属用户", dataIndex: "userName", key: "userName",
            render: (name: string, r) => (
              <span>
                {name} {r.userEmail && <span style={{ color: "#888", fontSize: 12 }}>({r.userEmail})</span>}
              </span>
            ),
          },
          {
            title: "最后使用",
            dataIndex: "lastUsedAt",
            key: "lastUsedAt",
            render: (t: string | null) => (t ? new Date(t).toLocaleString() : <span style={{ color: "#ccc" }}>从未</span>),
          },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            key: "createdAt",
            render: (t: string) => new Date(t).toLocaleDateString(),
          },
        ]}
      />
    </div>
  );
}

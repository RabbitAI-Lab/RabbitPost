import { Table, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

interface WsRow {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  collectionCount: number;
  requestCount: number;
}

export default function ConsoleWorkspaces() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [rows, setRows] = useState<WsRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setRows(await orgsApi.workspaces(orgId));
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
        工作区总览
      </Typography.Title>
      <Table<WsRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          {
            title: "工作区",
            dataIndex: "name",
            key: "name",
            render: (name: string, r) => (
              <div>
                <span style={{ fontWeight: 500 }}>{name}</span>
                {r.description && (
                  <div style={{ fontSize: 12, color: "#888" }}>{r.description}</div>
                )}
              </div>
            ),
          },
          {
            title: "所属团队",
            dataIndex: "teamName",
            key: "teamName",
            render: (t: string) => <Tag color="blue">{t}</Tag>,
          },
          {
            title: "Collection",
            dataIndex: "collectionCount",
            key: "collectionCount",
            align: "right" as const,
          },
          {
            title: "接口数",
            dataIndex: "requestCount",
            key: "requestCount",
            align: "right" as const,
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

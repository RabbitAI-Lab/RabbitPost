import { Table, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

interface RunnerRow {
  id: string;
  name: string;
  description: string | null;
  tokenPrefix: string;
  status: string;
  lastSeenAt: string | null;
  version: string | null;
  platform: string | null;
  teamId: string;
  teamName: string;
  createdAt: string;
}

export default function ConsoleRunners() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [rows, setRows] = useState<RunnerRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setRows(await orgsApi.runners(orgId));
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
        Runners 管理
      </Typography.Title>
      <Table<RunnerRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: "名称", dataIndex: "name", key: "name",
            render: (name: string, r) => (
              <div>
                <span style={{ fontWeight: 500 }}>{name}</span>
                {r.description && <div style={{ fontSize: 12, color: "#888" }}>{r.description}</div>}
              </div>
            ),
          },
          { title: "所属团队", dataIndex: "teamName", key: "teamName",
            render: (t: string) => <Tag color="blue">{t}</Tag>,
          },
          {
            title: "状态",
            dataIndex: "status",
            key: "status",
            render: (s: string, r) => {
              const isOnline = s === "active" && r.lastSeenAt &&
                Date.now() - new Date(r.lastSeenAt).getTime() < 5 * 60 * 1000;
              return (
                <Tag color={isOnline ? "green" : "default"}>
                  {isOnline ? "在线" : "离线"}
                </Tag>
              );
            },
          },
          {
            title: "Token 前缀",
            dataIndex: "tokenPrefix",
            key: "tokenPrefix",
            render: (p: string) => <Tag color="orange">{p}••••</Tag>,
          },
          {
            title: "版本 / 平台",
            key: "vp",
            render: (_, r) => (
              <Tooltip title={r.platform ?? ""}>
                <span style={{ fontSize: 12 }}>
                  {r.version ?? "-"} / {r.platform ?? "-"}
                </span>
              </Tooltip>
            ),
          },
          {
            title: "最后心跳",
            dataIndex: "lastSeenAt",
            key: "lastSeenAt",
            render: (t: string | null) => (t ? new Date(t).toLocaleString() : <span style={{ color: "#ccc" }}>从未</span>),
          },
        ]}
      />
    </div>
  );
}

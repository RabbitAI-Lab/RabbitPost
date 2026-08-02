import { Select, Table, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { AuditLog } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

const ACTION_OPTIONS = [
  { value: "org.create", label: "创建企业" },
  { value: "org.update", label: "更新企业" },
  { value: "org.settings_update", label: "更新设置" },
  { value: "team.create", label: "创建团队" },
  { value: "member.invite", label: "邀请成员" },
  { value: "member.role_change", label: "角色变更" },
  { value: "member.remove", label: "移除成员" },
];

export default function ConsoleAuditLog() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setLogs(await orgsApi.auditLogs(orgId, { action: actionFilter, limit: 200 }));
    } finally {
      setLoading(false);
    }
  }, [orgId, actionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          审计日志
        </Typography.Title>
        <Select
          allowClear
          placeholder="按动作筛选"
          style={{ width: 200 }}
          value={actionFilter}
          options={ACTION_OPTIONS}
          onChange={(v) => setActionFilter(v)}
        />
      </div>

      <Table<AuditLog>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={logs}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          {
            title: "时间",
            dataIndex: "createdAt",
            key: "createdAt",
            width: 180,
            render: (t: string) => new Date(t).toLocaleString(),
          },
          {
            title: "操作者",
            dataIndex: "actorName",
            key: "actorName",
            render: (name: string | null) => name ?? <span style={{ color: "#ccc" }}>System</span>,
          },
          {
            title: "动作",
            dataIndex: "action",
            key: "action",
            render: (a: string) => <Tag>{a}</Tag>,
          },
          {
            title: "目标",
            key: "target",
            render: (_, r) => (
              <span>
                {r.targetType && <Tag style={{ fontSize: 11 }}>{r.targetType}</Tag>}
                {r.targetName ?? (r.targetId ? r.targetId.slice(0, 8) : "-")}
              </span>
            ),
          },
          {
            title: "详情",
            dataIndex: "detail",
            key: "detail",
            width: 300,
            render: (detail: Record<string, unknown> | null) =>
              detail ? (
                <Tooltip title={<pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(detail, null, 2)}</pre>}>
                  <code style={{ fontSize: 12, color: "#888" }}>
                    {JSON.stringify(detail).slice(0, 80)}
                    {JSON.stringify(detail).length > 80 ? "..." : ""}
                  </code>
                </Tooltip>
              ) : (
                <span style={{ color: "#ccc" }}>-</span>
              ),
          },
          {
            title: "IP",
            dataIndex: "ip",
            key: "ip",
            render: (ip: string | null) => ip ?? <span style={{ color: "#ccc" }}>-</span>,
          },
        ]}
      />
    </div>
  );
}

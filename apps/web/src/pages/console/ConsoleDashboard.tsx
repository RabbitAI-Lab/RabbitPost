import {
  TeamOutlined,
  UserOutlined,
  AppstoreOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import { Card, Col, Empty, Row, Spin, Statistic, Table, Tag, Timeline, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { DashboardSummary } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

const ACTION_LABELS: Record<string, string> = {
  "org.create": "创建企业",
  "org.update": "更新企业",
  "org.settings_update": "更新设置",
  "team.create": "创建团队",
  "member.invite": "邀请成员",
  "member.role_change": "角色变更",
  "member.remove": "移除成员",
};

export default function ConsoleDashboard() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setData(await orgsApi.dashboard(orgId));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: 300 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!data) return <Empty />;

  const cards = [
    { title: "团队数", value: data.teamCount, icon: <TeamOutlined />, color: "#1890ff" },
    { title: "成员数", value: data.memberCount, icon: <UserOutlined />, color: "#52c41a" },
    { title: "工作区", value: data.workspaceCount, icon: <AppstoreOutlined />, color: "#722ed1" },
    { title: "Collection 数", value: data.collectionCount, icon: <ApiOutlined />, color: "#fa8c16" },
    { title: "近30天请求", value: data.requestSent30d, icon: <ApiOutlined />, color: "#eb2f96" },
    { title: "近30天执行", value: data.runExecuted30d, icon: <ThunderboltOutlined />, color: "#13c2c2" },
    {
      title: "执行通过",
      value: data.runPassed30d,
      icon: <CheckCircleOutlined />,
      color: "#52c41a",
    },
    {
      title: "执行失败",
      value: data.runFailed30d,
      icon: <CloseCircleOutlined />,
      color: "#ff4d4f",
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        企业总览
      </Typography.Title>

      <Row gutter={[16, 16]}>
        {cards.map((c) => (
          <Col key={c.title} xs={12} sm={8} md={6}>
            <Card size="small">
              <Statistic
                title={
                  <span style={{ fontSize: 13, color: "#888" }}>
                    {c.icon} {c.title}
                  </span>
                }
                value={c.value}
                valueStyle={{ color: c.color, fontSize: 24 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} md={12}>
          <Card title="团队活跃度排行（近30天请求量）" size="small">
            {data.teamActivity.length === 0 ? (
              <Empty description="暂无数据" />
            ) : (
              <Table
                size="small"
                rowKey="teamId"
                pagination={false}
                dataSource={data.teamActivity}
                columns={[
                  { title: "团队", dataIndex: "teamName", key: "teamName" },
                  {
                    title: "请求数",
                    dataIndex: "requestCount",
                    key: "requestCount",
                    render: (v: number) => <Tag color="blue">{v.toLocaleString()}</Tag>,
                    align: "right" as const,
                  },
                ]}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="最近活动" size="small">
            {data.recentActivity.length === 0 ? (
              <Empty description="暂无活动" />
            ) : (
              <Timeline
                items={data.recentActivity.slice(0, 10).map((log) => ({
                  color: log.action.includes("delete") || log.action.includes("remove")
                    ? "red"
                    : log.action.includes("create") || log.action.includes("invite")
                      ? "green"
                      : "blue",
                  children: (
                    <div>
                      <span style={{ fontWeight: 500 }}>
                        {log.actorName ?? "System"}
                      </span>{" "}
                      <Tag style={{ fontSize: 11 }}>
                        {ACTION_LABELS[log.action] ?? log.action}
                      </Tag>
                      {log.targetName && (
                        <span style={{ color: "#888" }}>{log.targetName}</span>
                      )}
                      <div style={{ fontSize: 12, color: "#aaa" }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

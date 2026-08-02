import { Button, Card, Col, Empty, Progress, Row, Spin, Statistic, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

interface BillingInfo {
  plan: string;
  status: string;
  seatLimit: number;
  seatUsed: number;
  requestQuota: number;
  requestUsedEstimate: number;
}

const PLAN_LABELS: Record<string, { label: string; color: string }> = {
  free: { label: "Free", color: "default" },
  team: { label: "Team", color: "blue" },
  business: { label: "Business", color: "purple" },
  enterprise: { label: "Enterprise", color: "gold" },
};

export default function ConsoleBilling() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [data, setData] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setData(await orgsApi.billing(orgId));
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

  const planMeta = PLAN_LABELS[data.plan] ?? { label: data.plan, color: "default" };
  const seatPct = data.seatLimit > 0 ? (data.seatUsed / data.seatLimit) * 100 : 0;
  const reqPct = data.requestQuota > 0 ? (data.requestUsedEstimate / data.requestQuota) * 100 : 0;

  return (
    <div style={{ maxWidth: 800 }}>
      <Typography.Title level={4} style={{ marginBottom: 24 }}>
        计费与套餐
      </Typography.Title>

      <Card style={{ marginBottom: 16 }}>
        <Row align="middle" gutter={24}>
          <Col>
            <Statistic
              title="当前套餐"
              valueRender={() => (
                <Tag color={planMeta.color} style={{ fontSize: 18, padding: "4px 16px" }}>
                  {planMeta.label}
                </Tag>
              )}
            />
          </Col>
          <Col>
            <Statistic title="状态" valueRender={() => (
              <Tag color={data.status === "active" ? "green" : "red"}>{data.status}</Tag>
            )} />
          </Col>
          <Col flex="auto" style={{ textAlign: "right" }}>
            <Button type="primary">升级套餐</Button>
          </Col>
        </Row>
      </Card>

      <Card title="席位使用" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <Progress
              percent={Math.min(seatPct, 100)}
              status={seatPct > 90 ? "exception" : seatPct > 75 ? "active" : "normal"}
              format={() => `${data.seatUsed} / ${data.seatLimit || "∞"}`}
            />
          </Col>
        </Row>
      </Card>

      <Card title="请求配额" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <Progress
              percent={Math.min(reqPct, 100)}
              status={reqPct > 90 ? "exception" : "normal"}
              format={() => `${data.requestUsedEstimate.toLocaleString()} / ${data.requestQuota > 0 ? data.requestQuota.toLocaleString() : "∞"}`}
            />
          </Col>
        </Row>
      </Card>

      <Card title="发票历史" size="small">
        <Empty description="暂无发票记录" />
      </Card>
    </div>
  );
}

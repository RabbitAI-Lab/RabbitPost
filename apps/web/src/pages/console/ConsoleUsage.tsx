import { Card, Col, DatePicker, Empty, Row, Select, Spin, Statistic, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import type { UsageMetric, UsageSummary } from "@rabbitpost/shared";
import { orgsApi } from "../../api/orgs";
import { useConsoleStore } from "../../stores/console";

const { RangePicker } = DatePicker;

const METRIC_OPTIONS = [
  { value: "request_sent", label: "API 请求量" },
  { value: "run_executed", label: "自动化执行次数" },
];

const GROUP_OPTIONS = [
  { value: "total", label: "总量" },
  { value: "team", label: "按团队" },
  { value: "workspace", label: "按工作区" },
  { value: "member", label: "按成员" },
];

export default function ConsoleUsage() {
  const orgId = useConsoleStore((s) => s.currentOrgId);
  const [metric, setMetric] = useState<UsageMetric>("request_sent");
  const [groupBy, setGroupBy] = useState<"team" | "member" | "workspace" | "total">("total");
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(30, "day"),
    dayjs(),
  ]);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      setData(
        await orgsApi.usage(orgId, {
          metric,
          from: range[0].toISOString(),
          to: range[1].toISOString(),
          groupBy,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [orgId, metric, groupBy, range]);

  useEffect(() => {
    void load();
  }, [load]);

  // 按分组聚合数据用于表格展示
  const groupMap = new Map<string, number>();
  if (data) {
    for (const p of data.points) {
      const key = p.group ?? "总量";
      groupMap.set(key, (groupMap.get(key) ?? 0) + p.count);
    }
  }
  const groupRows = [...groupMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        用量统计
      </Typography.Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col>
          <Select
            value={metric}
            style={{ width: 180 }}
            options={METRIC_OPTIONS}
            onChange={(v) => setMetric(v)}
          />
        </Col>
        <Col>
          <Select
            value={groupBy}
            style={{ width: 140 }}
            options={GROUP_OPTIONS}
            onChange={(v) => setGroupBy(v)}
          />
        </Col>
        <Col>
          <RangePicker
            value={range}
            onChange={(v) => v && setRange(v as [dayjs.Dayjs, dayjs.Dayjs])}
          />
        </Col>
      </Row>

      <Spin spinning={loading}>
        {data ? (
          <>
            <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title="总量"
                    value={data.total}
                    valueStyle={{ color: "#ff6c37" }}
                  />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic title="时间范围" value={`${range[0].format("MM/DD")} - ${range[1].format("MM/DD")}`} />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <Statistic
                    title="日均"
                    value={Math.round(data.total / Math.max(range[1].diff(range[0], "day"), 1))}
                  />
                </Card>
              </Col>
            </Row>

            {groupBy !== "total" ? (
              <Card title="分组用量对比" size="small">
                {groupRows.length === 0 ? (
                  <Empty description="暂无数据" />
                ) : (
                  <Table
                    size="small"
                    rowKey="name"
                    pagination={false}
                    dataSource={groupRows}
                    columns={[
                      { title: "名称", dataIndex: "name", key: "name" },
                      {
                        title: "用量",
                        dataIndex: "count",
                        key: "count",
                        render: (v: number) => <Tag color="blue">{v.toLocaleString()}</Tag>,
                        align: "right" as const,
                      },
                      {
                        title: "占比",
                        key: "percent",
                        render: (_, r) => {
                          const pct = data.total > 0 ? ((r.count / data.total) * 100).toFixed(1) : "0";
                          return <span>{pct}%</span>;
                        },
                        align: "right" as const,
                      },
                    ]}
                  />
                )}
              </Card>
            ) : (
              <Card title="每日趋势" size="small">
                {data.points.length === 0 ? (
                  <Empty description="暂无数据" />
                ) : (
                  <Table
                    size="small"
                    rowKey="label"
                    pagination={{ pageSize: 15, showSizeChanger: false }}
                    dataSource={[...data.points].reverse()}
                    columns={[
                      { title: "日期", dataIndex: "label", key: "label" },
                      {
                        title: "用量",
                        dataIndex: "count",
                        key: "count",
                        render: (v: number) => <Tag color="blue">{v.toLocaleString()}</Tag>,
                        align: "right" as const,
                      },
                    ]}
                  />
                )}
              </Card>
            )}
          </>
        ) : (
          <Empty />
        )}
      </Spin>
    </div>
  );
}

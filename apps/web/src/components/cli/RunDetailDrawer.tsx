import {
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
} from "@ant-design/icons";
import { Drawer, Table, Tag, Typography } from "antd";
import type { RunJobDetail, RunJobResult, RunJobStatus, RunSource } from "@rabbitpost/shared";

const { Text } = Typography;

export const STATUS_COLORS: Record<RunJobStatus, string> = {
  queued: "default",
  running: "processing",
  succeeded: "green",
  failed: "red",
  canceled: "default",
};

export const STATUS_LABELS: Record<RunJobStatus, string> = {
  queued: "等待领取",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};

export const SOURCE_LABELS: Record<RunSource, string> = {
  dispatch: "派发",
  cli: "CLI",
  web: "Web",
};

/** 单条结果的断言 / console 明细（表格展开行） */
function ResultDetails({ result }: { result: RunJobResult }) {
  const tests = result.testResults ?? [];
  const logs = result.consoleLogs ?? [];
  if (tests.length === 0 && logs.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>无断言与脚本输出</Text>;
  }
  return (
    <div style={{ padding: "4px 0" }}>
      {tests.length > 0 && (
        <div style={{ marginBottom: logs.length > 0 ? 8 : 0 }}>
          {tests.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 6, fontSize: 12, lineHeight: "20px" }}>
              {t.passed ? (
                <CheckCircleFilled style={{ color: "#52c41a", marginTop: 4 }} />
              ) : (
                <CloseCircleFilled style={{ color: "#ff4d4f", marginTop: 4 }} />
              )}
              <span>
                {t.name}
                {t.error && (
                  <Text type="danger" style={{ fontSize: 12, marginLeft: 8 }}>
                    {t.error}
                  </Text>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {logs.length > 0 && (
        <pre
          style={{
            margin: 0,
            padding: "6px 10px",
            background: "#111827",
            color: "#d1d5db",
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {logs.map((l) => `[${l.level}] ${l.args.join(" ")}`).join("\n")}
        </pre>
      )}
    </div>
  );
}

interface Props {
  detail: RunJobDetail | null;
  onClose: () => void;
}

/** 执行结果抽屉：任务概要 + 逐请求结果（断言 / console 可展开）。
 *  CLI 中心的 RunHistoryTable 与 Collection 的 Runs tab 共用。 */
export default function RunDetailDrawer({ detail, onClose }: Props) {
  const job = detail?.job;
  const hasAssertions =
    (job?.testPassedCount ?? 0) + (job?.testFailedCount ?? 0) > 0 ||
    (detail?.results ?? []).some((r) => (r.testResults?.length ?? 0) > 0);

  return (
    <Drawer
      title={job ? `执行结果 · ${job.targetName}` : "执行结果"}
      open={!!detail}
      size={860}
      onClose={onClose}
      destroyOnHidden
    >
      {job && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "#666" }}>
          <Tag color={job.source === "cli" ? "purple" : job.source === "web" ? "green" : "blue"} style={{ marginRight: 8 }}>
            {SOURCE_LABELS[job.source]}
          </Tag>
          <Tag color={STATUS_COLORS[job.status]}>{STATUS_LABELS[job.status]}</Tag>
          <span style={{ marginRight: 12 }}>
            执行方：{job.runnerName ?? job.agent ?? "任意 Runner"}
          </span>
          <span style={{ marginRight: 12 }}>环境：{job.environmentName ?? "-"}</span>
          <span style={{ marginRight: 12 }}>
            请求 <Text type="success">{job.succeededCount}</Text>
            {" / "}
            <Text type="danger">{job.failedCount}</Text>
            {` / ${job.totalCount}`}
          </span>
          {hasAssertions && (
            <span>
              断言 <Text type="success">{job.testPassedCount}</Text>
              {" / "}
              <Text type="danger">{job.testFailedCount}</Text>
            </span>
          )}
        </div>
      )}
      {job?.error && (
        <Text type="danger" style={{ display: "block", marginBottom: 12 }}>
          {job.error}
        </Text>
      )}
      <Table<RunJobResult>
        size="small"
        rowKey="id"
        dataSource={detail?.results ?? []}
        pagination={false}
        locale={{ emptyText: "暂无逐请求结果" }}
        expandable={{
          rowExpandable: (r) =>
            (r.testResults?.length ?? 0) > 0 || (r.consoleLogs?.length ?? 0) > 0,
          expandedRowRender: (r) => <ResultDetails result={r} />,
        }}
        columns={[
          {
            title: "请求",
            dataIndex: "name",
            // 用例行：紫色 CASE 徽章（name 本身已含「接口 / 用例」路径）
            render: (name: string, row) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {row.caseId && (
                  <Tag color="purple" style={{ marginRight: 0 }}>
                    CASE
                  </Tag>
                )}
                {name}
              </span>
            ),
          },
          { title: "方法", dataIndex: "method", width: 70 },
          {
            title: "状态码",
            dataIndex: "status",
            width: 90,
            // 无状态码表示没拿到响应（网络层失败）；4xx/5xx 仍展示原始码
            render: (status: number | null, row) =>
              status === null ? (
                <Tag color="red">无响应</Tag>
              ) : (
                <Tag color={row.ok ? "green" : "red"}>{status}</Tag>
              ),
          },
          {
            title: "断言",
            width: 80,
            render: (_: unknown, row) => {
              const tests = row.testResults ?? [];
              if (tests.length === 0) {
                return <MinusCircleFilled style={{ color: "#d9d9d9" }} />;
              }
              const failed = tests.filter((t) => !t.passed).length;
              return failed === 0 ? (
                <Text type="success" style={{ fontSize: 12 }}>
                  {tests.length} 通过
                </Text>
              ) : (
                <Text type="danger" style={{ fontSize: 12 }}>
                  {failed} 失败
                </Text>
              );
            },
          },
          {
            title: "耗时",
            dataIndex: "durationMs",
            width: 90,
            render: (durationMs: number | null) =>
              durationMs === null ? "-" : `${durationMs} ms`,
          },
          {
            title: "大小",
            dataIndex: "sizeBytes",
            width: 90,
            render: (sizeBytes: number | null) =>
              sizeBytes === null ? "-" : `${sizeBytes} B`,
          },
          {
            title: "错误",
            dataIndex: "error",
            render: (error: string | null) =>
              error ? (
                <Text type="danger" style={{ fontSize: 12 }}>
                  {error}
                </Text>
              ) : (
                "-"
              ),
          },
        ]}
      />
    </Drawer>
  );
}

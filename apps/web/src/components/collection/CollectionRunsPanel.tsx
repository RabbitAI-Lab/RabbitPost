import { DownloadOutlined, EyeOutlined } from "@ant-design/icons";
import { App, Button, Dropdown, Popover, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import type { RunJob, RunJobStatus, RunSource } from "@rabbitpost/shared";
import { runsApi } from "../../api";
import { downloadRunReport, previewRunReport } from "../../lib/download";
import { useAppStore } from "../../stores/app";
import {
  SOURCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../cli/RunDetailDrawer";

const { Text } = Typography;

const SOURCE_COLORS: Record<RunSource, string> = {
  dispatch: "blue",
  cli: "purple",
  web: "green",
};

interface Props {
  collectionId: string;
}

/** Collection 的 Runs tab：该 Collection 的执行记录（派发 + CLI 上传）与逐请求结果 */
export default function CollectionRunsPanel({ collectionId }: Props) {
  const { message } = App.useApp();
  const collections = useAppStore((s) => s.collections);
  const [jobs, setJobs] = useState<RunJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await runsApi.listByCollection(collectionId, 50));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }, [collectionId, message]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // Web Runner 运行结束后派发事件，及时刷新历史
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.collectionId || detail.collectionId === collectionId) {
        void load();
      }
    };
    window.addEventListener("rabbitpost:collection-runs-updated", handler);
    return () =>
      window.removeEventListener("rabbitpost:collection-runs-updated", handler);
  }, [collectionId, load]);

  // 有 queued / running 任务时轮询，完成后自动停止
  const pending = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const handleDownload = async (job: RunJob, format: "junit" | "html") => {
    setDownloadingId(job.id);
    try {
      await downloadRunReport(job.id, job.targetName, format, runsApi.downloadReport);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div style={{ padding: "8px 4px", overflow: "auto", height: "100%" }}>
      <Table<RunJob>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={jobs}
        pagination={false}
        locale={{ emptyText: "暂无执行记录：点击 Collection 菜单中的 Run 执行，从 CLI 中心派发任务，或用 rabbitpost run --upload 上传" }}
        columns={[
          {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (status: RunJobStatus) => (
              <Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>
            ),
          },
          {
            title: "来源",
            dataIndex: "source",
            width: 80,
            render: (source: RunSource) => (
              <Tag color={SOURCE_COLORS[source]}>{SOURCE_LABELS[source]}</Tag>
            ),
          },
          {
            title: "Collection",
            dataIndex: "collectionId",
            width: 160,
            render: (collectionId: string | null) => (
              <span style={{ fontSize: 12 }}>
                {collectionId
                  ? (collections.find((c) => c.id === collectionId)?.name ?? "-")
                  : "-"}
              </span>
            ),
          },
          {
            title: "目标",
            dataIndex: "targetName",
            render: (targetName: string, row) => (
              <span style={{ fontSize: 12 }}>
                {targetName}
                <span style={{ color: "#999" }}>
                  {row.targetType === "collection"
                    ? "（整个 Collection）"
                    : row.targetType === "case"
                      ? "（用例）"
                      : "（单个请求）"}
                </span>
              </span>
            ),
          },
          {
            title: "环境",
            dataIndex: "environmentName",
            width: 120,
            // 有快照时可点击查看执行时的环境变量（secret 已脱敏）
            render: (environmentName: string | null, row) => {
              if (!environmentName) return <span style={{ fontSize: 12 }}>-</span>;
              const snapshot = row.environmentSnapshot;
              if (!snapshot || snapshot.length === 0) {
                return <span style={{ fontSize: 12 }}>{environmentName}</span>;
              }
              return (
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  title={`环境快照 · ${environmentName}`}
                  content={
                    <div style={{ maxWidth: 420, maxHeight: 320, overflow: "auto" }} className="slim-scroll">
                      {snapshot.map((v) => (
                        <div
                          key={v.id ?? v.key}
                          className="code-font"
                          style={{ display: "flex", gap: 8, fontSize: 11, lineHeight: "20px" }}
                        >
                          <span style={{ color: v.enabled ? "inherit" : "rgba(0,0,0,0.35)", fontWeight: 600 }}>
                            {v.key}
                          </span>
                          <span style={{ color: "rgba(0,0,0,0.45)" }}>=</span>
                          <span style={{ wordBreak: "break-all", color: v.enabled ? "inherit" : "rgba(0,0,0,0.35)" }}>
                            {v.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  }
                >
                  <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }}>
                    {environmentName}
                  </Button>
                </Popover>
              );
            },
          },
          {
            title: "执行方",
            width: 150,
            render: (_: unknown, row) => (
              <span style={{ fontSize: 12 }}>
                {row.runnerName ?? row.agent ?? "任意 Runner"}
              </span>
            ),
          },
          {
            title: "结果",
            width: 180,
            render: (_: unknown, row) => (
              <span style={{ fontSize: 12 }}>
                <Text type="success">{row.succeededCount}</Text>
                {" / "}
                <Text type="danger">{row.failedCount}</Text>
                {` / ${row.totalCount}`}
                {row.testPassedCount + row.testFailedCount > 0 && (
                  <span style={{ color: "#999" }}>
                    {` · 断言 `}
                    <Text type="success">{row.testPassedCount}</Text>
                    {" / "}
                    <Text type="danger">{row.testFailedCount}</Text>
                  </span>
                )}
              </span>
            ),
          },
          {
            title: "时间",
            dataIndex: "createdAt",
            width: 150,
            render: (createdAt: string) => (
              <span style={{ fontSize: 12, color: "#666" }}>
                {dayjs(createdAt).format("MM-DD HH:mm:ss")}
              </span>
            ),
          },
          {
            title: "操作",
            width: 90,
            render: (_: unknown, row) => (
              <span style={{ display: "inline-flex", gap: 0 }}>
                {/* 在线预览报告（新标签页 inline HTML） */}
                <Button
                  type="text"
                  size="small"
                  title="查看报告"
                  icon={<EyeOutlined />}
                  onClick={() => previewRunReport(row.id)}
                />
                {/* 下载报告（HTML / JUnit XML） */}
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "html", label: "下载 HTML 报告" },
                      { key: "junit", label: "下载 JUnit XML" },
                    ],
                    onClick: ({ key }) => void handleDownload(row, key as "junit" | "html"),
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    title="下载报告"
                    icon={<DownloadOutlined />}
                    loading={downloadingId === row.id}
                  />
                </Dropdown>
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

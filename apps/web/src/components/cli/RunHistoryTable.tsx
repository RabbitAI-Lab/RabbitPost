import { App, Button, Popconfirm, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import type { RunJob, RunJobDetail, RunJobStatus } from "@rabbitpost/shared";
import { runsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import RunDetailDrawer, { STATUS_COLORS, STATUS_LABELS } from "./RunDetailDrawer";

const { Text } = Typography;

interface Props {
  /** 外部派发任务后自增以触发刷新 */
  refreshKey: number;
}

/** 执行任务列表：有未完成任务时自动轮询进度，可查看逐请求结果 */
export default function RunHistoryTable({ refreshKey }: Props) {
  const { message } = App.useApp();
  const currentTeamId = useAppStore((s) => s.currentTeamId);
  const [jobs, setJobs] = useState<RunJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<RunJobDetail | null>(null);

  const load = useCallback(async () => {
    if (!currentTeamId) return;
    try {
      setJobs(await runsApi.list(currentTeamId, 30));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }, [currentTeamId, message]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load, refreshKey]);

  // 有 queued / running 任务时轮询，完成后自动停止
  const pending = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const openDetail = async (jobId: string) => {
    try {
      setDetail(await runsApi.get(jobId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async (jobId: string) => {
    try {
      await runsApi.cancel(jobId);
      await load();
      message.success("任务已取消");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Table<RunJob>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={jobs}
        pagination={false}
        locale={{ emptyText: "暂无派发记录" }}
        columns={[
          {
            title: "目标",
            dataIndex: "targetName",
            render: (targetName: string, row) => (
              <span>
                {targetName}
                <br />
                <span style={{ color: "#999", fontSize: 12 }}>
                  {row.targetType === "collection" ? "Collection" : "单个请求"}
                  {` · 并发 ${row.concurrency}`}
                </span>
              </span>
            ),
          },
          {
            title: "Runner",
            dataIndex: "runnerName",
            width: 140,
            render: (runnerName: string | null, row) =>
              runnerName ?? row.agent ?? "任意 Runner",
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (status: RunJobStatus) => (
              <Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>
            ),
          },
          {
            title: "进度",
            width: 170,
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
            title: "派发时间",
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
            width: 140,
            render: (_: unknown, row) => (
              <>
                <Button type="link" size="small" onClick={() => void openDetail(row.id)}>
                  结果
                </Button>
                {(row.status === "queued" || row.status === "running") && (
                  <Popconfirm
                    title="取消该任务？"
                    okText="取消任务"
                    cancelText="返回"
                    onConfirm={() => void cancel(row.id)}
                  >
                    <Button type="link" size="small" danger>
                      取消
                    </Button>
                  </Popconfirm>
                )}
              </>
            ),
          },
        ]}
      />

      <RunDetailDrawer detail={detail} onClose={() => setDetail(null)} />
    </>
  );
}

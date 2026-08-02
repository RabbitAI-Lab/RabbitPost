import {
  CheckCircleFilled,
  CloseCircleFilled,
  DownloadOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { App, Button, Dropdown, Empty, Popover, Tooltip, Typography } from "antd";
import { useState } from "react";
import type { RunJobResult } from "@rabbitpost/shared";
import { runsApi } from "../../api";
import {
  loadCaseRunDetail,
  summarizeJob,
  type CaseRunRecord,
} from "../../lib/case-runs";
import { downloadRunReport, previewRunReport } from "../../lib/download";

/** 状态码配色（与 CasesPanel 行内结果一致） */
function statusColor(status?: number | null): string {
  if (status === undefined || status === null) return "rgba(0,0,0,0.25)";
  if (status < 400) return "#52c41a";
  if (status < 500) return "#faad14";
  return "#ff4d4f";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 单条用例结果明细（Popover 内展示） */
function EntryRow({ result: r }: { result: RunJobResult }) {
  const tests = r.testResults ?? [];
  const passed = tests.filter((t) => t.passed).length;
  const ok = r.ok && passed === tests.length;
  return (
    <div style={{ padding: "6px 0", borderTop: "1px dashed #f0f0f0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {ok ? (
          <CheckCircleFilled style={{ color: "#52c41a" }} />
        ) : (
          <CloseCircleFilled style={{ color: "#ff4d4f" }} />
        )}
        <Typography.Text strong style={{ fontSize: 12 }}>
          {r.name}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        {r.error ? (
          <Tooltip title={r.error} placement="topLeft">
            <Typography.Text
              type="danger"
              className="code-font"
              style={{
                fontSize: 11,
                maxWidth: 260,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "inline-block",
              }}
            >
              {r.error}
            </Typography.Text>
          </Tooltip>
        ) : (
          <span className="code-font" style={{ fontSize: 11, display: "inline-flex", gap: 8 }}>
            <span style={{ color: statusColor(r.status), fontWeight: 600 }}>
              {r.status} {r.statusText}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {r.durationMs}ms
            </Typography.Text>
          </span>
        )}
        {tests.length > 0 && (
          <span
            className="code-font"
            style={{ fontSize: 11, color: passed === tests.length ? "#52c41a" : "#ff4d4f" }}
          >
            {passed === tests.length ? "✓" : "✗"} {passed}/{tests.length}
          </span>
        )}
      </div>
      {/* 断言明细 */}
      {tests.length > 0 && (
        <div style={{ marginTop: 4, paddingLeft: 22 }}>
          {tests.map((t, i) => (
            <div
              key={i}
              className="code-font"
              style={{ display: "flex", gap: 6, fontSize: 11, lineHeight: "18px" }}
            >
              <span style={{ color: t.passed ? "#52c41a" : "#ff4d4f" }}>
                {t.passed ? "✓" : "✗"}
              </span>
              <span>{t.name}</span>
              {t.error && (
                <Typography.Text type="danger" style={{ fontSize: 11 }}>
                  — {t.error}
                </Typography.Text>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单条记录的报告明细（Popover 内容） */
function RecordDetail({ rec }: { rec: CaseRunRecord }) {
  if (!rec.results) {
    return <div style={{ padding: 12, textAlign: "center" }}>加载中…</div>;
  }
  return (
    <div style={{ maxWidth: 520, maxHeight: 420, overflow: "auto" }} className="slim-scroll">
      {rec.results.map((r) => (
        <EntryRow key={r.id} result={r} />
      ))}
    </div>
  );
}

interface Props {
  records: CaseRunRecord[];
  /** 记录结果加载后回填（避免重复请求） */
  onRecordLoaded: (jobId: string, results: RunJobResult[]) => void;
}

/** 用例运行历史（服务端持久化）：每条记录一行——类型 + Case 名/Run All + 状态 + 时间 + 汇总 + 下载；
 *  点击行 Popover 查看完整报告明细；Run All 聚合一条，单条运行各一条 */
export default function CaseRunHistoryPanel({ records, onRecordLoaded }: Props) {
  const { message } = App.useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  /** 点击行：展开 Popover 并按需加载结果 */
  const toggle = async (rec: CaseRunRecord) => {
    const jobId = rec.job.id;
    if (openId === jobId) {
      setOpenId(null);
      return;
    }
    setOpenId(jobId);
    if (!rec.results) {
      setLoadingId(jobId);
      try {
        const results = await loadCaseRunDetail(jobId);
        onRecordLoaded(jobId, results);
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingId(null);
      }
    }
  };

  const handleDownload = async (jobId: string, targetName: string, format: "junit" | "html") => {
    setDownloadingId(jobId);
    try {
      await downloadRunReport(jobId, targetName, format, runsApi.downloadReport);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        border: "1px solid #f0f0f0",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: "1px solid #f0f0f0",
          flexShrink: 0,
        }}
      >
        <Typography.Text strong style={{ fontSize: 12 }}>
          运行历史
        </Typography.Text>
      </div>

      {/* 记录列表：每条一行 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }} className="slim-scroll">
        {records.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: "24px 0" }}
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无运行记录
              </Typography.Text>
            }
          />
        ) : (
          records.map((rec) => {
            const job = rec.job;
            const sum = summarizeJob(job);
            const isBatch = job.caseId === null;
            const allOk = sum.failed === 0;
            return (
              <Popover
                key={job.id}
                open={openId === job.id}
                onOpenChange={(o) => {
                  if (!o) setOpenId(null);
                }}
                placement="rightTop"
                trigger="click"
                content={loadingId === job.id ? <div style={{ padding: 12 }}>加载中…</div> : <RecordDetail rec={rec} />}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void toggle(rec)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") void toggle(rec);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 10px",
                    borderBottom: "1px solid #f5f5f5",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {/* 整体状态点 */}
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: allOk ? "#52c41a" : "#ff4d4f",
                    }}
                  />
                  {/* 标题即类型：Run All 批量显示「Run All」，单条显示 Case 名，不再单独标类型 */}
                  <Typography.Text
                    strong
                    style={{
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                      flexShrink: 1,
                      ...(isBatch ? { color: "#722ed1" } : {}),
                    }}
                  >
                    {isBatch ? "Run All" : job.targetName.split(" / ").pop()}
                  </Typography.Text>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}
                  >
                    {formatTime(job.finishedAt ?? job.createdAt)}
                  </Typography.Text>
                  <span style={{ flex: 1, minWidth: 4 }} />
                  {/* 成败由行首状态点表达，通过/失败计数不重复显示；仅保留断言比 */}
                  {sum.testsTotal > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0, whiteSpace: "nowrap" }}>
                      断言 {sum.testsPassed}/{sum.testsTotal}
                    </Typography.Text>
                  )}
                  <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, display: "inline-flex", gap: 0 }}>
                    {/* 在线预览：新标签页打开 inline HTML 报告 */}
                    <Tooltip title="在线预览报告">
                      <Button
                        type="text"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => previewRunReport(job.id)}
                      />
                    </Tooltip>
                    <Dropdown
                      trigger={["click"]}
                      menu={{
                        items: [
                          { key: "html", label: "下载 HTML 报告" },
                          { key: "junit", label: "下载 JUnit XML" },
                        ],
                        onClick: ({ key }) =>
                          void handleDownload(job.id, job.targetName, key as "junit" | "html"),
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<DownloadOutlined />}
                        loading={downloadingId === job.id}
                      />
                    </Dropdown>
                  </span>
                </div>
              </Popover>
            );
          })
        )}
      </div>
    </div>
  );
}

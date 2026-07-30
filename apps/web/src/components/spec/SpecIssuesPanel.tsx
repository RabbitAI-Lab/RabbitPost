import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from "@ant-design/icons";
import { Segmented, Typography } from "antd";
import { useState } from "react";
import type { SpecIssue } from "@rabbitpost/shared";

interface Props {
  issues: SpecIssue[];
  /** 点击某条 issue 时跳转到定义中的对应位置 */
  onJump: (issue: SpecIssue) => void;
}

type Filter = "all" | "error" | "warning";

/** spec 编辑器底部 Issues 面板（对齐 Postman：按严重级筛选，点击跳转到定义行） */
export default function SpecIssuesPanel({ issues, onJump }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const visible = filter === "all" ? issues : issues.filter((i) => i.severity === filter);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: 30,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 8px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Issues</span>
        <span style={{ fontSize: 12, color: errors > 0 ? "#ff4d4f" : "#8c8c8c" }}>
          <CloseCircleFilled /> {errors}
        </span>
        <span style={{ fontSize: 12, color: warnings > 0 ? "#faad14" : "#8c8c8c" }}>
          <WarningFilled /> {warnings}
        </span>
        <span style={{ flex: 1 }} />
        <Segmented
          size="small"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: "all", label: "全部" },
            { value: "error", label: "错误" },
            { value: "warning", label: "警告" },
          ]}
        />
      </div>

      <div className="slim-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {visible.length === 0 ? (
          <div
            style={{
              padding: "16px 8px",
              textAlign: "center",
              fontSize: 12,
              color: "#8c8c8c",
            }}
          >
            {issues.length === 0 ? (
              <>
                <CheckCircleFilled style={{ color: "#52c41a", marginRight: 6 }} />
                定义校验通过，没有发现问题
              </>
            ) : (
              "当前筛选下没有条目"
            )}
          </div>
        ) : (
          visible.map((issue, i) => (
            <div
              key={`${issue.rule}-${issue.line}-${i}`}
              className="sidebar-hover"
              onClick={() => onJump(issue)}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "5px 8px",
                cursor: "pointer",
                borderBottom: "1px solid #fafafa",
              }}
            >
              {issue.severity === "error" ? (
                <CloseCircleFilled style={{ color: "#ff4d4f", flexShrink: 0 }} />
              ) : (
                <WarningFilled style={{ color: "#faad14", flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12 }}>{issue.message}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {issue.rule}
                  {issue.path && ` · ${issue.path}`}
                </Typography.Text>
              </div>
              <span className="code-font" style={{ color: "#8c8c8c", flexShrink: 0 }}>
                {issue.line}:{issue.column}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Spin, Table, Tabs, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { ExecuteResult, HistoryEntry } from "@rabbitpost/shared";
import { historyApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";

interface Props {
  response: ExecuteResult | null;
  sending: boolean;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "blue",
  POST: "green",
  PUT: "orange",
  PATCH: "cyan",
  DELETE: "red",
};

function statusColor(status?: number): string {
  if (!status) return "default";
  if (status < 300) return "success";
  if (status < 400) return "warning";
  return "error";
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function prettyBody(bodyText?: string, contentType?: string): string {
  if (!bodyText) return "";
  if (contentType?.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(bodyText), null, 2);
    } catch {
      return bodyText;
    }
  }
  return bodyText;
}

/** 无响应时各 tab 的占位（History 除外） */
function EmptyPane({ sending }: { sending: boolean }) {
  if (sending) {
    return (
      <div style={{ display: "grid", placeItems: "center", padding: 48 }}>
        <Spin description="请求发送中..." />
      </div>
    );
  }
  return (
    <div style={{ display: "grid", placeItems: "center", padding: 48 }}>
      <Empty description="点击 Send 发送请求，响应将显示在这里" />
    </div>
  );
}

/** Response > History：当前 Workspace 的请求历史，点击可在新 tab 打开 */
function HistoryPane() {
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const openFromHistory = useTabsStore((s) => s.openFromHistory);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!currentWorkspaceId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      setEntries(await historyApi.list(currentWorkspaceId));
    } finally {
      setLoading(false);
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener("rabbitpost:history-updated", handler);
    return () => window.removeEventListener("rabbitpost:history-updated", handler);
  }, [load]);

  return (
    <div>
      <Button
        size="small"
        icon={<ReloadOutlined />}
        loading={loading}
        style={{ marginBottom: 8 }}
        onClick={() => void load()}
      >
        刷新
      </Button>
      <Table<HistoryEntry>
        size="small"
        rowKey="id"
        pagination={false}
        loading={loading}
        dataSource={entries}
        locale={{ emptyText: "暂无请求历史" }}
        onRow={(entry) => ({
          style: { cursor: "pointer" },
          onClick: () => openFromHistory(entry.name ?? "", entry.request),
        })}
        columns={[
          {
            title: "Method",
            width: 80,
            render: (_, entry) => (
              <Tag
                color={METHOD_COLORS[entry.request.method] ?? "default"}
                style={{ marginRight: 0, fontSize: 11 }}
              >
                {entry.request.method}
              </Tag>
            ),
          },
          {
            title: "URL",
            ellipsis: true,
            render: (_, entry) => (
              <Typography.Text
                ellipsis
                className="code-font"
                style={{ fontSize: 12 }}
                title={entry.request.url}
              >
                {entry.request.url || entry.name || "-"}
              </Typography.Text>
            ),
          },
          {
            title: "Status",
            width: 90,
            render: (_, entry) =>
              entry.response ? (
                <Tag color={statusColor(entry.response.status)} style={{ fontSize: 11 }}>
                  {entry.response.status}
                </Tag>
              ) : (
                <Tag color="error" style={{ fontSize: 11 }}>
                  Error
                </Tag>
              ),
          },
          {
            title: "Time",
            width: 90,
            render: (_, entry) =>
              entry.response ? `${entry.response.durationMs} ms` : "-",
          },
          {
            title: "Date",
            width: 160,
            render: (_, entry) => new Date(entry.createdAt).toLocaleString(),
          },
        ]}
      />
    </div>
  );
}

export default function ResponseViewer({ response, sending }: Props) {
  const contentType = response?.headers?.["content-type"];
  const hasResponse = !sending && !!response?.ok;

  // 网络层错误：Body tab 内原样透传
  const errorPane =
    !sending && response && !response.ok ? (
      <Alert
        type="error"
        showIcon
        message="请求失败（网络层错误，原始信息透传）"
        description={
          <pre className="code-font" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {response.error}
          </pre>
        }
      />
    ) : null;

  const cookies = response?.cookies ?? [];
  const testResults = response?.testResults ?? [];
  const consoleLogs = response?.consoleLogs ?? [];

  return (
    <Tabs
      size="small"
      className="pane-tabs"
      tabBarExtraContent={
        hasResponse
          ? {
              right: (
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <Tag color={statusColor(response!.status)} style={{ fontSize: 12, marginRight: 0 }}>
                    {response!.status} {response!.statusText}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {response!.durationMs} ms · {formatSize(response!.sizeBytes)}
                    {response!.bodyBase64 ? " · binary (base64)" : ""}
                  </Typography.Text>
                </div>
              ),
            }
          : undefined
      }
      items={[
        {
          key: "body",
          label: "Body",
          children: hasResponse ? (
            <pre
              className="code-font"
              style={{
                background: "#fff",
                border: "1px solid #f0f0f0",
                borderRadius: 6,
                padding: 12,
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {prettyBody(response!.bodyText, contentType)}
            </pre>
          ) : (
            errorPane ?? <EmptyPane sending={sending} />
          ),
        },
        {
          key: "cookies",
          label: hasResponse ? `Cookies (${cookies.length})` : "Cookies",
          children: hasResponse ? (
            cookies.length === 0 ? (
              <Empty description="响应未设置 Cookie" />
            ) : (
              <Table
                size="small"
                rowKey="name"
                pagination={false}
                dataSource={cookies}
                columns={[
                  { title: "Name", dataIndex: "name", width: 160 },
                  { title: "Value", dataIndex: "value", ellipsis: true },
                  { title: "Domain", dataIndex: "domain", width: 140, render: (v?: string) => v ?? "-" },
                  { title: "Path", dataIndex: "path", width: 80, render: (v?: string) => v ?? "-" },
                  { title: "Expires", dataIndex: "expires", width: 180, render: (v?: string) => v ?? "-" },
                  {
                    title: "HttpOnly",
                    dataIndex: "httpOnly",
                    width: 80,
                    render: (v?: boolean) => (v ? "true" : "false"),
                  },
                  {
                    title: "Secure",
                    dataIndex: "secure",
                    width: 70,
                    render: (v?: boolean) => (v ? "true" : "false"),
                  },
                ]}
              />
            )
          ) : (
            errorPane ?? <EmptyPane sending={sending} />
          ),
        },
        {
          key: "headers",
          label: hasResponse
            ? `Headers (${Object.keys(response!.headers ?? {}).length})`
            : "Headers",
          children: hasResponse ? (
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={Object.entries(response!.headers ?? {}).map(([key, value]) => ({
                key,
                value,
              }))}
              columns={[
                { title: "Header", dataIndex: "key", width: 240 },
                { title: "Value", dataIndex: "value" },
              ]}
            />
          ) : (
            errorPane ?? <EmptyPane sending={sending} />
          ),
        },
        {
          key: "tests",
          label:
            !sending && response
              ? `Test Results (${testResults.filter((t) => t.passed).length}/${testResults.length})`
              : "Test Results",
          children:
            !sending && response ? (
              <div>
                {testResults.length === 0 ? (
                  <Empty description="未配置 Tests 脚本或无断言执行" />
                ) : (
                  <Table
                    size="small"
                    rowKey="name"
                    pagination={false}
                    dataSource={testResults}
                    columns={[
                      {
                        title: "结果",
                        dataIndex: "passed",
                        width: 80,
                        render: (passed: boolean) =>
                          passed ? (
                            <Tag color="success">PASS</Tag>
                          ) : (
                            <Tag color="error">FAIL</Tag>
                          ),
                      },
                      { title: "用例", dataIndex: "name" },
                      {
                        title: "错误",
                        dataIndex: "error",
                        render: (error?: string) =>
                          error ? (
                            <Typography.Text type="danger" className="code-font">
                              {error}
                            </Typography.Text>
                          ) : (
                            "-"
                          ),
                      },
                    ]}
                  />
                )}
                {consoleLogs.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      脚本 Console 输出
                    </Typography.Text>
                    <pre
                      className="code-font"
                      style={{
                        background: "#111",
                        color: "#eee",
                        borderRadius: 6,
                        padding: 12,
                        margin: "4px 0 0",
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      {consoleLogs
                        .map((l) => `[${l.level.toUpperCase()}] ${l.args.join(" ")}`)
                        .join("\n")}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <EmptyPane sending={sending} />
            ),
        },
        {
          key: "history",
          label: "History",
          children: <HistoryPane />,
        },
      ]}
    />
  );
}

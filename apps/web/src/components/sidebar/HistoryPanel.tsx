import { ClearOutlined, ReloadOutlined } from "@ant-design/icons";
import { App, Button, Empty, Modal, Spin, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry } from "@rabbitpost/shared";
import { historyApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";

const METHOD_COLORS: Record<string, string> = {
  GET: "blue",
  POST: "green",
  PUT: "orange",
  PATCH: "cyan",
  DELETE: "red",
};

export default function HistoryPanel() {
  const { message } = App.useApp();
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
    // 发送请求后历史会更新，监听自定义事件刷新
    const handler = () => void load();
    window.addEventListener("rabbitpost:history-updated", handler);
    return () => window.removeEventListener("rabbitpost:history-updated", handler);
  }, [load]);

  const handleClear = () => {
    if (!currentWorkspaceId) return;
    Modal.confirm({
      title: "清空历史",
      content: "确定清空当前 Workspace 的全部请求历史吗？",
      okButtonProps: { danger: true },
      okText: "清空",
      cancelText: "取消",
      onOk: async () => {
        await historyApi.clear(currentWorkspaceId);
        await load();
        message.success("历史已清空");
      },
    });
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "8px 8px 0",
      }}
    >
      {/* 工具栏吸顶，不随列表滚动 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexShrink: 0 }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => void load()}
          loading={loading}
        >
          刷新
        </Button>
        <Button
          size="small"
          danger
          icon={<ClearOutlined />}
          disabled={entries.length === 0}
          onClick={handleClear}
        >
          清空
        </Button>
      </div>

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 8 }}
      >
      {entries.length === 0 ? (
        <Empty description="暂无请求历史" style={{ marginTop: 24 }} />
      ) : (
        <Spin spinning={loading}>
          <div>
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="sidebar-hover"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  padding: "6px 4px",
                  borderRadius: 4,
                }}
                onClick={() => openFromHistory(entry)}
              >
                <Tag
                  color={METHOD_COLORS[entry.request.method] ?? "default"}
                  style={{ marginRight: 0, fontSize: 11 }}
                >
                  {entry.request.method}
                </Tag>
                <Typography.Text
                  ellipsis
                  className="code-font"
                  style={{ flex: 1, fontSize: 12 }}
                  title={entry.request.url}
                >
                  {entry.request.url || entry.name || "-"}
                </Typography.Text>
              </div>
            ))}
          </div>
        </Spin>
      )}
      </div>
    </div>
  );
}

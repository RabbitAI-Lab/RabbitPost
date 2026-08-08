import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
} from "@ant-design/icons";
import { Button, Input, Splitter, Tabs, Tag } from "antd";
import { useMemo, useState } from "react";
import MessageLog from "../MessageLog";
import { HeadersSection } from "../RequestConfigTabs";
import VarInput from "../../common/variable/VarInput";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import { substituteVariables } from "@rabbitpost/shared";
import { useRtConnection } from "./use-rt-connection";

interface Props {
  tab: RequestTab;
}

/** SSE 帧 {event, data, id} 解析为时间线文本与事件类型 */
function parseSseFrame(data: string): { event: string; text: string } {
  try {
    const frame = JSON.parse(data) as { event?: string; data?: string; id?: string };
    const event = frame.event || "message";
    const idPart = frame.id ? ` (id: ${frame.id})` : "";
    return { event, text: `← [${event}]${idPart} ${frame.data ?? ""}` };
  } catch {
    return { event: "message", text: data };
  }
}

/**
 * SSE（Server-Sent Events）协议编辑器：
 * - 只读流：Start/Stop 经 Runner 拉取（api 实时桥）（支持自定义请求头，浏览器 EventSource 做不到）
 * - event type 过滤只影响展示，不过滤连接；连接状态与消息记录不持久化
 */
export default function SseEditor({ tab }: Props) {
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const sseCfg = tab.config.sse ?? {};
  const eventFilter = (sseCfg.eventFilter ?? "").trim();

  const conn = useRtConnection({
    tab,
    protocol: "sse",
    resolveUrl: (raw, vars) => {
      const url = substituteVariables(raw, vars).trim();
      return /^https?:\/\//i.test(url) ? url : null;
    },
    buildConfig: (vars) => ({
      headers: tab.config.headers.map((h) => ({
        ...h,
        value: substituteVariables(h.value, vars),
      })),
    }),
    formatMessage: (dir, data) => (dir === "in" ? parseSseFrame(data).text : data),
  });

  // 事件类型过滤（仅影响展示）：非 system 的 in 消息按帧 event 字段过滤
  const visibleEntries = useMemo(() => {
    if (!eventFilter) return conn.entries;
    return conn.entries.filter((e) => {
      if (e.dir !== "in") return true;
      return e.text.startsWith(`← [${eventFilter}]`);
    });
  }, [conn.entries, eventFilter]);

  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[conn.connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* URL + Start/Stop */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="https://api.example.com/events"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          disabled={conn.connected || conn.connState === "connecting"}
        />
        {conn.connected || conn.connState === "connecting" ? (
          <Button danger icon={<DisconnectOutlined />} style={{ flexShrink: 0 }} onClick={conn.disconnect}>
            Stop
          </Button>
        ) : (
          <Button type="primary" icon={<ApiOutlined />} style={{ flexShrink: 0 }} onClick={() => void conn.connect()}>
            Start
          </Button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Tabs
          size="small"
          className="pane-tabs"
          style={{ height: "100%" }}
          tabBarExtraContent={{ right: stateTag }}
          items={[
            {
              key: "events",
              label: "Events",
              children: (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <Input
                      size="small"
                      style={{ width: 220 }}
                      placeholder="按 event 类型过滤（空 = 全部）"
                      value={sseCfg.eventFilter ?? ""}
                      onChange={(e) =>
                        patch(tab.key, { sse: { ...sseCfg, eventFilter: e.target.value } })
                      }
                    />
                    <Button type="text" size="small" icon={<ClearOutlined />} onClick={conn.clearEntries}>
                      Clear
                    </Button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                    <MessageLog entries={visibleEntries} />
                  </div>
                </div>
              ),
            },
            {
              key: "headers",
              label: "Headers",
              children: (
                <HeadersSection
                  tab={tab}
                  onChange={(headers) => patch(tab.key, { headers })}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

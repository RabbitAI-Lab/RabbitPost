import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { App, Button, Input, Select, Space, Splitter, Tabs, Tag } from "antd";
import MessageLog from "../MessageLog";
import VarInput from "../../common/variable/VarInput";
import VarTextArea from "../../common/variable/VarTextArea";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import { substituteVariables } from "@rabbitpost/shared";
import { useRtConnection } from "./use-rt-connection";

interface Props {
  tab: RequestTab;
}

/** 格式化 {event, args} 帧为时间线文本 */
function formatFrame(dir: "in" | "out", data: string): string {
  try {
    const frame = JSON.parse(data) as { event?: string; args?: unknown[] };
    const args = (frame.args ?? []).map((a) => JSON.stringify(a)).join(", ");
    return `${dir === "in" ? "←" : "→"} ${frame.event ?? "?"}${args ? `  ${args}` : ""}`;
  } catch {
    return data;
  }
}

/**
 * Socket.IO 协议编辑器（参考 Postman）：
 * - URL 写 origin + namespace（如 http://host:3000/admin），path/auth 在 Settings
 * - emit = 事件名 + 单个 JSON 参数；收到的任意事件（含 ack）都进消息时间线
 * - 连接经 Runner 执行（api 实时桥）
 */
export default function SocketIOEditor({ tab }: Props) {
  const { message } = App.useApp();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const sioCfg = tab.config.socketio ?? {};

  const conn = useRtConnection({
    tab,
    protocol: "socketio",
    resolveUrl: (raw, vars) => {
      const url = substituteVariables(raw, vars).trim();
      return /^https?:\/\//i.test(url) ? url : null;
    },
    buildConfig: (vars) => {
      let auth: Record<string, unknown> | undefined;
      if (sioCfg.auth?.trim()) {
        try {
          auth = JSON.parse(substituteVariables(sioCfg.auth, vars)) as Record<string, unknown>;
        } catch {
          /* auth JSON 非法时忽略，发送时 Runner 侧也不校验 */
        }
      }
      return {
        path: sioCfg.path || undefined,
        auth,
        version: sioCfg.version ?? "v4",
      };
    },
    formatMessage: (dir, data) => formatFrame(dir, data),
  });

  const handleSend = () => {
    const event = (sioCfg.eventDraft ?? "").trim();
    if (!event) {
      message.warning("请输入事件名");
      return;
    }
    let args: unknown[] = [];
    const payload = (sioCfg.payloadDraft ?? "").trim();
    if (payload) {
      try {
        args = [JSON.parse(substituteVariables(payload, conn.resolveVars()))];
      } catch {
        message.error("Payload 需为合法 JSON 值");
        return;
      }
    }
    conn.sendRaw(JSON.stringify({ event, args }));
  };

  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[conn.connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* URL + Connect/Disconnect */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="http://localhost:3000 或 http://host:3000/namespace"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          disabled={conn.connected || conn.connState === "connecting"}
        />
        {/* 客户端版本：老服务端（v2 协议）需切到对应客户端 */}
        <Select
          size="middle"
          style={{ width: 110, flexShrink: 0 }}
          value={sioCfg.version ?? "v4"}
          disabled={conn.connected || conn.connState === "connecting"}
          options={[
            { value: "v2", label: "Client v2" },
            { value: "v3", label: "Client v3" },
            { value: "v4", label: "Client v4" },
          ]}
          onChange={(v) =>
            patch(tab.key, { socketio: { ...sioCfg, version: v as "v2" | "v3" | "v4" } })
          }
        />
        {conn.connected || conn.connState === "connecting" ? (
          <Button danger icon={<DisconnectOutlined />} style={{ flexShrink: 0 }} onClick={conn.disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button type="primary" icon={<ApiOutlined />} style={{ flexShrink: 0 }} onClick={() => void conn.connect()}>
            Connect
          </Button>
        )}
      </div>

      <Splitter layout="vertical" style={{ flex: 1, minHeight: 0 }}>
        <Splitter.Panel defaultSize="60%" min="20%" style={{ paddingBottom: 4 }}>
          <Tabs
            size="small"
            className="pane-tabs"
            tabBarExtraContent={{ right: stateTag }}
            items={[
              {
                key: "messages",
                label: "Messages",
                children: (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <Button type="text" size="small" icon={<ClearOutlined />} onClick={conn.clearEntries}>
                        Clear
                      </Button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                      <MessageLog entries={conn.entries} />
                    </div>
                  </div>
                ),
              },
              {
                key: "settings",
                label: "Settings",
                children: (
                  <Space direction="vertical" style={{ width: 480 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>
                        端点路径（默认 /socket.io）
                      </div>
                      <Input
                        size="small"
                        placeholder="/socket.io"
                        value={sioCfg.path ?? ""}
                        onChange={(e) =>
                          patch(tab.key, { socketio: { ...sioCfg, path: e.target.value } })
                        }
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>
                        Auth 负载（JSON，握手时随 auth 发送）
                      </div>
                      <VarTextArea
                        className="code-font"
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        placeholder='{"token": "..."}'
                        value={sioCfg.auth ?? ""}
                        onChange={(text) =>
                          patch(tab.key, { socketio: { ...sioCfg, auth: text } })
                        }
                      />
                    </div>
                  </Space>
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          {/* emit 编辑器：事件名 + JSON 参数 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <Input
              size="small"
              placeholder="事件名（如 chat message）"
              style={{ width: 280 }}
              value={sioCfg.eventDraft ?? ""}
              onChange={(e) =>
                patch(tab.key, { socketio: { ...sioCfg, eventDraft: e.target.value } })
              }
            />
            <VarTextArea
              className="code-font"
              style={{ flex: 1, resize: "none" }}
              placeholder='JSON 参数（单个 arg，如 {"text": "hello"}），留空则不带参数'
              value={sioCfg.payloadDraft ?? ""}
              onChange={(text) =>
                patch(tab.key, { socketio: { ...sioCfg, payloadDraft: text } })
              }
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!conn.connected || !(sioCfg.eventDraft ?? "").trim()}
                onClick={handleSend}
              >
                Send
              </Button>
            </div>
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

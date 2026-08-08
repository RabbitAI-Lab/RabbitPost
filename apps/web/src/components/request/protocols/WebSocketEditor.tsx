import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { App, Button, Input, Select, Space, Splitter, Tabs, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { substituteVariables } from "@rabbitpost/shared";
import { buildVariableMap } from "../../../lib/execute";
import { rtClient } from "../../../lib/rt-client";
import { useAppStore } from "../../../stores/app";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import VarInput from "../../common/variable/VarInput";
import VarTextArea from "../../common/variable/VarTextArea";
import MessageLog, { type MessageLogEntry } from "../MessageLog";
import { HeadersSection } from "../RequestConfigTabs";

interface Props {
  tab: RequestTab;
}

type ConnState = "idle" | "connecting" | "open" | "closed";

/**
 * WebSocket 协议编辑器（参考 Postman）：
 * - Connect/Disconnect 经 Runner 建立连接（api 实时桥）（浏览器不直连目标）
 * - URL / 握手头支持 {{变量}} 替换；子协议、消息草稿随请求配置持久化
 * - 消息记录仅保留在内存，tab 关闭或组件卸载即断开连接
 */
export default function WebSocketEditor({ tab }: Props) {
  const { message } = App.useApp();
  const { currentWorkspaceId, activeEnvironmentId, environments, collections } = useAppStore();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const [connState, setConnState] = useState<ConnState>("idle");
  const [entries, setEntries] = useState<MessageLogEntry[]>([]);
  const nextId = useRef(1);
  /** 组件卸载时若仍连着则断开（用 ref 跟踪避免 effect 依赖抖动） */
  const connectedRef = useRef(false);

  const wsCfg = tab.config.websocket ?? {};
  const encoding = wsCfg.encoding ?? "text";

  const pushEntry = (dir: MessageLogEntry["dir"], text: string, ts?: number) => {
    setEntries((prev) => [
      ...prev,
      { id: nextId.current++, dir, text, ts: ts ?? Date.now() },
    ]);
  };

  const resolveVars = () =>
    buildVariableMap({
      environmentId: activeEnvironmentId,
      environments,
      collectionVariables: collections.find((c) => c.id === tab.collectionId)?.variables,
    });

  const handleConnect = async () => {
    const vars = resolveVars();
    const url = substituteVariables(tab.config.url, vars).trim();
    if (!/^wss?:\/\//i.test(url)) {
      message.warning("请输入合法的 WebSocket URL（ws:// 或 wss:// 开头）");
      return;
    }
    if (!currentWorkspaceId) {
      message.warning("请先选择 Workspace");
      return;
    }
    setEntries([]);
    setConnState("connecting");
    try {
      await rtClient.connect({
        id: tab.key,
        protocol: "websocket",
        url,
        workspaceId: currentWorkspaceId,
        config: {
          headers: tab.config.headers.map((h) => ({
            ...h,
            value: substituteVariables(h.value, vars),
          })),
          protocols: (wsCfg.protocols ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        onEvent: (ev) => {
          if (ev.type === "status") {
            if (ev.state === "open") {
              connectedRef.current = true;
              setConnState("open");
              pushEntry("system", `已连接 ${url}`);
            } else if (ev.state === "closed") {
              connectedRef.current = false;
              setConnState("closed");
              pushEntry(
                "system",
                `连接已关闭${ev.code ? `（code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}）` : ""}`,
              );
            } else if (ev.state === "error") {
              connectedRef.current = false;
              setConnState("closed");
              pushEntry("system", `连接失败：${ev.reason ?? "未知错误"}`);
            }
          } else if (ev.type === "message") {
            pushEntry(
              ev.dir!,
              ev.encoding === "base64" ? `[binary base64] ${ev.data}` : (ev.data ?? ""),
              ev.ts,
            );
          } else if (ev.type === "error") {
            pushEntry("system", `错误：${ev.message}`);
          }
        },
      });
    } catch (e) {
      setConnState("idle");
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDisconnect = () => {
    rtClient.close(tab.key);
    connectedRef.current = false;
  };

  const handleSend = () => {
    const draft = wsCfg.messageDraft ?? "";
    if (!draft.trim()) return;
    rtClient.send(tab.key, substituteVariables(draft, resolveVars()), encoding);
  };

  // 卸载时断开
  useEffect(() => {
    return () => {
      if (connectedRef.current) rtClient.close(tab.key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  const connected = connState === "open";
  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* URL + Connect/Disconnect */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="wss://echo.example.com/ws"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          onEnter={() => {
            if (!connected && connState !== "connecting") void handleConnect();
          }}
          disabled={connected || connState === "connecting"}
        />
        {connected || connState === "connecting" ? (
          <Button
            danger
            icon={<DisconnectOutlined />}
            style={{ flexShrink: 0 }}
            onClick={handleDisconnect}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<ApiOutlined />}
            style={{ flexShrink: 0 }}
            onClick={() => void handleConnect()}
          >
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
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <Button
                        type="text"
                        size="small"
                        icon={<ClearOutlined />}
                        onClick={() => setEntries([])}
                      >
                        Clear
                      </Button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                      <MessageLog entries={entries} />
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
              {
                key: "settings",
                label: "Settings",
                children: (
                  <Space direction="vertical" style={{ width: 360 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>
                        Sec-WebSocket-Protocol（多个用逗号分隔）
                      </div>
                      <Input
                        size="small"
                        placeholder="chat, superchat"
                        value={wsCfg.protocols ?? ""}
                        onChange={(e) =>
                          patch(tab.key, {
                            websocket: { ...wsCfg, protocols: e.target.value },
                          })
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
          {/* 消息编辑器：草稿随配置持久化，编码可选 text / base64 二进制 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <VarTextArea
              className="code-font"
              style={{ flex: 1, resize: "none" }}
              placeholder={encoding === "base64" ? "二进制消息的 Base64 编码" : 'Hello, WebSocket! 支持 {{变量}}'}
              value={wsCfg.messageDraft ?? ""}
              onChange={(text) =>
                patch(tab.key, { websocket: { ...wsCfg, messageDraft: text } })
              }
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Select
                size="small"
                style={{ width: 130 }}
                value={encoding}
                options={[
                  { value: "text", label: "Text" },
                  { value: "base64", label: "Binary (Base64)" },
                ]}
                onChange={(v) =>
                  patch(tab.key, { websocket: { ...wsCfg, encoding: v } })
                }
              />
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!connected || !(wsCfg.messageDraft ?? "").trim()}
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

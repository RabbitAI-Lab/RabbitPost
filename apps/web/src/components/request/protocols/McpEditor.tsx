import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { App, Button, Descriptions, Input, Select, Space, Splitter, Tabs, Tag } from "antd";
import { useState } from "react";
import MessageLog from "../MessageLog";
import VarInput from "../../common/variable/VarInput";
import VarTextArea from "../../common/variable/VarTextArea";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import { substituteVariables } from "@rabbitpost/shared";
import { useRtConnection } from "./use-rt-connection";

interface Props {
  tab: RequestTab;
}

/** MCP 支持的操作列表 */
const MCP_OPERATIONS = [
  { value: "tools/list", label: "tools/list — 列出工具" },
  { value: "tools/call", label: "tools/call — 调用工具" },
  { value: "resources/list", label: "resources/list — 列出资源" },
  { value: "resources/read", label: "resources/read — 读取资源" },
  { value: "prompts/list", label: "prompts/list — 列出提示词" },
  { value: "prompts/get", label: "prompts/get — 获取提示词" },
];

/** 各操作的参数占位示例 */
const PARAMS_PLACEHOLDER: Record<string, string> = {
  "tools/call": '{"name": "tool_name", "arguments": {}}',
  "resources/read": '{"uri": "file:///path"}',
  "prompts/get": '{"name": "prompt_name", "arguments": {}}',
};

/** 格式化 MCP 响应帧为时间线文本 */
function formatFrame(dir: "in" | "out", data: string): string {
  try {
    const frame = JSON.parse(data) as { action?: string; result?: unknown; error?: string };
    if (dir === "out") return `→ ${frame.action} ${data.length > 200 ? "" : JSON.stringify({ ...frame, action: undefined }).replace(/\{\s*"action":\s*undefined\s*\}/, "")}`.trimEnd();
    if (frame.error) return `← ${frame.action} 错误：${frame.error}`;
    const text = JSON.stringify(frame.result, null, 2);
    return `← ${frame.action}\n${text}`;
  } catch {
    return data;
  }
}

interface ServerInfo {
  server?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

/**
 * MCP 协议编辑器（参考 Postman MCP 客户端）：
 * - URL 为 MCP server 端点；transport 默认 auto（Streamable HTTP 优先，失败回退 SSE）
 * - 连接后展示 serverInfo（名称/版本/能力）；操作 = 下拉选择 + JSON 参数 + Execute
 * - 结果 JSON 进消息时间线；连接经 Runner 执行（api 实时桥）
 */
export default function McpEditor({ tab }: Props) {
  const { message } = App.useApp();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const mcpCfg = tab.config.mcp ?? {};
  const operation = mcpCfg.operation ?? "tools/list";
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  const conn = useRtConnection({
    tab,
    protocol: "mcp",
    resolveUrl: (raw, vars) => {
      const url = substituteVariables(raw, vars).trim();
      return /^https?:\/\//i.test(url) ? url : null;
    },
    buildConfig: () => ({ transport: mcpCfg.transport ?? "auto" }),
    formatMessage: (dir, data) => formatFrame(dir, data),
    onRawEvent: (ev) => {
      if (ev.type !== "message" || ev.dir !== "in" || !ev.data) return;
      try {
        const frame = JSON.parse(ev.data) as { action?: string; result?: ServerInfo };
        if (frame.action === "serverInfo" && frame.result) setServerInfo(frame.result);
      } catch {
        /* 非 JSON 忽略 */
      }
    },
  });

  const handleExecute = () => {
    const params = (mcpCfg.paramsDraft ?? "").trim();
    let payload: Record<string, unknown> = { action: operation };
    if (params) {
      try {
        payload = {
          action: operation,
          ...(JSON.parse(substituteVariables(params, conn.resolveVars())) as Record<string, unknown>),
        };
      } catch {
        message.error("参数需为合法 JSON 对象");
        return;
      }
    }
    conn.sendRaw(JSON.stringify(payload));
  };

  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[conn.connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Server URL + Connect/Disconnect */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="http://localhost:3000/mcp"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          disabled={conn.connected || conn.connState === "connecting"}
        />
        <Select
          size="middle"
          style={{ width: 170, flexShrink: 0 }}
          value={mcpCfg.transport ?? "auto"}
          disabled={conn.connected || conn.connState === "connecting"}
          options={[
            { value: "auto", label: "Auto" },
            { value: "streamable-http", label: "Streamable HTTP" },
            { value: "sse", label: "SSE (legacy)" },
          ]}
          onChange={(v) => patch(tab.key, { mcp: { ...mcpCfg, transport: v } })}
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
        <Splitter.Panel defaultSize="55%" min="20%" style={{ paddingBottom: 4 }}>
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
                key: "server",
                label: "Server",
                children: serverInfo ? (
                  <Descriptions size="small" column={1} bordered>
                    <Descriptions.Item label="名称">
                      {serverInfo.server?.name ?? "-"}
                    </Descriptions.Item>
                    <Descriptions.Item label="版本">
                      {serverInfo.server?.version ?? "-"}
                    </Descriptions.Item>
                    <Descriptions.Item label="Capabilities">
                      <span className="code-font" style={{ fontSize: 12 }}>
                        {Object.keys(serverInfo.capabilities ?? {}).join(", ") || "-"}
                      </span>
                    </Descriptions.Item>
                    {serverInfo.instructions && (
                      <Descriptions.Item label="Instructions">
                        {serverInfo.instructions}
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                ) : (
                  <span style={{ fontSize: 12, color: "#8c8c8c" }}>
                    连接后此处展示 MCP server 的名称、版本与能力。
                  </span>
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          {/* 操作面板：operation 下拉 + JSON 参数 + Execute */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <Select
              size="small"
              style={{ width: 280 }}
              value={operation}
              options={MCP_OPERATIONS}
              onChange={(v) => patch(tab.key, { mcp: { ...mcpCfg, operation: v } })}
            />
            {["tools/call", "resources/read", "prompts/get"].includes(operation) && (
              <VarTextArea
                className="code-font"
                style={{ flex: 1, resize: "none" }}
                placeholder={PARAMS_PLACEHOLDER[operation]}
                value={mcpCfg.paramsDraft ?? ""}
                onChange={(text) => patch(tab.key, { mcp: { ...mcpCfg, paramsDraft: text } })}
              />
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!conn.connected}
                onClick={handleExecute}
              >
                Execute
              </Button>
            </div>
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

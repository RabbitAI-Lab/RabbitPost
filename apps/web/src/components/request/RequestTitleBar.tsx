import {
  BlockOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  NodeIndexOutlined,
  RobotOutlined,
  ShareAltOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  WifiOutlined,
} from "@ant-design/icons";
import { Select, Tag, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import type { RequestProtocol } from "@rabbitpost/shared";
import { REQUEST_PROTOCOLS } from "@rabbitpost/shared";
import { findFolderTrail, findNodeName } from "../../lib/tree";
import { useAppStore } from "../../stores/app";
import { useTabsStore, type RequestTab } from "../../stores/tabs";

/** 协议类型的展示名与图标 */
const PROTOCOL_META: Record<RequestProtocol, { label: string; icon: ReactNode }> = {
  http: { label: "HTTP", icon: <GlobalOutlined style={{ color: "#ff6c37" }} /> },
  graphql: { label: "GraphQL", icon: <ShareAltOutlined style={{ color: "#e10098" }} /> },
  ai: { label: "AI", icon: <RobotOutlined style={{ color: "#722ed1" }} /> },
  mcp: { label: "MCP", icon: <BlockOutlined style={{ color: "#1677ff" }} /> },
  grpc: { label: "gRPC", icon: <ThunderboltOutlined style={{ color: "#2f9e44" }} /> },
  websocket: { label: "WebSocket", icon: <SwapOutlined style={{ color: "#faad14" }} /> },
  socketio: { label: "Socket.IO", icon: <NodeIndexOutlined style={{ color: "#13c2c2" }} /> },
  mqtt: { label: "MQTT", icon: <WifiOutlined style={{ color: "#660066" }} /> },
};

interface Props {
  tab: RequestTab;
  /** 行右侧操作区（如 Save 按钮） */
  extra?: ReactNode;
}

/** URL 上方标题行：协议类型（保存前可改）+ 目录路径 > 标题 + 右侧操作区 */
export default function RequestTitleBar({ tab, extra }: Props) {
  const { collections, collectionTrees } = useAppStore();
  const { updateConfig } = useTabsStore();

  const protocol: RequestProtocol = tab.config.protocol ?? "http";
  const saved = tab.itemId !== null;
  // 用例 tab：徽章 + 面包屑追加所属接口名（Collection > … > 接口 / 用例）
  const isCase = !!tab.caseId;

  // 目录路径：Collection 名 + 祖先文件夹名（仅已保存的请求有）
  let pathSegments: string[] = [];
  let requestName: string | null = null;
  if (tab.itemId && tab.collectionId) {
    const collectionName = collections.find((c) => c.id === tab.collectionId)?.name;
    const trail = findFolderTrail(
      collectionTrees[tab.collectionId] ?? [],
      tab.itemId,
    );
    pathSegments = [...(collectionName ? [collectionName] : []), ...(trail ?? [])];
    if (isCase) {
      requestName = findNodeName(collectionTrees[tab.collectionId] ?? [], tab.itemId);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        marginBottom: 8,
        minWidth: 0,
      }}
    >
      {isCase && (
        <Tag
          icon={<ExperimentOutlined />}
          color="purple"
          style={{ marginRight: 2, flexShrink: 0 }}
        >
          CASE
        </Tag>
      )}
      {saved ? (
        <Tooltip title={`${PROTOCOL_META[protocol].label}（保存后不可修改）`}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              padding: "0 4px",
            }}
          >
            {PROTOCOL_META[protocol].icon}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {PROTOCOL_META[protocol].label}
            </Typography.Text>
          </span>
        </Tooltip>
      ) : (
        <Select
          size="small"
          variant="borderless"
          value={protocol}
          popupMatchSelectWidth={false}
          style={{ flexShrink: 0 }}
          options={REQUEST_PROTOCOLS.map((p) => ({
            value: p,
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {PROTOCOL_META[p].icon}
                {PROTOCOL_META[p].label}
              </span>
            ),
          }))}
          onChange={(p) => updateConfig(tab.key, { protocol: p })}
        />
      )}

      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {pathSegments.map((seg, i) => (
          <span
            key={`${seg}-${i}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, whiteSpace: "nowrap" }}
              ellipsis
            >
              {seg}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {">"}
            </Typography.Text>
          </span>
        ))}
        {isCase && requestName && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, whiteSpace: "nowrap" }}
              ellipsis
            >
              {requestName}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              /
            </Typography.Text>
          </span>
        )}
        <Typography.Text strong style={{ fontSize: 13, whiteSpace: "nowrap" }} ellipsis>
          {tab.name}
        </Typography.Text>
      </span>

      {extra && (
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{extra}</span>
      )}
    </div>
  );
}

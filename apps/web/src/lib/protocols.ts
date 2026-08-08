import type { RequestConfig, RequestProtocol } from "@rabbitpost/shared";
import { createEmptyRequestConfig } from "@rabbitpost/shared";

/** 新建请求可选的协议类型（ai 协议暂未实现，不出现在入口） */
export const NEW_REQUEST_PROTOCOLS: { value: RequestProtocol; label: string }[] = [
  { value: "http", label: "HTTP" },
  { value: "graphql", label: "GraphQL" },
  { value: "websocket", label: "WebSocket" },
  { value: "socketio", label: "Socket.IO" },
  { value: "mqtt", label: "MQTT" },
  { value: "sse", label: "SSE" },
  { value: "mcp", label: "MCP" },
  { value: "grpc", label: "gRPC" },
];

/**
 * 按协议生成初始请求配置：
 * 非 http 写入 protocol（保存后不可修改）；GraphQL 额外固定 POST + GraphQL body
 * （与 RequestTitleBar 切换协议时的联动一致）。
 */
export function createRequestConfigForProtocol(protocol: RequestProtocol): RequestConfig {
  const config = createEmptyRequestConfig();
  config.protocol = protocol;
  if (protocol === "graphql") {
    config.method = "POST";
    config.body = { ...config.body, type: "graphql" };
  }
  return config;
}

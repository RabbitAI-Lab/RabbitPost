import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Checkbox,
  Input,
  Select,
  Space,
  Splitter,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import MessageLog from "../MessageLog";
import KeyValueEditor from "../../common/KeyValueEditor";
import VarInput from "../../common/variable/VarInput";
import VarTextArea from "../../common/variable/VarTextArea";
import { useTabsStore, type RequestTab } from "../../../stores/tabs";
import { substituteVariables } from "@rabbitpost/shared";
import { useRtConnection } from "./use-rt-connection";

interface Props {
  tab: RequestTab;
}

/** serviceList 帧的服务/方法模型（与 Runner grpc handler 契约一致） */
interface GrpcMethodMeta {
  name: string;
  requestStream: boolean;
  responseStream: boolean;
  requestExample?: unknown;
}
interface GrpcServiceMeta {
  name: string;
  methods: GrpcMethodMeta[];
}

/** 格式化 gRPC 事件帧为时间线文本 */
function formatFrame(dir: "in" | "out", data: string): string {
  try {
    const frame = JSON.parse(data) as {
      action?: string;
      event?: string;
      payload?: unknown;
      status?: { code?: number; details?: string };
      error?: string;
    };
    if (dir === "out") return `→ ${frame.action}${frame.event ? `/${frame.event}` : ""} ${frame.payload ? JSON.stringify(frame.payload) : ""}`.trimEnd();
    if (frame.action === "serviceList") return "← 已获取服务列表（见 Services 面板）";
    if (frame.event === "data") return `← ${JSON.stringify(frame.payload)}`;
    if (frame.event === "end")
      return `← 调用结束（code ${frame.status?.code ?? "?"}: ${frame.status?.details ?? ""}）`;
    if (frame.event === "error") return `← 调用错误：${frame.error}`;
    return data;
  } catch {
    return data;
  }
}

/** 方法流式类型标签 */
function methodTypeTag(m?: GrpcMethodMeta) {
  if (!m) return null;
  if (m.requestStream && m.responseStream) return <Tag color="purple">BIDI STREAMING</Tag>;
  if (m.requestStream) return <Tag color="geekblue">CLIENT STREAMING</Tag>;
  if (m.responseStream) return <Tag color="cyan">SERVER STREAMING</Tag>;
  return <Tag color="green">UNARY</Tag>;
}

/**
 * gRPC 协议编辑器（参考 Postman，支持 unary 与全部流式调用）：
 * - URL 为 host:port；服务发现优先 server reflection，失败时用 .proto 文本
 * - 连接后展示服务/方法列表；invoke 发起调用，流式方法可连续 push、half-close
 * - 连接与调用经 Runner 执行（api 实时桥，Runner 侧 tonic）
 */
export default function GrpcEditor({ tab }: Props) {
  const { message } = App.useApp();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const grpcCfg = tab.config.grpc ?? {};
  const [services, setServices] = useState<GrpcServiceMeta[]>([]);
  /** 是否有进行中的调用（流式时允许 push/halfClose） */
  const [callActive, setCallActive] = useState(false);

  const currentMethod: GrpcMethodMeta | undefined = services
    .find((s) => s.name === grpcCfg.service)
    ?.methods.find((m) => m.name === grpcCfg.method);

  const conn = useRtConnection({
    tab,
    protocol: "grpc",
    resolveUrl: (raw, vars) => {
      const url = substituteVariables(raw, vars).trim();
      return /^[\w.-]+:\d+$/.test(url) ? url : null;
    },
    buildConfig: () => ({
      tls: grpcCfg.tls ?? false,
      protoText: grpcCfg.protoText || undefined,
      metadata: (grpcCfg.metadata ?? []).map((m) => ({
        key: m.key,
        value: m.value,
        enabled: m.enabled,
      })),
    }),
    formatMessage: (dir, data) => formatFrame(dir, data),
    onRawEvent: (ev) => {
      if (ev.type !== "message" || ev.dir !== "in" || !ev.data) return;
      try {
        const frame = JSON.parse(ev.data) as {
          action?: string;
          event?: string;
          result?: { services?: GrpcServiceMeta[] };
        };
        if (frame.action === "serviceList" && frame.result?.services) {
          setServices(frame.result.services);
        } else if (frame.action === "invoke" && (frame.event === "end" || frame.event === "error")) {
          setCallActive(false);
        }
      } catch {
        /* 非 JSON 忽略 */
      }
    },
  });

  const invoke = () => {
    if (!grpcCfg.service || !grpcCfg.method) {
      message.warning("请先选择 Service 和 Method");
      return;
    }
    let payload: unknown;
    const draft = (grpcCfg.payloadDraft ?? "").trim();
    if (draft) {
      try {
        payload = JSON.parse(substituteVariables(draft, conn.resolveVars()));
      } catch {
        message.error("请求消息需为合法 JSON");
        return;
      }
    }
    setCallActive(true);
    conn.sendRaw(
      JSON.stringify({ action: "invoke", service: grpcCfg.service, method: grpcCfg.method, payload }),
    );
  };

  const push = () => {
    const draft = (grpcCfg.payloadDraft ?? "").trim();
    let payload: unknown;
    if (draft) {
      try {
        payload = JSON.parse(substituteVariables(draft, conn.resolveVars()));
      } catch {
        message.error("请求消息需为合法 JSON");
        return;
      }
    }
    conn.sendRaw(JSON.stringify({ action: "push", payload }));
  };

  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[conn.connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* host:port + TLS + Connect/Disconnect */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="grpc.example.com:443"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          disabled={conn.connected || conn.connState === "connecting"}
        />
        <Checkbox
          checked={grpcCfg.tls ?? false}
          disabled={conn.connected || conn.connState === "connecting"}
          onChange={(e) => patch(tab.key, { grpc: { ...grpcCfg, tls: e.target.checked } })}
        >
          TLS
        </Checkbox>
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
                key: "invoke",
                label: "Invoke",
                children: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Space wrap>
                      <Select
                        size="small"
                        style={{ minWidth: 240 }}
                        placeholder="Service"
                        value={grpcCfg.service}
                        options={services.map((s) => ({ value: s.name, label: s.name }))}
                        onChange={(v) =>
                          patch(tab.key, { grpc: { ...grpcCfg, service: v, method: undefined } })
                        }
                        disabled={!conn.connected}
                      />
                      <Select
                        size="small"
                        style={{ minWidth: 200 }}
                        placeholder="Method"
                        value={grpcCfg.method}
                        options={(services.find((s) => s.name === grpcCfg.service)?.methods ?? []).map(
                          (m) => ({ value: m.name, label: m.name }),
                        )}
                        onChange={(v) => {
                          patch(tab.key, { grpc: { ...grpcCfg, method: v } });
                          // 有请求模板且草稿为空时自动填充
                          const m = services
                            .find((s) => s.name === grpcCfg.service)
                            ?.methods.find((x) => x.name === v);
                          if (m?.requestExample && !(grpcCfg.payloadDraft ?? "").trim()) {
                            patch(tab.key, {
                              grpc: {
                                ...grpcCfg,
                                method: v,
                                payloadDraft: JSON.stringify(m.requestExample, null, 2),
                              },
                            });
                          }
                        }}
                        disabled={!conn.connected || !grpcCfg.service}
                      />
                      {methodTypeTag(currentMethod)}
                    </Space>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Metadata（调用请求头）
                      </Typography.Text>
                      <KeyValueEditor
                        items={grpcCfg.metadata ?? []}
                        onChange={(metadata) => patch(tab.key, { grpc: { ...grpcCfg, metadata } })}
                        highlightVars
                      />
                    </div>
                  </Space>
                ),
              },
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
                key: "proto",
                label: "Proto",
                children: (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      服务器不支持 reflection 时，粘贴 .proto 文本作为服务定义（随请求配置保存）。
                    </Typography.Text>
                    <Input.TextArea
                      className="code-font"
                      style={{ flex: 1, resize: "none" }}
                      placeholder={'syntax = "proto3";\npackage echo;\nservice Echo { ... }'}
                      value={grpcCfg.protoText ?? ""}
                      onChange={(e) =>
                        patch(tab.key, { grpc: { ...grpcCfg, protoText: e.target.value } })
                      }
                    />
                  </div>
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          {/* 请求消息编辑器：unary 用 Invoke；流式方法可 Push 多条后 Half-close */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <VarTextArea
              className="code-font"
              style={{ flex: 1, resize: "none" }}
              placeholder='请求消息（JSON），支持 {{变量}}'
              value={grpcCfg.payloadDraft ?? ""}
              onChange={(text) => patch(tab.key, { grpc: { ...grpcCfg, payloadDraft: text } })}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              {currentMethod?.requestStream && (
                <>
                  <Button
                    size="small"
                    icon={<SendOutlined />}
                    disabled={!conn.connected || !callActive}
                    onClick={push}
                  >
                    Push
                  </Button>
                  <Button
                    size="small"
                    disabled={!conn.connected || !callActive}
                    onClick={() => conn.sendRaw(JSON.stringify({ action: "halfClose" }))}
                  >
                    Half-close
                  </Button>
                </>
              )}
              <Button
                type="primary"
                size="small"
                icon={<ApiOutlined />}
                disabled={!conn.connected || !grpcCfg.method || callActive}
                onClick={invoke}
              >
                Invoke
              </Button>
            </div>
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

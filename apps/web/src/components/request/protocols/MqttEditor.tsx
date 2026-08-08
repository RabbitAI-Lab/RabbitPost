import {
  ApiOutlined,
  ClearOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  PlusOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { App, Button, Checkbox, Input, Select, Space, Splitter, Tabs, Tag } from "antd";
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

/** 格式化 {topic, payload, qos, retain} 帧为时间线文本 */
function formatFrame(dir: "in" | "out", data: string): string {
  try {
    const frame = JSON.parse(data) as { topic?: string; payload?: string; retain?: boolean };
    const retain = frame.retain ? " [retain]" : "";
    return `${dir === "in" ? "←" : "→"} ${frame.topic ?? "?"}${retain}  ${frame.payload ?? ""}`;
  } catch {
    return data;
  }
}

const QOS_OPTIONS = [
  { value: 0, label: "QoS 0" },
  { value: 1, label: "QoS 1" },
  { value: 2, label: "QoS 2" },
];

/**
 * MQTT 协议编辑器（参考 Postman / MQTTX）：
 * - URL 为 broker 地址（mqtt:// mqtts:// ws:// wss://），经 Runner 连接（api 实时桥）
 * - Subscriptions 管理订阅列表；连接后需点订阅生效（与 MQTTX 一致）
 * - 底部发布编辑器：topic + payload + QoS + retain
 */
export default function MqttEditor({ tab }: Props) {
  const { message } = App.useApp();
  const updateConfig = useTabsStore((s) => s.updateConfig);
  const patch = updateConfig;

  const mqttCfg = tab.config.mqtt ?? {};
  const subscriptions = mqttCfg.subscriptions ?? [];
  const [newTopic, setNewTopic] = useState("");

  const conn = useRtConnection({
    tab,
    protocol: "mqtt",
    resolveUrl: (raw, vars) => {
      const url = substituteVariables(raw, vars).trim();
      return /^(mqtts?|wss?):\/\//i.test(url) ? url : null;
    },
    buildConfig: (vars) => ({
      clientId: mqttCfg.clientId || undefined,
      username: mqttCfg.username
        ? substituteVariables(mqttCfg.username, vars)
        : undefined,
      password: mqttCfg.password
        ? substituteVariables(mqttCfg.password, vars)
        : undefined,
      clean: mqttCfg.clean !== false,
      keepAlive: mqttCfg.keepAlive || undefined,
      willTopic: mqttCfg.willTopic || undefined,
      willPayload: mqttCfg.willPayload
        ? substituteVariables(mqttCfg.willPayload, vars)
        : undefined,
      willQos: mqttCfg.willQos,
      willRetain: mqttCfg.willRetain,
    }),
    formatMessage: (dir, data) => formatFrame(dir, data),
  });

  const handlePublish = () => {
    const topic = (mqttCfg.publishTopicDraft ?? "").trim();
    if (!topic) {
      message.warning("请输入发布 Topic");
      return;
    }
    conn.sendRaw(
      JSON.stringify({
        action: "publish",
        topic,
        payload: substituteVariables(mqttCfg.payloadDraft ?? "", conn.resolveVars()),
        qos: mqttCfg.qosDraft ?? 0,
        retain: mqttCfg.retainDraft ?? false,
      }),
    );
  };

  const subscribe = (topic: string, qos: 0 | 1 | 2) => {
    conn.sendRaw(JSON.stringify({ action: "subscribe", topic, qos }));
  };

  const unsubscribe = (topic: string) => {
    conn.sendRaw(JSON.stringify({ action: "unsubscribe", topic }));
  };

  const addSubscription = () => {
    const topic = newTopic.trim();
    if (!topic) return;
    if (subscriptions.some((s) => s.topic === topic)) {
      message.info("该 Topic 已在列表中");
      return;
    }
    patch(tab.key, { mqtt: { ...mqttCfg, subscriptions: [...subscriptions, { topic, qos: 0 }] } });
    setNewTopic("");
    if (conn.connected) subscribe(topic, 0);
  };

  const stateTag = {
    idle: <Tag>未连接</Tag>,
    connecting: <Tag color="processing">连接中…</Tag>,
    open: <Tag color="success">已连接</Tag>,
    closed: <Tag color="default">已断开</Tag>,
  }[conn.connState];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Broker URL + Connect/Disconnect */}
      <div style={{ display: "flex", gap: 8, width: "100%", marginBottom: 8 }}>
        <VarInput
          className="code-font"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="mqtt://broker.example.com:1883"
          value={tab.config.url}
          onChange={(url) => patch(tab.key, { url })}
          disabled={conn.connected || conn.connState === "connecting"}
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
                key: "subscriptions",
                label: `Subscriptions${subscriptions.length ? ` (${subscriptions.length})` : ""}`,
                children: (
                  <div style={{ maxWidth: 720 }}>
                    {/* 新增订阅：连接状态下立即生效，未连接则先存列表 */}
                    <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
                      <Input
                        size="small"
                        placeholder="topic/filter（支持 + / # 通配符）"
                        value={newTopic}
                        onChange={(e) => setNewTopic(e.target.value)}
                        onPressEnter={addSubscription}
                      />
                      <Button size="small" icon={<PlusOutlined />} onClick={addSubscription}>
                        添加
                      </Button>
                    </Space.Compact>
                    {subscriptions.map((s) => (
                      <div
                        key={s.topic}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 0",
                          borderBottom: "1px solid #f5f5f5",
                        }}
                      >
                        <span className="code-font" style={{ flex: 1, fontSize: 12 }}>
                          {s.topic}
                        </span>
                        <Select
                          size="small"
                          style={{ width: 90 }}
                          value={s.qos}
                          options={QOS_OPTIONS}
                          onChange={(qos) =>
                            patch(tab.key, {
                              mqtt: {
                                ...mqttCfg,
                                subscriptions: subscriptions.map((x) =>
                                  x.topic === s.topic ? { ...x, qos: qos as 0 | 1 | 2 } : x,
                                ),
                              },
                            })
                          }
                        />
                        <Button
                          size="small"
                          type="link"
                          disabled={!conn.connected}
                          onClick={() => subscribe(s.topic, s.qos)}
                        >
                          订阅
                        </Button>
                        <Button
                          size="small"
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            if (conn.connected) unsubscribe(s.topic);
                            patch(tab.key, {
                              mqtt: {
                                ...mqttCfg,
                                subscriptions: subscriptions.filter((x) => x.topic !== s.topic),
                              },
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                key: "settings",
                label: "Settings",
                children: (
                  <Space direction="vertical" style={{ width: 480 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>Client ID（留空自动生成）</div>
                      <Input
                        size="small"
                        value={mqttCfg.clientId ?? ""}
                        onChange={(e) =>
                          patch(tab.key, { mqtt: { ...mqttCfg, clientId: e.target.value } })
                        }
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>Username</div>
                      <Input
                        size="small"
                        value={mqttCfg.username ?? ""}
                        onChange={(e) =>
                          patch(tab.key, { mqtt: { ...mqttCfg, username: e.target.value } })
                        }
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>Password</div>
                      <Input.Password
                        size="small"
                        value={mqttCfg.password ?? ""}
                        onChange={(e) =>
                          patch(tab.key, { mqtt: { ...mqttCfg, password: e.target.value } })
                        }
                      />
                    </div>
                    <Checkbox
                      checked={mqttCfg.clean !== false}
                      onChange={(e) =>
                        patch(tab.key, { mqtt: { ...mqttCfg, clean: e.target.checked } })
                      }
                    >
                      Clean Session
                    </Checkbox>
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>
                        Keep Alive（秒，默认 60）
                      </div>
                      <Input
                        size="small"
                        type="number"
                        min={0}
                        value={mqttCfg.keepAlive ?? ""}
                        onChange={(e) =>
                          patch(tab.key, {
                            mqtt: {
                              ...mqttCfg,
                              keepAlive: e.target.value ? Number(e.target.value) : undefined,
                            },
                          })
                        }
                      />
                    </div>
                    {/* 遗嘱消息：异常断开时由 broker 代为发布 */}
                    <div>
                      <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 4 }}>
                        遗嘱消息（Last Will，留空不启用）
                      </div>
                      <Space direction="vertical" style={{ width: "100%" }}>
                        <Input
                          size="small"
                          placeholder="Will Topic"
                          value={mqttCfg.willTopic ?? ""}
                          onChange={(e) =>
                            patch(tab.key, { mqtt: { ...mqttCfg, willTopic: e.target.value } })
                          }
                        />
                        <Input
                          size="small"
                          placeholder="Will Payload"
                          value={mqttCfg.willPayload ?? ""}
                          onChange={(e) =>
                            patch(tab.key, { mqtt: { ...mqttCfg, willPayload: e.target.value } })
                          }
                        />
                        <Space>
                          <Select
                            size="small"
                            style={{ width: 90 }}
                            value={mqttCfg.willQos ?? 0}
                            options={QOS_OPTIONS}
                            onChange={(v) =>
                              patch(tab.key, { mqtt: { ...mqttCfg, willQos: v as 0 | 1 | 2 } })
                            }
                          />
                          <Checkbox
                            checked={mqttCfg.willRetain ?? false}
                            onChange={(e) =>
                              patch(tab.key, { mqtt: { ...mqttCfg, willRetain: e.target.checked } })
                            }
                          >
                            Retain
                          </Checkbox>
                        </Space>
                      </Space>
                    </div>
                  </Space>
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="15%" style={{ paddingTop: 4 }}>
          {/* 发布编辑器 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                size="small"
                placeholder="发布 Topic"
                style={{ flex: 1 }}
                value={mqttCfg.publishTopicDraft ?? ""}
                onChange={(e) =>
                  patch(tab.key, { mqtt: { ...mqttCfg, publishTopicDraft: e.target.value } })
                }
              />
              <Select
                size="small"
                style={{ width: 90 }}
                value={mqttCfg.qosDraft ?? 0}
                options={QOS_OPTIONS}
                onChange={(v) => patch(tab.key, { mqtt: { ...mqttCfg, qosDraft: v as 0 | 1 | 2 } })}
              />
              <Checkbox
                checked={mqttCfg.retainDraft ?? false}
                onChange={(e) =>
                  patch(tab.key, { mqtt: { ...mqttCfg, retainDraft: e.target.checked } })
                }
              >
                Retain
              </Checkbox>
            </div>
            <VarTextArea
              className="code-font"
              style={{ flex: 1, resize: "none" }}
              placeholder="Payload，支持 {{变量}}"
              value={mqttCfg.payloadDraft ?? ""}
              onChange={(text) => patch(tab.key, { mqtt: { ...mqttCfg, payloadDraft: text } })}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!conn.connected || !(mqttCfg.publishTopicDraft ?? "").trim()}
                onClick={handlePublish}
              >
                Publish
              </Button>
            </div>
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

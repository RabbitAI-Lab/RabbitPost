import {
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import type { Runner } from "@rabbitpost/shared";
import { runnersApi } from "../../api";
import { useAppStore } from "../../stores/app";
import CommandBlock from "./CommandBlock";
import DispatchRunModal from "./DispatchRunModal";
import RunHistoryTable from "./RunHistoryTable";

const { Paragraph, Text } = Typography;

/** 心跳在该时长内视为在线 */
const ONLINE_WINDOW_MS = 60_000;

/** 内嵌 Runner 的保留名（随 API 服务自动启停，不可手动管理） */
const EMBEDDED_RUNNER_NAME = "__embedded__";
/** 是否为内嵌 Runner：其生命周期由 API 服务托管，Token / 启停 / 删除均无意义 */
const isEmbedded = (r: Runner): boolean => r.name === EMBEDDED_RUNNER_NAME;

function isOnline(runner: Runner): boolean {
  if (!runner.lastSeenAt) return false;
  return Date.now() - new Date(runner.lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

/** Runner CLI 启动命令；Token 未知时用占位符，注册/重置后可带上真实 Token */
function startCommand(server: string, token: string): string {
  return `rabbitpost-runner serve --server ${server} --token ${token} --concurrency 8`;
}

/** Runner 管理：注册 Runner、维护 Token、派发任务与查看执行结果 */
export default function RunnerAdminPanel() {
  const { message } = App.useApp();
  const currentTeamId = useAppStore((s) => s.currentTeamId);

  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [form] = Form.useForm<{ name: string; description?: string }>();
  /** 明文 Token 只在注册 / 重置后拿到一次，展示于引导弹窗 */
  const [issued, setIssued] = useState<{ runner: Runner; token: string } | null>(null);
  const [guideRunner, setGuideRunner] = useState<Runner | null>(null);
  const [dispatchRunner, setDispatchRunner] = useState<Runner | null>(null);
  const [runsRefreshKey, setRunsRefreshKey] = useState(0);

  const server = window.location.origin;

  const load = useCallback(async () => {
    if (!currentTeamId) return;
    setLoading(true);
    try {
      setRunners(await runnersApi.list(currentTeamId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [currentTeamId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRegister = async () => {
    if (!currentTeamId) return;
    const values = await form.validateFields();
    setRegistering(true);
    try {
      const result = await runnersApi.register(currentTeamId, values);
      setRegisterOpen(false);
      form.resetFields();
      await load();
      setIssued(result);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRegistering(false);
    }
  };

  const handleRegenerate = async (runner: Runner) => {
    try {
      const result = await runnersApi.regenerateToken(runner.id);
      await load();
      setIssued(result);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleStatus = async (runner: Runner) => {
    const status = runner.status === "active" ? "disabled" : "active";
    try {
      await runnersApi.update(runner.id, { status });
      await load();
      message.success(status === "active" ? "已启用" : "已停用");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemove = async (runner: Runner) => {
    try {
      await runnersApi.remove(runner.id);
      await load();
      message.success("Runner 已删除");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Text strong style={{ flex: 1 }}>
          已注册 Runner
        </Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          disabled={!currentTeamId}
          onClick={() => setRegisterOpen(true)}
        >
          注册 Runner
        </Button>
      </div>

      <Table<Runner>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={runners}
        pagination={false}
        columns={[
          {
            title: "名称",
            dataIndex: "name",
            render: (name: string, row) => (
              <span>
                {name}
                {isEmbedded(row) && (
                  <Tag
                    color="orange"
                    style={{ marginLeft: 6, fontSize: 11, lineHeight: "16px" }}
                  >
                    内置
                  </Tag>
                )}
                {row.description && (
                  <>
                    <br />
                    <span style={{ color: "#999", fontSize: 12 }}>{row.description}</span>
                  </>
                )}
              </span>
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 110,
            render: (_: unknown, row) =>
              row.status === "disabled" ? (
                <Tag>已停用</Tag>
              ) : isOnline(row) ? (
                <Tag color="green">在线</Tag>
              ) : (
                <Tag color="default">离线</Tag>
              ),
          },
          {
            title: "Token",
            dataIndex: "tokenPrefix",
            width: 160,
            render: (prefix: string) => (
              <Text code style={{ fontSize: 12 }}>
                {prefix}…
              </Text>
            ),
          },
          {
            title: "版本 / 平台",
            width: 180,
            render: (_: unknown, row) => (
              <span style={{ fontSize: 12, color: "#666" }}>
                {row.version ?? "-"}
                {row.platform ? ` · ${row.platform}` : ""}
              </span>
            ),
          },
          {
            title: "最近心跳",
            dataIndex: "lastSeenAt",
            width: 160,
            render: (lastSeenAt: string | null) => (
              <span style={{ fontSize: 12, color: "#666" }}>
                {lastSeenAt ? dayjs(lastSeenAt).format("MM-DD HH:mm:ss") : "从未连接"}
              </span>
            ),
          },
          {
            title: "操作",
            width: 300,
            render: (_: unknown, row) => {
              // 内嵌 Runner 随 API 服务自动启停，所有管理操作均无意义：
              // - Token 由服务启动时自动签发，重置会令进程失联
              // - 启停 / 删除会破坏任务派发链路
              // - 引导启动命令对外部 Runner 有意义，对内置 Runner 无意义
              if (isEmbedded(row)) {
                return (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    随服务自动管理
                  </Text>
                );
              }
              return (
                <Space size={0}>
                  <Tooltip title="查看启动命令">
                    <Button
                      type="link"
                      size="small"
                      icon={<RocketOutlined />}
                      onClick={() => setGuideRunner(row)}
                    >
                      引导
                    </Button>
                  </Tooltip>
                  <Button
                    type="link"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    disabled={row.status !== "active"}
                    onClick={() => setDispatchRunner(row)}
                  >
                    派发任务
                  </Button>
                  <Popconfirm
                    title="重新生成 Token？"
                    description="旧 Token 立即失效，正在运行的 Runner 需要用新 Token 重启。"
                    okText="生成"
                    cancelText="取消"
                    onConfirm={() => void handleRegenerate(row)}
                  >
                    <Tooltip title="重新生成 Token">
                      <Button type="link" size="small" icon={<SyncOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                  <Tooltip title={row.status === "active" ? "停用" : "启用"}>
                    <Button
                      type="link"
                      size="small"
                      icon={
                        row.status === "active" ? (
                          <PauseCircleOutlined />
                        ) : (
                          <PlayCircleOutlined />
                        )
                      }
                      onClick={() => void handleToggleStatus(row)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="删除该 Runner？"
                    description="删除后其 Token 立即失效。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void handleRemove(row)}
                  >
                    <Tooltip title="删除">
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />

      <div style={{ marginTop: 24 }}>
        <Text strong>执行任务</Text>
        <div style={{ marginTop: 12 }}>
          <RunHistoryTable refreshKey={runsRefreshKey} />
        </div>
      </div>

      {/* 注册 */}
      <Modal
        title="注册 Runner"
        open={registerOpen}
        onOk={() => void handleRegister()}
        onCancel={() => setRegisterOpen(false)}
        confirmLoading={registering}
        okText="注册并生成 Token"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="Runner 名称"
            rules={[{ required: true, message: "请输入 Runner 名称" }]}
          >
            <Input maxLength={64} placeholder="例如：ci-runner-01" />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <Input maxLength={256} placeholder="例如：部署在深圳机房的构建机" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新 Token + 启动引导（Token 仅此一次可见） */}
      <Modal
        title={`Runner Token · ${issued?.runner.name ?? ""}`}
        open={!!issued}
        onCancel={() => setIssued(null)}
        footer={
          <Button type="primary" onClick={() => setIssued(null)}>
            我已保存
          </Button>
        }
        width={720}
        destroyOnHidden
      >
        <Paragraph type="danger" style={{ marginBottom: 8 }}>
          Token 仅显示这一次，关闭后无法再查看；丢失后请重新生成。
        </Paragraph>
        <CommandBlock command={issued?.token ?? ""} />
        <Paragraph strong style={{ marginTop: 16, marginBottom: 8 }}>
          在目标机器上启动 Runner：
        </Paragraph>
        <CommandBlock command={startCommand(server, issued?.token ?? "")} />
      </Modal>

      {/* 启动引导（不含 Token） */}
      <Modal
        title={`启动 Runner · ${guideRunner?.name ?? ""}`}
        open={!!guideRunner}
        onCancel={() => setGuideRunner(null)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          完整安装步骤见「Runner CLI」标签页；已安装好可直接用下面的命令启动。
        </Paragraph>
        <CommandBlock command={startCommand(server, "<RUNNER_TOKEN>")} />
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          也可用环境变量代替参数：RABBITPOST_SERVER、RABBITPOST_RUNNER_TOKEN。
          Token 不可回看，如已丢失请用「重新生成 Token」。
        </Paragraph>
      </Modal>

      <DispatchRunModal
        runner={dispatchRunner}
        onClose={() => setDispatchRunner(null)}
        onDispatched={() => {
          setDispatchRunner(null);
          setRunsRefreshKey((k) => k + 1);
        }}
      />
    </div>
  );
}

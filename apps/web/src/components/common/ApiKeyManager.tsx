import { CopyOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Input,
  Modal,
  Popconfirm,
  Table,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import type { ApiKey } from "@rabbitpost/shared";
import { apiKeysApi } from "../../api";

const { Paragraph, Text } = Typography;

interface Props {
  /** 是否显示顶部说明文案（CLI 面板已自带上下文时可关闭） */
  showHint?: boolean;
}

/** API Key 管理：明文 Token 仅创建时展示一次，列表只显示前缀。
 *  个人中心与 RabbitPost CLI 面板共用。 */
export default function ApiKeyManager({ showHint = true }: Props) {
  const { message } = App.useApp();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await apiKeysApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }, [message]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { token } = await apiKeysApi.create(trimmed);
      setIssuedToken(token);
      setName("");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (keyId: string) => {
    try {
      await apiKeysApi.remove(keyId);
      await load();
      message.success("API Key 已吊销");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    message.success("已复制");
  };

  return (
    <>
      {showHint && (
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          API Key 供 rabbitpost CLI 与脚本以{" "}
          <Text code>Authorization: Bearer rpk_...</Text> 访问管理接口，权限与账号一致；
          明文只展示一次，请立即保存。
        </Paragraph>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setCreating(true)}
        >
          New API Key
        </Button>
      </div>
      <Table<ApiKey>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={keys}
        pagination={false}
        locale={{ emptyText: "还没有 API Key，点右上角创建一个" }}
        columns={[
          { title: "名称", dataIndex: "name" },
          {
            title: "前缀",
            dataIndex: "keyPrefix",
            width: 150,
            render: (prefix: string) => <Text code>{prefix}…</Text>,
          },
          {
            title: "最近使用",
            dataIndex: "lastUsedAt",
            width: 140,
            render: (lastUsedAt: string | null) =>
              lastUsedAt ? dayjs(lastUsedAt).format("MM-DD HH:mm") : "从未使用",
          },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 140,
            render: (createdAt: string) => dayjs(createdAt).format("MM-DD HH:mm"),
          },
          {
            title: "操作",
            width: 80,
            render: (_: unknown, row) => (
              <Popconfirm
                title="吊销该 API Key？使用它的 CLI 将立即失效"
                okText="吊销"
                cancelText="取消"
                onConfirm={() => void revoke(row.id)}
              >
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal
        title="New API Key"
        open={creating}
        onCancel={() => {
          setCreating(false);
          setIssuedToken(null);
          setName("");
        }}
        footer={
          issuedToken ? (
            <Button
              type="primary"
              onClick={() => {
                setCreating(false);
                setIssuedToken(null);
                setName("");
              }}
            >
              我已保存
            </Button>
          ) : (
            <Button type="primary" disabled={!name.trim()} onClick={() => void create()}>
              创建
            </Button>
          )
        }
      >
        {issuedToken ? (
          <Alert
            type="warning"
            showIcon
            message="请立即复制保存，关闭后将无法再次查看"
            description={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Text code style={{ userSelect: "all" }}>
                  {issuedToken}
                </Text>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copy(issuedToken)}
                />
              </span>
            }
          />
        ) : (
          <Input
            placeholder="名称，例如 CI / 本机 / AI Agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={() => void create()}
            autoFocus
          />
        )}
      </Modal>
    </>
  );
}

import {
  App,
  Form,
  InputNumber,
  Modal,
  Radio,
  Select,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import type { CollectionItem, Runner, RunTargetType } from "@rabbitpost/shared";
import { runsApi } from "../../api";
import { useAppStore } from "../../stores/app";

const { Text } = Typography;

interface Props {
  runner: Runner | null;
  onClose: () => void;
  onDispatched: () => void;
}

/** 把 Collection 树展平为「文件夹 / 请求名」的请求列表，供单请求派发时选择 */
function flattenRequests(
  nodes: CollectionItem[],
  prefix = "",
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const node of nodes) {
    if (node.type === "folder") {
      out.push(...flattenRequests(node.children ?? [], `${prefix}${node.name} / `));
    } else {
      out.push({ id: node.id, label: `${prefix}${node.name}` });
    }
  }
  return out;
}

/**
 * 派发执行任务：目标限定在当前 Workspace（Collection 树已在本地加载），
 * 环境与并发数随任务下发给 Runner。
 */
export default function DispatchRunModal({ runner, onClose, onDispatched }: Props) {
  const { message } = App.useApp();
  const {
    currentTeamId,
    workspaces,
    currentWorkspaceId,
    collections,
    collectionTrees,
    environments,
    activeEnvironmentId,
  } = useAppStore();

  const [targetType, setTargetType] = useState<RunTargetType>("collection");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(4);
  const [submitting, setSubmitting] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // 每次打开重置为当前上下文的默认值
  useEffect(() => {
    if (!runner) return;
    setTargetType("collection");
    setCollectionId(collections[0]?.id ?? null);
    setItemId(null);
    setEnvironmentId(activeEnvironmentId);
    setConcurrency(4);
  }, [runner, collections, activeEnvironmentId]);

  const requests = collectionId
    ? flattenRequests(collectionTrees[collectionId] ?? [])
    : [];

  const handleOk = async () => {
    if (!currentTeamId || !currentWorkspaceId || !runner) return;
    const targetId = targetType === "collection" ? collectionId : itemId;
    if (!targetId) {
      message.error(targetType === "collection" ? "请选择 Collection" : "请选择请求");
      return;
    }
    setSubmitting(true);
    try {
      await runsApi.dispatch(currentTeamId, {
        workspaceId: currentWorkspaceId,
        runnerId: runner.id,
        targetType,
        targetId,
        environmentId,
        concurrency,
      });
      message.success("任务已派发，等待 Runner 领取");
      onDispatched();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`派发任务 · ${runner?.name ?? ""}`}
      open={!!runner}
      onOk={() => void handleOk()}
      onCancel={onClose}
      confirmLoading={submitting}
      okText="派发"
      cancelText="取消"
      destroyOnHidden
    >
      <Form layout="vertical">
        <Form.Item label="Workspace">
          <Text>{workspace?.name ?? "未选择 Workspace"}</Text>
        </Form.Item>
        <Form.Item label="目标类型">
          <Radio.Group
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as RunTargetType)}
            options={[
              { value: "collection", label: "整个 Collection" },
              { value: "request", label: "单个请求" },
            ]}
          />
        </Form.Item>
        <Form.Item label="Collection">
          <Select
            value={collectionId}
            placeholder="选择 Collection"
            onChange={(v) => {
              setCollectionId(v);
              setItemId(null);
            }}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Form.Item>
        {targetType === "request" && (
          <Form.Item label="请求">
            <Select
              value={itemId}
              placeholder="选择请求"
              showSearch
              optionFilterProp="label"
              onChange={setItemId}
              options={requests.map((r) => ({ value: r.id, label: r.label }))}
            />
          </Form.Item>
        )}
        <Form.Item label="环境">
          <Select
            value={environmentId}
            placeholder="不使用环境"
            allowClear
            onChange={(v) => setEnvironmentId(v ?? null)}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
          />
        </Form.Item>
        <Form.Item label="并发数" extra="Runner 侧同时发送的请求数上限">
          <InputNumber
            min={1}
            max={64}
            value={concurrency}
            onChange={(v) => setConcurrency(v ?? 1)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

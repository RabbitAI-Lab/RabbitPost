import {
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  FileTextOutlined,
  MoreOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { App, Button, Dropdown, Empty, Input, Modal, Typography } from "antd";
import { useMemo, useState } from "react";
import type { Spec } from "@rabbitpost/shared";
import {
  SPEC_FORMAT_LABELS,
  SPEC_TYPE_LABELS,
  validateSpec,
} from "@rabbitpost/shared";
import { specsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import NewSpecModal from "./NewSpecModal";

/** 每个 spec 的错误 / 警告数量，用于列表右侧的状态指示 */
function useIssueCounts(specs: Spec[]) {
  return useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    for (const spec of specs) {
      const issues = validateSpec(spec.content, spec.type);
      map.set(spec.id, {
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
      });
    }
    return map;
  }, [specs]);
}

/** 侧栏 SPECS 面板：workspace 下的 API 定义列表（对齐 Postman 的 Specs 列表） */
export default function SpecsPanel() {
  const { message } = App.useApp();
  const { currentWorkspaceId, specs, refreshSpecs, refreshCollections } = useAppStore();
  const openSpec = useTabsStore((s) => s.openSpec);
  const renameTab = useTabsStore((s) => s.renameTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const [newOpen, setNewOpen] = useState(false);
  const issueCounts = useIssueCounts(specs);

  const handleRename = (spec: Spec) => {
    let name = spec.name;
    Modal.confirm({
      title: "重命名 Spec",
      content: (
        <Input defaultValue={spec.name} onChange={(e) => (name = e.target.value)} />
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: async () => {
        const next = name.trim();
        if (!next) return;
        await specsApi.update(spec.id, { name: next });
        await refreshSpecs();
        renameTab(`spec-${spec.id}`, next);
      },
    });
  };

  const handleGenerate = async (spec: Spec) => {
    const result = await specsApi.generateCollection(spec.id, {
      replaceLinked: !!spec.generatedCollectionId,
    });
    await Promise.all([refreshCollections(), refreshSpecs()]);
    message.success(
      `${result.reused ? "已更新" : "已生成"} Collection（${result.requestCount} 个请求）`,
    );
  };

  const handleDelete = (spec: Spec) => {
    Modal.confirm({
      title: "删除 Spec",
      content: `确定删除「${spec.name}」吗？由它生成的 Collection 不会被删除。`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await specsApi.remove(spec.id);
        closeTab(`spec-${spec.id}`);
        await refreshSpecs();
        message.success("已删除");
      },
    });
  };

  const menu = (spec: Spec) => ({
    items: [
      {
        key: "generate",
        icon: <ThunderboltOutlined />,
        label: spec.generatedCollectionId ? "更新已关联的 Collection" : "生成 Collection",
        onClick: () => void handleGenerate(spec),
      },
      {
        key: "rename",
        icon: <EditOutlined />,
        label: "重命名",
        onClick: () => handleRename(spec),
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: "删除",
        danger: true,
        onClick: () => handleDelete(spec),
      },
    ],
  });

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "8px 8px 0",
      }}
    >
      <Button
        size="small"
        type="primary"
        ghost
        icon={<PlusOutlined />}
        block
        disabled={!currentWorkspaceId}
        onClick={() => setNewOpen(true)}
        style={{ marginBottom: 8, flexShrink: 0 }}
      >
        新建 Spec
      </Button>

      <div
        className="slim-scroll"
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 8 }}
      >
        {specs.length === 0 ? (
          <Empty description="还没有 Spec" style={{ marginTop: 24 }} />
        ) : (
          specs.map((spec) => {
            const counts = issueCounts.get(spec.id);
            return (
              <div
                key={spec.id}
                className="sidebar-hover"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  padding: "7px 4px",
                  borderRadius: 4,
                  borderBottom: "1px solid #f5f5f5",
                }}
                onClick={() => openSpec(spec)}
              >
                <FileTextOutlined style={{ color: "#8c8c8c", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text ellipsis style={{ fontSize: 12, display: "block" }}>
                    {spec.name}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {SPEC_TYPE_LABELS[spec.type]} · {SPEC_FORMAT_LABELS[spec.format]}
                  </Typography.Text>
                </div>
                {/* 校验状态：有错误显示红色计数，仅有警告显示黄色计数 */}
                {counts && counts.errors > 0 ? (
                  <span
                    style={{ fontSize: 11, color: "#ff4d4f", flexShrink: 0 }}
                    title={`${counts.errors} 个错误`}
                  >
                    <ExclamationCircleFilled /> {counts.errors}
                  </span>
                ) : counts && counts.warnings > 0 ? (
                  <span
                    style={{ fontSize: 11, color: "#faad14", flexShrink: 0 }}
                    title={`${counts.warnings} 个警告`}
                  >
                    <WarningFilled /> {counts.warnings}
                  </span>
                ) : null}
                <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                  <Dropdown menu={menu(spec)} trigger={["click"]}>
                    <Button type="text" size="small" icon={<MoreOutlined />} />
                  </Dropdown>
                </span>
              </div>
            );
          })
        )}
      </div>

      <NewSpecModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

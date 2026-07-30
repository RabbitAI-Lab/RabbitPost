import {
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { App, Button, Segmented, Typography } from "antd";
import { useState } from "react";
import { documentsApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { findFolderTrail } from "../../lib/tree";
import { useAppStore } from "../../stores/app";
import { isTabDirty, useTabsStore, type DocumentTab } from "../../stores/tabs";
import MarkdownEditor from "../common/MarkdownEditor";

interface Props {
  tab: DocumentTab;
}

/** Document 详情页：第一行路径面包屑 + 编辑/预览切换与保存，下方 Markdown 编辑器 */
export default function DocumentEditor({ tab }: Props) {
  const { message } = App.useApp();
  const documentTree = useAppStore((s) => s.documentTree);
  const refreshDocuments = useAppStore((s) => s.refreshDocuments);
  const { updateDocDescription, markDocSaved, setSaving } = useTabsStore();
  // 编辑 / 预览模式；默认编辑
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const dirty = isTabDirty(tab);

  // 路径面包屑：祖先目录链；末段为当前文档名（加粗）
  const pathSegments = findFolderTrail(documentTree, tab.documentId) ?? [];

  const handleSave = async () => {
    setSaving(tab.key, true);
    try {
      await documentsApi.updateItem(tab.documentId, { content: tab.description });
      await refreshDocuments();
      markDocSaved(tab.key);
      message.success("已保存");
    } finally {
      setSaving(tab.key, false);
    }
  };

  // Cmd/Ctrl+S 触发保存；与 Save 按钮同样的禁用条件
  useTabSaveHandler(tab.key, () => {
    if (tab.saving || !dirty) return;
    void handleSave();
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 第一行：文档路径面包屑 + 编辑/预览切换与 Save */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px",
          minWidth: 0,
        }}
      >
        <FileTextOutlined style={{ fontSize: 16, color: "#8c8c8c", flexShrink: 0 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flex: 1,
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
                style={{ fontSize: 13, whiteSpace: "nowrap" }}
                ellipsis
              >
                {seg}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {">"}
              </Typography.Text>
            </span>
          ))}
          <Typography.Text strong ellipsis style={{ fontSize: 15, whiteSpace: "nowrap" }}>
            {tab.name}
          </Typography.Text>
        </span>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as "edit" | "preview")}
          options={[
            { value: "edit", label: "编辑", icon: <EditOutlined /> },
            { value: "preview", label: "预览", icon: <EyeOutlined /> },
          ]}
        />
        <Button
          size="small"
          icon={<SaveOutlined />}
          loading={tab.saving}
          disabled={!dirty}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </div>

      {/* 正文：Markdown 编辑器撑满剩余高度 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <MarkdownEditor
          initialValue={tab.description}
          mode={mode}
          onChange={(md) => updateDocDescription(tab.key, md)}
        />
      </div>
    </div>
  );
}

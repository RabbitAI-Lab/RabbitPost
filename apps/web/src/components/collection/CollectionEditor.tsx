import { EditOutlined, EyeOutlined, FolderOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Empty, Segmented, Tabs, Typography } from "antd";
import { useState } from "react";
import { collectionsApi } from "../../api";
import { useTabSaveHandler } from "../../lib/save-shortcut";
import { findFolderTrail, isInScenarioTree } from "../../lib/tree";
import { useAppStore } from "../../stores/app";
import {
  isTabDirty,
  useTabsStore,
  type CollectionTab,
  type FolderTab,
} from "../../stores/tabs";
import MarkdownEditor from "../common/MarkdownEditor";
import CollectionRunsPanel from "./CollectionRunsPanel";
import CollectionVariablesPanel from "./CollectionVariablesPanel";

interface Props {
  tab: CollectionTab | FolderTab;
}

/** 暂未实现的 tab 占位 */
function ComingSoon({ label }: { label: string }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`${label} 暂未支持`}
      />
    </div>
  );
}

/** Collection / 文件夹详情页：第一行名称（文件夹为路径面包屑），第二行 tab 标签页 */
export default function CollectionEditor({ tab }: Props) {
  const { message } = App.useApp();
  const { collections, collectionTrees, refreshCollections, refreshCollectionTree } =
    useAppStore();
  const { updateDocDescription, updateCollectionVariables, markDocSaved, setSaving } =
    useTabsStore();
  // Overview 编辑 / 预览模式；默认编辑
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  // 当前激活的 tab（Save 按钮与编辑/预览切换仅 Overview 需要）
  const [activeKey, setActiveKey] = useState("overview");
  const dirty = isTabDirty(tab);
  // 场景测试目录（及其子目录）下的文件夹只保留 Overview
  const isScenarioFolder =
    tab.kind === "folder" &&
    isInScenarioTree(collectionTrees[tab.collectionId] ?? [], tab.itemId);

  // 路径面包屑：Collection 名 > 祖先文件夹链；末段为当前名称（加粗）
  const collectionName =
    collections.find((c) => c.id === tab.collectionId)?.name ?? "";
  const pathSegments =
    tab.kind === "folder"
      ? [
          ...(collectionName ? [collectionName] : []),
          ...(findFolderTrail(collectionTrees[tab.collectionId] ?? [], tab.itemId) ??
            []),
        ]
      : [];

  const handleSave = async () => {
    setSaving(tab.key, true);
    try {
      if (tab.kind === "collection") {
        await collectionsApi.update(tab.collectionId, {
          description: tab.description,
          variables: tab.variables,
        });
        await refreshCollections();
      } else {
        await collectionsApi.updateItem(tab.itemId, {
          description: tab.description,
        });
        await refreshCollectionTree(tab.collectionId);
      }
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
      {/* 第一行：Collection 名称 / 文件夹路径面包屑 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px 4px",
          minWidth: 0,
        }}
      >
        <FolderOutlined style={{ fontSize: 16, color: "#8c8c8c", flexShrink: 0 }} />
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
      </div>

      {/* 第二行：tab 标签页 */}
      <Tabs
        size="small"
        className="collection-editor-tabs"
        style={{ flex: 1, minHeight: 0 }}
        activeKey={activeKey}
        onChange={setActiveKey}
        tabBarExtraContent={{
          // 编辑/预览与保存仅服务 Overview / Variables；其它 tab 不展示
          right:
            activeKey === "overview" || activeKey === "variables" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {activeKey === "overview" ? (
                  <Segmented
                    size="small"
                    value={mode}
                    onChange={(v) => setMode(v as "edit" | "preview")}
                    options={[
                      { value: "edit", label: "编辑", icon: <EditOutlined /> },
                      { value: "preview", label: "预览", icon: <EyeOutlined /> },
                    ]}
                  />
                ) : null}
                <Button
                  size="small"
                  icon={<SaveOutlined />}
                  loading={tab.saving}
                  disabled={!dirty}
                  onClick={() => void handleSave()}
                >
                  Save
                </Button>
              </span>
            ) : null,
        }}
        items={[
          {
            key: "overview",
            label: "Overview",
            children: (
              <MarkdownEditor
                initialValue={tab.description}
                mode={mode}
                onChange={(md) => updateDocDescription(tab.key, md)}
              />
            ),
          },
          // Authorization / Scripts 为暂未支持的占位；场景测试目录下仅保留 Overview
          ...(!isScenarioFolder
            ? [
                {
                  key: "authorization",
                  label: "Authorization",
                  children: <ComingSoon label="Authorization" />,
                },
                {
                  key: "scripts",
                  label: "Scripts",
                  children: <ComingSoon label="Scripts" />,
                },
              ]
            : []),
          // Variables / Runs 仅 Collection 有
          ...(tab.kind === "collection"
            ? [
                {
                  key: "variables",
                  label: "Variables",
                  children: (
                    <CollectionVariablesPanel
                      variables={tab.variables}
                      onChange={(variables) => updateCollectionVariables(tab.key, variables)}
                    />
                  ),
                },
                {
                  key: "runs",
                  label: "Runs",
                  children: <CollectionRunsPanel collectionId={tab.collectionId} />,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

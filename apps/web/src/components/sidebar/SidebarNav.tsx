import {
  ApiOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  GlobalOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Input } from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";
import { documentsApi, environmentsApi } from "../../api";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import ChevronIcon from "../common/ChevronIcon";
import CollectionsPanel from "./CollectionsPanel";
import DocumentsPanel from "./DocumentsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import HistoryPanel from "./HistoryPanel";
import ImportCollectionModal from "./ImportCollectionModal";
import NewCollectionModal from "./NewCollectionModal";
import NewSpecModal from "./NewSpecModal";
import SpecsPanel from "./SpecsPanel";

type NavKey = "collections" | "environments" | "documents" | "specs" | "history";

const NAV_ITEMS: { key: NavKey; label: string }[] = [
  { key: "collections", label: "Collections" },
  { key: "environments", label: "Environments" },
  { key: "documents", label: "Documents" },
  { key: "specs", label: "Specs" },
  { key: "history", label: "History" },
];

// Collections / Documents 面板需要额外 prop（search / visible），在 JSX 中单独渲染
const PANELS: Partial<Record<NavKey, ReactNode>> = {
  environments: <EnvironmentsPanel />,
  specs: <SpecsPanel />,
  history: <HistoryPanel />,
};

/** 次要展开组的内容区固定高度（约 3 行数据，内部滚动） */
const SECONDARY_PANEL_HEIGHT = 180;

/**
 * Postman 风格侧栏：
 * 顶部 header（New / Import，Workspace 切换在顶部 Header 中间），
 * 下方为可折叠 group 菜单（优先级手风琴）：
 * - 顺序上第一个展开的组占满剩余空间，其后的展开组只给固定小窗（内部滚动）；
 * - 展开组之后的折叠 header 被自然挤到底部（flex 布局天然效果）。
 */
export default function SidebarNav() {
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const refreshEnvironments = useAppStore((s) => s.refreshEnvironments);
  const refreshDocuments = useAppStore((s) => s.refreshDocuments);
  const openDraft = useTabsStore((s) => s.openDraft);
  const openEnvironment = useTabsStore((s) => s.openEnvironment);
  const openDocument = useTabsStore((s) => s.openDocument);

  const [expanded, setExpanded] = useState<Record<NavKey, boolean>>({
    collections: true,
    environments: false,
    documents: false,
    specs: false,
    history: false,
  });
  const [search, setSearch] = useState("");
  const [newColOpen, setNewColOpen] = useState(false);
  const [newSpecOpen, setNewSpecOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const toggle = (key: NavKey) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  const expand = (key: NavKey) =>
    setExpanded((prev) => ({ ...prev, [key]: true }));

  // 顺序上第一个展开的组占满剩余空间
  const primaryKey = NAV_ITEMS.find((item) => expanded[item.key])?.key ?? null;

  // 新建环境：直接创建默认名称 New Environment，并在右侧打开编辑
  const handleNewEnvironment = async () => {
    if (!currentWorkspaceId) return;
    expand("environments");
    const env = await environmentsApi.create(currentWorkspaceId, "New Environment");
    await refreshEnvironments();
    openEnvironment(env);
  };

  // 新建文档：直接在根级创建默认名称 New Document，并在右侧打开编辑
  const handleNewDocument = async () => {
    if (!currentWorkspaceId) return;
    expand("documents");
    const doc = await documentsApi.createItem(currentWorkspaceId, {
      parentId: null,
      type: "document",
      name: "New Document",
    });
    await refreshDocuments();
    openDocument(doc);
  };

  const newMenu: MenuProps = {
    items: [
      {
        key: "request",
        icon: <FileAddOutlined />,
        label: "Request",
        onClick: () => openDraft(),
      },
      {
        key: "collection",
        icon: <FolderAddOutlined />,
        label: "Collection",
        disabled: !currentWorkspaceId,
        onClick: () => {
          expand("collections");
          setNewColOpen(true);
        },
      },
      {
        key: "environment",
        icon: <GlobalOutlined />,
        label: "Environment",
        disabled: !currentWorkspaceId,
        onClick: () => void handleNewEnvironment(),
      },
      {
        key: "document",
        icon: <FileTextOutlined />,
        label: "Document",
        disabled: !currentWorkspaceId,
        onClick: () => void handleNewDocument(),
      },
      {
        key: "spec",
        icon: <ApiOutlined />,
        label: "Spec",
        disabled: !currentWorkspaceId,
        onClick: () => {
          expand("specs");
          setNewSpecOpen(true);
        },
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header：搜索框 + New / Import（纯图标） */}
      <div
        style={{
          height: 40,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: "#bbb" }} />}
          placeholder="Search collections"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            // 搜索仅作用于 Collections，输入时自动展开该组
            if (e.target.value) expand("collections");
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Dropdown menu={newMenu} trigger={["click"]}>
          <Button size="small" type="primary" icon={<PlusOutlined />} title="New" />
        </Dropdown>
        <Button
          size="small"
          icon={<UploadOutlined />}
          title="Import"
          disabled={!currentWorkspaceId}
          onClick={() => setImportOpen(true)}
        />
      </div>

      {/* Body：可折叠 group 菜单 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isExpanded = expanded[item.key];
          const isPrimary = isExpanded && item.key === primaryKey;
          return (
            <div
              key={item.key}
              style={{
                display: "flex",
                flexDirection: "column",
                borderBottom: "1px solid #f0f0f0",
                // 第一个展开的组占满剩余空间，其余组按内容高度
                ...(isPrimary
                  ? { flex: 1, minHeight: 0 }
                  : { flexShrink: 0 }),
              }}
            >
              {/* Group header：无图标，大写标题 */}
              <div
                className="sidebar-hover"
                onClick={() => toggle(item.key)}
                style={{
                  height: 32,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <ChevronIcon open={isExpanded} size={11} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.8,
                    color: isExpanded ? "#262626" : "#595959",
                  }}
                >
                  {item.label.toUpperCase()}
                </span>
              </div>

              {/* 面板保持挂载，折叠仅显隐（保留树的展开状态 / 搜索词 / 已加载数据） */}
              <div
                style={{
                  display: isExpanded ? "block" : "none",
                  ...(item.key === "collections" || item.key === "documents"
                    ? { paddingLeft: 10, paddingRight: 10 }
                    : {}),
                  ...(isPrimary
                    ? { flex: 1, minHeight: 0 }
                    : { height: SECONDARY_PANEL_HEIGHT, flexShrink: 0 }),
                }}
              >
                {item.key === "collections" ? (
                  <CollectionsPanel search={search} visible={isExpanded} />
                ) : item.key === "documents" ? (
                  <DocumentsPanel visible={isExpanded} />
                ) : (
                  PANELS[item.key]
                )}
              </div>
            </div>
          );
        })}
      </div>

      <NewCollectionModal open={newColOpen} onClose={() => setNewColOpen(false)} />
      <NewSpecModal open={newSpecOpen} onClose={() => setNewSpecOpen(false)} />
      <ImportCollectionModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

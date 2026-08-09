import {
  ApiOutlined,
  DatabaseOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  GlobalOutlined,
  HistoryOutlined,
  DownloadOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Input } from "antd";
import type { MenuProps } from "antd";
import { useMemo, useState } from "react";
import type { RequestProtocol } from "@rabbitpost/shared";
import { documentsApi, environmentsApi } from "../../api";
import { NEW_REQUEST_PROTOCOLS } from "../../lib/protocols";
import { useContainerSize } from "../../lib/use-container-size";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import ChevronIcon from "../common/ChevronIcon";
import CollectionsPanel from "./CollectionsPanel";
import DbConnectionsPanel, { createDefaultDbConnection } from "./DbConnectionsPanel";
import DocumentsPanel from "./DocumentsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import HistoryPanel from "./HistoryPanel";
import ImportCollectionModal from "./ImportCollectionModal";
import NewCollectionModal from "./NewCollectionModal";
import NewSpecModal from "./NewSpecModal";
import SpecsPanel from "./SpecsPanel";

type NavKey = "collections" | "environments" | "databases" | "documents" | "specs";

const NAV_ITEMS: { key: NavKey; label: string }[] = [
  { key: "collections", label: "Collections" },
  { key: "environments", label: "Environments" },
  { key: "databases", label: "Databases" },
  { key: "documents", label: "Documents" },
  { key: "specs", label: "Specs" },
];

// Collections / Documents 面板需要额外 prop（search / visible），在 JSX 中单独渲染
const PANELS = {
  environments: <EnvironmentsPanel />,
  databases: <DbConnectionsPanel />,
  specs: <SpecsPanel />,
} as const;

/** 次要展开组的内容区固定高度（约 3 行数据，内部滚动） */
const SECONDARY_PANEL_HEIGHT = 180;
/** 分组 header 高度 */
const GROUP_HEADER_HEIGHT = 32;
/** 分组底部分隔线，计入 border-box 高度 */
const GROUP_BORDER = 1;
/** 折叠态分组高度：仅留 header */
const COLLAPSED_HEIGHT = GROUP_HEADER_HEIGHT + GROUP_BORDER;
/** 次要展开组高度：header + 固定小窗 */
const SECONDARY_HEIGHT = COLLAPSED_HEIGHT + SECONDARY_PANEL_HEIGHT;
/** 折叠 / 展开过渡动效 */
const GROUP_TRANSITION = "height 220ms cubic-bezier(0.25, 0.1, 0.25, 1)";

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
    databases: false,
    documents: false,
    specs: false,
  });
  // 顶层 Tab：项目 / History
  const [view, setView] = useState<"projects" | "history">("projects");
  // Body 容器高度：主分组需据此算出剩余空间，从而拿到可过渡的显式高度
  // 切到 History 时面板隐藏（display:none），需在回到「项目」时补量一次
  const { ref: bodyRef, size: bodySize } = useContainerSize(view === "projects");
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

  /**
   * 各分组的目标高度（px，border-box）：折叠 = 仅 header，次要展开组 = 固定小窗，
   * 主分组 = 容器剩余空间。高度始终是显式 px，切换 expanded 后新旧值都是确定像素，
   * 由 CSS transition 自行插值，无需命令式写样式，因此不会闪烁也不会卡住。
   */
  const groupHeights = useMemo(() => {
    const heights = {} as Record<NavKey, number | null>;
    let used = 0;
    NAV_ITEMS.forEach(({ key }) => {
      // 主分组先记为 null，待其余组高度累计完再按剩余空间求得
      const h = !expanded[key]
        ? COLLAPSED_HEIGHT
        : key === primaryKey
          ? null
          : SECONDARY_HEIGHT;
      heights[key] = h;
      used += h ?? 0;
    });
    // 容器高度未量到时（首帧）主分组回退 flex:1，量到后给显式高度以支持过渡。
    // 主分组同样不低于 SECONDARY_HEIGHT（对齐 Postman：每个展开分组都有最小高度）。
    // 当多个分组同时展开、剩余空间不足时不再压缩主分组，而是让左侧区域整体滚动
    // （见 bodyOverflow），避免 Collections 被挤到无法展示。
    if (primaryKey) {
      heights[primaryKey] = bodySize.height
        ? Math.max(SECONDARY_HEIGHT, bodySize.height - used)
        : null;
    }
    return heights;
  }, [expanded, primaryKey, bodySize.height]);

  /**
   * 当所有分组的目标高度之和超出容器时，启用左侧区域的纵向滚动，
   * 确保每个展开分组都能保留其最小高度并被完整访问到（对齐 Postman 行为）。
   */
  const bodyOverflow = useMemo(() => {
    if (!bodySize.height) return false;
    const total = NAV_ITEMS.reduce(
      (sum, { key }) => sum + (groupHeights[key] ?? 0),
      0,
    );
    return total > bodySize.height + 1;
  }, [groupHeights, bodySize.height]);

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
        // 协议子菜单：以指定协议打开新草稿（草稿阶段仍可切换协议）
        children: NEW_REQUEST_PROTOCOLS.map((p) => ({
          key: `request-${p.value}`,
          label: p.label,
          onClick: () => openDraft(undefined, p.value as RequestProtocol),
        })),
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
        key: "database",
        icon: <DatabaseOutlined />,
        label: "Database",
        disabled: !currentWorkspaceId,
        onClick: () => {
          if (!currentWorkspaceId) return;
          expand("databases");
          void createDefaultDbConnection(currentWorkspaceId);
        },
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
      {/* 顶层 Tab：项目 / History（仅图标，选中态用背景色区分） */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          gap: 2,
          padding: "4px 6px",
        }}
      >
        {(
          [
            { v: "projects" as const, icon: <UnorderedListOutlined style={{ fontSize: 16 }} />, label: "项目" },
            { v: "history" as const, icon: <HistoryOutlined style={{ fontSize: 16 }} />, label: "History" },
          ]
        ).map((item) => {
          const active = view === item.v;
          return (
            <div
              key={item.v}
              title={item.label}
              onClick={() => setView(item.v)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                userSelect: "none",
                color: "#595959",
                background: active ? "#f0f0f0" : "transparent",
                borderRadius: 4,
                transition: "background 120ms",
              }}
            >
              {item.icon}
            </div>
          );
        })}
      </div>

      {/* 项目视图：搜索框 + New / Import + 可折叠 group 菜单（始终挂载，切 tab 时隐藏） */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: view === "projects" ? "flex" : "none",
          flexDirection: "column",
        }}
      >
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
            icon={<DownloadOutlined />}
            title="Import"
            disabled={!currentWorkspaceId}
            onClick={() => setImportOpen(true)}
          />
        </div>

        {/* Body：可折叠 group 菜单 */}
        <div
          ref={bodyRef}
          className="slim-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflowY: bodyOverflow ? "auto" : "hidden",
          }}
        >
          {NAV_ITEMS.map((item) => {
            const isExpanded = expanded[item.key];
            const height = groupHeights[item.key];
            return (
              <div
                key={item.key}
                style={{
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  borderBottom: `${GROUP_BORDER}px solid #f0f0f0`,
                  overflow: "hidden",
                  transition: GROUP_TRANSITION,
                  // 首帧容器未量到高度时主分组用 flex 占位，其余情况均为显式 px
                  ...(height != null
                    ? { height, flex: "none" }
                    : { flex: 1, minHeight: 0 }),
                }}
              >
                {/* Group header：无图标，大写标题 */}
                <div
                  className="sidebar-hover"
                  onClick={() => toggle(item.key)}
                  style={{
                    height: GROUP_HEADER_HEIGHT,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 10px",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <ChevronIcon open={isExpanded} size={12} />
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 400,
                      color: "#6b6b6b",
                    }}
                  >
                    {item.label}
                  </span>
                </div>

                {/* 面板始终挂载（保留树的展开状态 / 搜索词 / 已加载数据），高度随
                    分组高度自适应：折叠时被 header 压到 0，由外层 overflow 裁剪 */}
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: "hidden",
                    ...(item.key === "collections" || item.key === "documents"
                      ? { paddingLeft: 10, paddingRight: 10 }
                      : {}),
                  }}
                >
                  {item.key === "collections" ? (
                    <CollectionsPanel search={search} visible={isExpanded && view === "projects"} />
                  ) : item.key === "documents" ? (
                    <DocumentsPanel visible={isExpanded && view === "projects"} />
                  ) : (
                    PANELS[item.key as keyof typeof PANELS]
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* History 视图 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: view === "history" ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        <HistoryPanel visible={view === "history"} />
      </div>

      <NewCollectionModal open={newColOpen} onClose={() => setNewColOpen(false)} />
      <NewSpecModal open={newSpecOpen} onClose={() => setNewSpecOpen(false)} />
      <ImportCollectionModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

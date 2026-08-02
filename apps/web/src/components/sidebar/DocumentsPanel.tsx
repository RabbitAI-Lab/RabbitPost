import {
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import { App, Button, Dropdown, Empty, Input, Modal, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import type { NodeRendererProps, TreeApi } from "react-arborist";
import type { DocumentItem } from "@rabbitpost/shared";
import { documentsApi } from "../../api";
import { useContainerSize } from "../../lib/use-container-size";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import ChevronIcon from "../common/ChevronIcon";

/** react-arborist 数据节点：children 为 null 表示叶子（document） */
type ArboristNode = {
  id: string;
  name: string;
  children: ArboristNode[] | null;
  kind: "folder" | "document";
  item: DocumentItem;
};

/** 目录与文档构成的树；Documents 侧栏面板。visible 供展开时重新量取容器高度 */
export default function DocumentsPanel({ visible = true }: { visible?: boolean }) {
  const { message } = App.useApp();
  const { currentWorkspaceId, documentTree, refreshDocuments, applyDocumentTree } =
    useAppStore();
  const { openDocument, renameTab, closeTab } = useTabsStore();
  const { ref: sizeRef, size } = useContainerSize(visible);
  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);
  // 新建条目后待选中的节点 id（等 treeData 刷新后再定位）
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);

  const treeData = useMemo<ArboristNode[]>(() => {
    const buildNodes = (items: DocumentItem[]): ArboristNode[] =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.type,
        item,
        children: item.type === "folder" ? buildNodes(item.children ?? []) : null,
      }));
    return buildNodes(documentTree);
  }, [documentTree]);

  // 新建后：展开祖先链、选中并滚动到新节点
  useEffect(() => {
    if (!pendingSelectId) return;
    const tree = treeRef.current;
    if (!tree || !tree.get(pendingSelectId)) return;
    tree.openParents(pendingSelectId);
    tree.select(pendingSelectId);
    void tree.scrollTo(pendingSelectId);
    setPendingSelectId(null);
  }, [pendingSelectId, treeData]);

  /** 拖拽移动：文件/目录均可拖，目标为根级或目录（目录可嵌套）；乐观更新后全量持久化 */
  const handleMove = ({
    dragIds,
    parentId,
    index,
  }: {
    dragIds: string[];
    parentId: string | null;
    index: number;
  }) => {
    const dragSet = new Set(dragIds);
    // 深拷贝整棵树后操作，避免原地修改 store 数据
    const next = JSON.parse(JSON.stringify(documentTree)) as DocumentItem[];
    const findNode = (nodes: DocumentItem[], id: string): DocumentItem | null => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children?.length ? findNode(n.children, id) : null;
        if (hit) return hit;
      }
      return null;
    };
    const targetList =
      parentId === null ? next : (findNode(next, parentId)?.children ?? null);
    if (!targetList) return;
    // index 基于移除拖拽项之前的目标列表，需扣除插入点之前的拖拽项数量
    const offset = targetList.slice(0, index).filter((n) => dragSet.has(n.id)).length;
    // 按树中原有相对顺序摘出拖拽项
    const dragged: DocumentItem[] = [];
    const pluck = (nodes: DocumentItem[]) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        if (dragSet.has(n.id)) {
          dragged.unshift(...nodes.splice(i, 1));
        } else if (n.children?.length) {
          pluck(n.children);
        }
      }
    };
    pluck(next);
    dragged.forEach((n) => (n.parentId = parentId));
    targetList.splice(index - offset, 0, ...dragged);
    void applyDocumentTree(next);
  };

  const handleAddItem = async (
    parentId: string | null,
    type: "folder" | "document",
  ) => {
    if (!currentWorkspaceId) return;
    const name = type === "folder" ? "New Folder" : "New Document";
    const created = await documentsApi.createItem(currentWorkspaceId, {
      parentId,
      type,
      name,
    });
    await refreshDocuments();
    setPendingSelectId(created.id);
    // 新建文档直接在右侧打开编辑
    if (type === "document") openDocument(created);
  };

  const handleRename = async (item: DocumentItem) => {
    let name = item.name;
    Modal.confirm({
      title: "重命名",
      content: (
        <Input defaultValue={item.name} onChange={(e) => (name = e.target.value)} />
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: async () => {
        await documentsApi.updateItem(item.id, { name });
        await refreshDocuments();
        renameTab(`doc-${item.id}`, name);
      },
    });
  };

  const handleDeleteItem = (item: DocumentItem) => {
    Modal.confirm({
      title: `删除${item.type === "folder" ? "目录" : "文档"}`,
      content: `确定删除「${item.name}」吗？${item.type === "folder" ? "其下所有子项将一并删除。" : ""}`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await documentsApi.removeItem(item.id);
        if (item.type === "document") closeTab(`doc-${item.id}`);
        await refreshDocuments();
        message.success("已删除");
      },
    });
  };

  const itemMenu = (item: DocumentItem) => ({
    items: [
      ...(item.type === "folder"
        ? [
            {
              key: "add-document",
              icon: <FileAddOutlined />,
              label: "新建文档",
              onClick: () => void handleAddItem(item.id, "document"),
            },
            {
              key: "add-folder",
              icon: <FolderAddOutlined />,
              label: "新建子目录",
              onClick: () => void handleAddItem(item.id, "folder"),
            },
          ]
        : []),
      {
        key: "rename",
        icon: <EditOutlined />,
        label: "重命名",
        onClick: () => void handleRename(item),
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: "删除",
        danger: true,
        onClick: () => handleDeleteItem(item),
      },
    ],
  });

  const NodeRow = ({ node, dragHandle }: NodeRendererProps<ArboristNode>) => {
    const data = node.data;
    return (
      <div
        ref={dragHandle}
        className={`tree-row${node.isSelected ? " tree-row-selected" : ""}`}
        onClick={() => {
          if (data.kind === "document") {
            openDocument(data.item);
          } else if (node.isSelected) {
            // 目录同 Collections 树：选中优先、再点才折叠
            node.toggle();
          } else {
            node.open();
          }
        }}
      >
        {/* VS Code 式缩进参考线 */}
        {Array.from({ length: node.level }).map((_, i) => (
          <span key={i} className="tree-indent-guide" />
        ))}
        {/* chevron：仅可展开节点显示，折叠时旋转 -90° */}
        <span className="tree-chevron">
          {node.isInternal && <ChevronIcon open={node.isOpen} size={12} />}
        </span>
        {data.kind === "folder" ? (
          <FolderOutlined
            style={{ fontSize: 17, color: "#8c8c8c", marginRight: 5, flexShrink: 0 }}
          />
        ) : (
          <FileTextOutlined
            style={{ fontSize: 15, color: "#8c8c8c", marginRight: 5, flexShrink: 0 }}
          />
        )}
        <Typography.Text ellipsis style={{ fontSize: 12, flex: 1, color: "#6b6b6b" }}>
          {data.name}
        </Typography.Text>
        {/* 目录：hover 直接显示新建文档 / 新建子目录按钮 */}
        {data.kind === "folder" && (
          <>
            <Button
              className="tree-plus-btn"
              type="text"
              size="small"
              title="新建文档"
              icon={<FileAddOutlined />}
              onClick={(e) => {
                // 避免冒泡到行 onClick 误触折叠
                e.stopPropagation();
                void handleAddItem(data.item.id, "document");
              }}
            />
            <Button
              className="tree-plus-btn"
              type="text"
              size="small"
              title="新建子目录"
              icon={<FolderAddOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                void handleAddItem(data.item.id, "folder");
              }}
            />
          </>
        )}
        {/* Dropdown 菜单渲染在 portal 中，但 React 事件仍沿组件树冒泡到行 onClick，
            会误触 node.toggle() 把当前节点折叠，这里统一拦截 */}
        <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
          <Dropdown menu={itemMenu(data.item)} trigger={["click"]}>
            <Button
              className="tree-more-btn"
              type="text"
              size="small"
              icon={<MoreOutlined />}
            />
          </Dropdown>
        </span>
      </div>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 根级新建入口吸顶，不随树滚动 */}
      <div style={{ display: "flex", gap: 6, padding: "8px 0", flexShrink: 0 }}>
        <Button
          size="small"
          type="primary"
          ghost
          icon={<FileAddOutlined />}
          disabled={!currentWorkspaceId}
          onClick={() => void handleAddItem(null, "document")}
          style={{ flex: 1 }}
        >
          新建文档
        </Button>
        <Button
          size="small"
          icon={<FolderAddOutlined />}
          disabled={!currentWorkspaceId}
          onClick={() => void handleAddItem(null, "folder")}
          style={{ flex: 1 }}
        >
          新建目录
        </Button>
      </div>

      <div ref={sizeRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {!currentWorkspaceId ? (
          <Empty description="请先选择 Workspace" style={{ marginTop: 24 }} />
        ) : documentTree.length === 0 ? (
          <Empty description="还没有文档" style={{ marginTop: 24 }} />
        ) : size.height > 0 ? (
          <Tree<ArboristNode>
            ref={treeRef}
            className="collections-tree"
            data={treeData}
            width={size.width}
            height={size.height}
            rowHeight={24}
            indent={12}
            openByDefault
            disableDrop={({ parentNode, dragNodes }) => {
              // 目标只能是根级或目录（文件不能容纳子项）；且不能拖进自身子树
              if (!parentNode.isRoot && parentNode.data.kind !== "folder") return true;
              const dragSet = new Set(dragNodes.map((n) => n.id));
              let p: typeof parentNode | null = parentNode;
              while (p) {
                if (dragSet.has(p.id)) return true;
                p = p.parent;
              }
              return false;
            }}
            onMove={handleMove}
            disableMultiSelection
          >
            {NodeRow}
          </Tree>
        ) : null}
      </div>
    </div>
  );
}

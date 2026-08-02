import {
  DeleteOutlined,
  DeploymentUnitOutlined,
  DownloadOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  FolderOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { App, Button, Dropdown, Empty, Input, Modal, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import type { NodeApi, NodeRendererProps, TreeApi } from "react-arborist";
import type { Collection, CollectionItem } from "@rabbitpost/shared";
import { collectionsApi } from "../../api";
import { useContainerSize } from "../../lib/use-container-size";
import { useAppStore } from "../../stores/app";
import { useTabsStore } from "../../stores/tabs";
import ChevronIcon from "../common/ChevronIcon";
import ExportCollectionModal from "./ExportCollectionModal";

/** Postman 方法标签：8px 微缩字号 + 方法专属颜色 */
const METHOD_COLORS: Record<string, string> = {
  GET: "#247e4c",
  POST: "#a87d13",
  PUT: "#a87d13",
  PATCH: "#a87d13",
  DELETE: "#a87d13",
  HEAD: "#6b6b6b",
  OPTIONS: "#6b6b6b",
};

function MethodTag({ method }: { method?: string }) {
  if (!method) return null;
  return (
    <span
      style={{
        color: METHOD_COLORS[method] ?? "#6b6b6b",
        fontWeight: 600,
        fontSize: 8,
        marginRight: 5,
        flexShrink: 0,
      }}
    >
      {method}
    </span>
  );
}

/** react-arborist 数据节点：children 为 null 表示叶子（request / scenario） */
type ArboristNode = {
  id: string;
  name: string;
  children: ArboristNode[] | null;
  kind: "collection" | "folder" | "request" | "scenario";
  collection?: Collection;
  item?: CollectionItem;
};

export default function CollectionsPanel({
  search = "",
  visible = true,
}: {
  search?: string;
  /** 面板是否展开；展开时需重新量取容器高度 */
  visible?: boolean;
}) {
  const { message } = App.useApp();
  const {
    currentWorkspaceId,
    collections,
    collectionTrees,
    favoriteCollectionIds,
    refreshCollections,
    refreshCollectionTree,
    toggleFavoriteCollection,
    reorderCollections,
  } = useAppStore();
  const { openFromItem, openCollection, openFolder, openRunner, openScenario, renameTab, closeTab } =
    useTabsStore();
  const { ref: sizeRef, size } = useContainerSize(visible);
  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);
  // 新建条目后待选中的节点 id（等 treeData 刷新后再定位）
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  // 当前正在导出的 Collection（非 null 则弹窗打开）
  const [exportTarget, setExportTarget] = useState<Collection | null>(null);

  const treeData = useMemo<ArboristNode[]>(() => {
    const buildNodes = (items: CollectionItem[]): ArboristNode[] =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.type,
        item,
        children: item.type === "folder" ? buildNodes(item.children ?? []) : null,
      }));
    // 已收藏的 Collection 置顶（组内保持原有顺序）
    const favSet = new Set(favoriteCollectionIds);
    const sorted = [...collections].sort(
      (a, b) => Number(favSet.has(b.id)) - Number(favSet.has(a.id)),
    );
    return sorted.map((col) => ({
      id: `col-${col.id}`,
      name: col.name,
      kind: "collection" as const,
      collection: col,
      children: buildNodes(collectionTrees[col.id] ?? []),
    }));
  }, [collections, collectionTrees, favoriteCollectionIds]);

  /** 判断节点是否位于场景测试目录子树内 */
  const isInScenarioTree = (item: CollectionItem): boolean => {
    if (item.isScenarioRoot) return true;
    // 需要沿 parentId 链向上查找；但 CollectionItem 不含 parent 链，
    // 这里通过 treeData 递归查找
    const findInNodes = (nodes: ArboristNode[], targetId: string, insideScenario: boolean): boolean => {
      for (const node of nodes) {
        const isScenario = node.item?.isScenarioRoot === true;
        if (node.id === targetId) return insideScenario || isScenario;
        if (node.children) {
          if (findInNodes(node.children, targetId, insideScenario || isScenario)) return true;
        }
      }
      return false;
    };
    return findInNodes(treeData, item.id, false);
  };

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

  /** 拖拽排序：仅根级 Collection，按展示顺序（收藏置顶后）重算完整 id 序列持久化 */
  const handleMove = ({
    dragIds,
    parentId,
    index,
  }: {
    dragIds: string[];
    parentId: string | null;
    index: number;
  }) => {
    if (parentId !== null) return;
    const ids = treeData.map((n) => n.collection!.id);
    const draggedIds = dragIds
      .filter((id) => id.startsWith("col-"))
      .map((id) => id.slice(4));
    if (draggedIds.length === 0) return;
    const remaining = ids.filter((id) => !draggedIds.includes(id));
    // index 基于含拖拽项的原数组，需扣除插入点之前的拖拽项数量
    const offset = ids
      .slice(0, index)
      .filter((id) => draggedIds.includes(id)).length;
    remaining.splice(index - offset, 0, ...draggedIds);
    void reorderCollections(remaining);
  };

  const handleAddItem = async (
    collectionId: string,
    parentId: string | null,
    type: "folder" | "request" | "scenario",
  ) => {
    const name =
      type === "folder" ? "New Folder" : type === "scenario" ? "New Scenario" : "New Request";
    const created = await collectionsApi.createItem(collectionId, {
      parentId,
      type,
      name,
    });
    await refreshCollectionTree(collectionId);
    setPendingSelectId(created.id);
  };

  const handleRename = async (item: CollectionItem) => {
    let name = item.name;
    Modal.confirm({
      title: "重命名",
      content: (
        <Input defaultValue={item.name} onChange={(e) => (name = e.target.value)} />
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: async () => {
        await collectionsApi.updateItem(item.id, { name });
        await refreshCollectionTree(item.collectionId);
        // 文件夹详情 tab 与请求 tab 的 key 前缀不同
        renameTab(
          item.type === "folder" ? `folder-${item.id}` : `item-${item.id}`,
          name,
        );
      },
    });
  };

  const handleDeleteItem = (item: CollectionItem) => {
    Modal.confirm({
      title: `删除 ${item.type === "folder" ? "文件夹" : "请求"}`,
      content: `确定删除「${item.name}」吗？${item.type === "folder" ? "其下所有子项将一并删除。" : ""}`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await collectionsApi.removeItem(item.id);
        if (item.type === "folder") closeTab(`folder-${item.id}`);
        await refreshCollectionTree(item.collectionId);
        message.success("已删除");
      },
    });
  };

  const handleDeleteCollection = (col: Collection) => {
    Modal.confirm({
      title: "删除 Collection",
      content: `确定删除「${col.name}」及其全部内容吗？`,
      okButtonProps: { danger: true },
      okText: "删除",
      cancelText: "取消",
      onOk: async () => {
        await collectionsApi.remove(col.id);
        closeTab(`col-${col.id}`);
        await refreshCollections();
        message.success("已删除");
      },
    });
  };

  const itemMenu = (item: CollectionItem) => {
    const inScenario = isInScenarioTree(item);
    const isScenarioRootFolder = item.isScenarioRoot === true;
    return {
      items: [
        // 场景测试目录（及其子目录）：新建场景 + 新建子目录
        ...(item.type === "folder" && (isScenarioRootFolder || inScenario)
          ? [
              {
                key: "add-scenario",
                icon: <DeploymentUnitOutlined />,
                label: "新建场景",
                onClick: () => void handleAddItem(item.collectionId, item.id, "scenario"),
              },
              {
                key: "add-folder",
                icon: <FolderAddOutlined />,
                label: "新建子文件夹",
                onClick: () => void handleAddItem(item.collectionId, item.id, "folder"),
              },
            ]
          : []),
        // 普通目录：新建请求 + 新建子文件夹
        ...(item.type === "folder" && !isScenarioRootFolder && !inScenario
          ? [
              {
                key: "add-request",
                icon: <FileAddOutlined />,
                label: "新建请求",
                onClick: () => void handleAddItem(item.collectionId, item.id, "request"),
              },
              {
                key: "add-folder",
                icon: <FolderAddOutlined />,
                label: "新建子文件夹",
                onClick: () => void handleAddItem(item.collectionId, item.id, "folder"),
              },
            ]
          : []),
        {
          key: "rename",
          icon: <EditOutlined />,
          label: "重命名",
          onClick: () => void handleRename(item),
        },
        // 场景测试根目录不可删除
        ...(!isScenarioRootFolder
          ? [
              {
                key: "delete",
                icon: <DeleteOutlined />,
                label: "删除",
                danger: true,
                onClick: () => handleDeleteItem(item),
              },
            ]
          : []),
      ],
    };
  };

  const collectionMenu = (col: Collection) => ({
    items: [
      {
        key: "add-request",
        icon: <FileAddOutlined />,
        label: "新建请求",
        onClick: () => void handleAddItem(col.id, null, "request"),
      },
      {
        key: "add-folder",
        icon: <FolderAddOutlined />,
        label: "新建文件夹",
        onClick: () => void handleAddItem(col.id, null, "folder"),
      },
      { type: "divider" as const },
      {
        key: "run",
        icon: <PlayCircleOutlined />,
        label: "Run",
        onClick: () => openRunner(col),
      },
      { type: "divider" as const },
      {
        key: "export",
        icon: <DownloadOutlined />,
        label: "导出 Collection",
        onClick: () => setExportTarget(col),
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: "删除 Collection",
        danger: true,
        onClick: () => handleDeleteCollection(col),
      },
    ],
  });

  const NodeRow = ({ node, dragHandle }: NodeRendererProps<ArboristNode>) => {
    const data = node.data;
    const menu = data.collection
      ? collectionMenu(data.collection)
      : data.item
        ? itemMenu(data.item)
        : null;
    return (
      <div
        ref={dragHandle}
        className={`tree-row${node.isSelected ? " tree-row-selected" : ""}`}
        onClick={() => {
          if (data.kind === "request" && data.item) {
            openFromItem(data.item);
          } else if (data.kind === "scenario" && data.item) {
            openScenario(data.item);
          } else if (data.kind === "collection" && data.collection) {
            // 打开 Collection 详情 tab；未选中时仅切换选中（由外层 Row 的 handleClick
            // 在冒泡时完成）并保持展开，已选中的再次点击才切换折叠
            openCollection(data.collection);
            if (node.isSelected) {
              node.toggle();
            } else {
              node.open();
            }
          } else if (data.kind === "folder" && data.item) {
            // 文件夹同 Collection：打开详情 tab + 选中优先、再点才折叠
            openFolder(data.item);
            if (node.isSelected) {
              node.toggle();
            } else {
              node.open();
            }
          } else {
            node.toggle();
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
        {data.kind === "folder" && data.item?.isScenarioRoot && (
          <ExperimentOutlined
            style={{ fontSize: 17, color: "#722ed1", marginRight: 5, flexShrink: 0 }}
          />
        )}
        {data.kind === "folder" && !data.item?.isScenarioRoot && (
          <FolderOutlined
            style={{ fontSize: 17, color: "#8c8c8c", marginRight: 5, flexShrink: 0 }}
          />
        )}
        {data.kind === "scenario" && (
          <DeploymentUnitOutlined
            style={{ fontSize: 15, color: "#722ed1", marginRight: 5, flexShrink: 0 }}
          />
        )}
        {data.kind === "request" && <MethodTag method={data.item?.request?.method} />}
        <Typography.Text ellipsis style={{ fontSize: 12, flex: 1, color: "#6b6b6b" }}>
          {data.name}
        </Typography.Text>
        {/* 场景测试目录（及其子目录）hover 显 +（新建场景） */}
        {data.kind === "folder" && data.item && isInScenarioTree(data.item) && (
          <Button
            className="tree-plus-btn"
            type="text"
            size="small"
            title="新建场景"
            icon={<PlusOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              void handleAddItem(data.item!.collectionId, data.item!.id, "scenario");
            }}
          />
        )}
        {/* Collection 新建请求：hover 显 + */}
        {data.kind === "collection" && data.collection && (
          <Button
            className="tree-plus-btn"
            type="text"
            size="small"
            title="新建请求"
            icon={<PlusOutlined />}
            onClick={(e) => {
              // 避免冒泡到行 onClick 误触打开详情/折叠
              e.stopPropagation();
              void handleAddItem(data.collection!.id, null, "request");
            }}
          />
        )}
        {/* Collection 收藏：hover 显星，已收藏常驻金色实心星并置顶 */}
        {data.kind === "collection" && data.collection && (
          <Button
            className={`tree-star-btn${
              favoriteCollectionIds.includes(data.collection.id)
                ? " tree-star-btn-active"
                : ""
            }`}
            type="text"
            size="small"
            title={
              favoriteCollectionIds.includes(data.collection.id)
                ? "取消收藏"
                : "收藏并置顶"
            }
            icon={
              favoriteCollectionIds.includes(data.collection.id) ? (
                <StarFilled style={{ color: "#fadb14" }} />
              ) : (
                <StarOutlined />
              )
            }
            onClick={(e) => {
              // 避免冒泡到行 onClick 误触打开详情/折叠
              e.stopPropagation();
              toggleFavoriteCollection(data.collection!.id);
            }}
          />
        )}
        {menu && (
          // Dropdown 菜单渲染在 portal 中，但 React 事件仍沿组件树冒泡到行 onClick，
          // 会误触 node.toggle() 把当前节点折叠，这里统一拦截
          <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <Dropdown menu={menu} trigger={["click"]}>
              <Button
                className="tree-more-btn"
                type="text"
                size="small"
                icon={<MoreOutlined />}
              />
            </Dropdown>
          </span>
        )}
      </div>
    );
  };

  return (
    <div ref={sizeRef} style={{ height: "100%", overflow: "hidden" }}>
      {!currentWorkspaceId ? (
        <Empty description="请先选择 Workspace" style={{ marginTop: 24 }} />
      ) : collections.length === 0 ? (
        <Empty description="还没有 Collection" style={{ marginTop: 24 }} />
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
          disableDrag={(data) => data.kind !== "collection" && data.kind !== "scenario"}
          disableDrop={({ parentNode, dragNodes }) => {
            // Collection 拖拽：只允许根级之间重排
            if (dragNodes.some((n) => n.data.kind === "collection")) {
              return !parentNode.isRoot;
            }
            // scenario 拖拽：只能在场景测试目录子树内
            if (dragNodes.some((n) => n.data.kind === "scenario")) {
              // 目标必须是场景测试目录或其子目录
              if (parentNode.isRoot) return true;
              const targetItem = parentNode.data.item;
              if (!targetItem) return true;
              return !isInScenarioTree(targetItem);
            }
            // request/folder 拖拽：不能拖入场景测试目录
            if (dragNodes.some((n) => n.data.kind === "request" || n.data.kind === "folder")) {
              if (parentNode.isRoot) return false; // 根级允许
              const targetItem = parentNode.data.item;
              if (!targetItem) return false;
              return isInScenarioTree(targetItem); // 场景目录内禁止
            }
            return false;
          }}
          onMove={handleMove}
          disableMultiSelection
          searchTerm={search.trim()}
          searchMatch={(node: NodeApi<ArboristNode>, term: string) => {
            // 自身或任一祖先命中即可见：命中的文件夹/Collection 保留整棵子树
            // 注意：向上遍历会到达内部 ROOT 节点，其 data.name 为 undefined
            const t = term.toLowerCase();
            let n: NodeApi<ArboristNode> | null = node;
            while (n) {
              if (n.data?.name?.toLowerCase().includes(t)) return true;
              n = n.parent;
            }
            return false;
          }}
        >
          {NodeRow}
        </Tree>
      ) : null}
      <ExportCollectionModal
        collection={exportTarget}
        open={exportTarget !== null}
        onClose={() => setExportTarget(null)}
      />
    </div>
  );
}

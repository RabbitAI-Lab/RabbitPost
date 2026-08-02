/** 具备 id/name/children 的树节点（CollectionItem / DocumentItem 均兼容） */
interface TrailNode {
  id: string;
  name: string;
  children?: TrailNode[] | null;
}

/** 在树中查找 itemId 的祖先目录名链（不含自身）；未找到返回 null */
export function findFolderTrail(
  nodes: TrailNode[],
  itemId: string,
  trail: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.id === itemId) return trail;
    if (node.children?.length) {
      const found = findFolderTrail(node.children, itemId, [...trail, node.name]);
      if (found) return found;
    }
  }
  return null;
}

/** 在树中查找节点名称；未找到返回 null */
export function findNodeName(nodes: TrailNode[], id: string): string | null {
  for (const node of nodes) {
    if (node.id === id) return node.name;
    if (node.children?.length) {
      const found = findNodeName(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

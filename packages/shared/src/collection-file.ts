import type { Collection, CollectionItem, RequestConfig } from "./index";

/**
 * RabbitPost Collection 交换格式：导出（文件下载 / 公开分享链接）与导入共用，
 * 只保留业务字段（不含 id / collectionId / sortOrder，顺序即数组顺序）。
 */
export const RP_COLLECTION_FORMAT = "rabbitpost.collection";
export const RP_COLLECTION_VERSION = 1;

export type RpCollectionNode =
  | {
      type: "folder";
      name: string;
      description?: string | null;
      items: RpCollectionNode[];
    }
  | { type: "request"; name: string; request?: RequestConfig };

export interface RpCollectionFile {
  format: typeof RP_COLLECTION_FORMAT;
  version: number;
  exportedAt: string;
  name: string;
  description?: string | null;
  items: RpCollectionNode[];
}

function toNodes(items: CollectionItem[]): RpCollectionNode[] {
  return items.map((item) =>
    item.type === "folder"
      ? {
          type: "folder" as const,
          name: item.name,
          description: item.description ?? null,
          items: toNodes(item.children ?? []),
        }
      : { type: "request" as const, name: item.name, request: item.request },
  );
}

export function buildCollectionFile(
  collection: Pick<Collection, "name" | "description">,
  tree: CollectionItem[],
): RpCollectionFile {
  return {
    format: RP_COLLECTION_FORMAT,
    version: RP_COLLECTION_VERSION,
    exportedAt: new Date().toISOString(),
    name: collection.name,
    description: collection.description,
    items: toNodes(tree),
  };
}

function parseNodes(raw: unknown): RpCollectionNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: RpCollectionNode[] = [];
  for (const entry of raw) {
    const node = entry as Record<string, unknown>;
    const name = typeof node?.name === "string" ? node.name : "";
    if (node?.type === "folder") {
      nodes.push({
        type: "folder",
        name,
        description: typeof node.description === "string" ? node.description : null,
        items: parseNodes(node.items),
      });
    } else if (node?.type === "request") {
      nodes.push({
        type: "request",
        name,
        request: (node.request as RequestConfig | undefined) ?? undefined,
      });
    }
  }
  return nodes;
}

/**
 * 解析 RabbitPost Collection 文件；格式标识不匹配时返回 null，
 * 由调用方回退到其它格式（如 Postman）解析。
 */
export function parseCollectionFile(
  raw: unknown,
): Pick<RpCollectionFile, "name" | "description" | "items"> | null {
  const file = raw as Record<string, unknown> | null;
  if (!file || file.format !== RP_COLLECTION_FORMAT) return null;
  const name = typeof file.name === "string" ? file.name.trim() : "";
  if (!name) return null;
  return {
    name,
    description: typeof file.description === "string" ? file.description : null,
    items: parseNodes(file.items),
  };
}

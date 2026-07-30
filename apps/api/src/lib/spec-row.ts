import type { Spec } from "@rabbitpost/shared";
import type { specs } from "../db/schema";

type SpecRow = typeof specs.$inferSelect;

/** specs 行 -> API 输出的 Spec（时间统一 ISO 字符串） */
export function toSpec(row: SpecRow): Spec {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    type: row.type,
    format: row.format,
    content: row.content,
    generatedCollectionId: row.generatedCollectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

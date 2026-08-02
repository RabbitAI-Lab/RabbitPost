import type { RequestCase } from "@rabbitpost/shared";
import type { requestCases } from "../db/schema";

type CaseRow = typeof requestCases.$inferSelect;

/** DB 行 → API 出参（时间戳转 ISO 字符串） */
export function toRequestCase(row: CaseRow): RequestCase {
  return {
    id: row.id,
    itemId: row.itemId,
    name: row.name,
    description: row.description,
    request: row.request,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

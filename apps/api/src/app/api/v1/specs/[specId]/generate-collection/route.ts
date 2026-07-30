import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAsyncApi, specToCollectionDraft, validateSpec } from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { collectionItems, collections, specs } from "../../../../../../db/schema";
import {
  handleRoute,
  HttpError,
  ok,
  requireSpecRole,
} from "../../../../../../lib/http";

type Ctx = { params: Promise<{ specId: string }> };

const bodySchema = z
  .object({
    /** true 时复用已关联的 Collection 并整体覆盖其内容（Postman 的 sync 行为） */
    replaceLinked: z.boolean().optional(),
  })
  .optional();

/**
 * POST /api/v1/specs/:specId/generate-collection — 由定义生成 Collection，editor+
 * 端点按第一个 tag 分文件夹；已关联 Collection 且 replaceLinked 为 true 时覆盖其内容。
 */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { specId } = await ctx.params;
  await requireSpecRole(specId, user.id, "editor");
  const raw: unknown = await req
    .json()
    .catch(() => undefined);
  const body = bodySchema.parse(raw) ?? {};

  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) throw new HttpError(404, "NOT_FOUND", "Spec not found");
  if (isAsyncApi(spec.type)) {
    throw new HttpError(
      400,
      "UNSUPPORTED_SPEC_TYPE",
      "AsyncAPI 定义没有 HTTP 端点，无法生成 Collection",
    );
  }

  const blocking = validateSpec(spec.content, spec.type).filter(
    (issue) => issue.severity === "error",
  );
  if (blocking.length > 0) {
    throw new HttpError(
      400,
      "SPEC_HAS_ERRORS",
      `定义存在 ${blocking.length} 个错误，请先修复：${blocking[0]!.message}`,
    );
  }

  const draft = specToCollectionDraft(spec.content, spec.type, spec.name);
  if (draft.requests.length === 0) {
    throw new HttpError(400, "EMPTY_SPEC", "定义中没有可生成请求的端点");
  }

  // 复用已关联的 Collection（先清空其内容）或新建一个
  let collectionId: string | null = null;
  let reused = false;
  if (body.replaceLinked && spec.generatedCollectionId) {
    const [linked] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, spec.generatedCollectionId))
      .limit(1);
    if (linked) {
      await db.delete(collectionItems).where(eq(collectionItems.collectionId, linked.id));
      await db
        .update(collections)
        .set({ name: draft.name, description: draft.description })
        .where(eq(collections.id, linked.id));
      collectionId = linked.id;
      reused = true;
    }
  }
  if (!collectionId) {
    const [created] = await db
      .insert(collections)
      .values({
        workspaceId: spec.workspaceId,
        name: draft.name,
        description: draft.description,
      })
      .returning();
    if (!created) throw new Error("Failed to create collection");
    collectionId = created.id;
  }

  // 文件夹（按 tag）先建，再按文件夹归属批量插入请求
  const folderIds = new Map<string, string>();
  if (draft.folders.length > 0) {
    const rows = await db
      .insert(collectionItems)
      .values(
        draft.folders.map((name, i) => ({
          collectionId: collectionId!,
          parentId: null,
          type: "folder" as const,
          name,
          sortOrder: i,
        })),
      )
      .returning();
    rows.forEach((row) => folderIds.set(row.name, row.id));
  }

  await db.insert(collectionItems).values(
    draft.requests.map((request, i) => ({
      collectionId: collectionId!,
      parentId: request.folder ? (folderIds.get(request.folder) ?? null) : null,
      type: "request" as const,
      name: request.name,
      sortOrder: i,
      request: request.config,
    })),
  );

  await db
    .update(specs)
    .set({ generatedCollectionId: collectionId, updatedAt: new Date() })
    .where(eq(specs.id, specId));

  return ok({
    collectionId,
    reused,
    folderCount: folderIds.size,
    requestCount: draft.requests.length,
  });
});

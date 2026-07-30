import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  createDefaultSpecContent,
  SPEC_FORMATS,
  SPEC_TYPES,
} from "@rabbitpost/shared";
import { db } from "../../../../../../db";
import { specs } from "../../../../../../db/schema";
import { handleRoute, ok, requireWorkspaceRole } from "../../../../../../lib/http";
import { toSpec } from "../../../../../../lib/spec-row";

type Ctx = { params: Promise<{ workspaceId: string }> };

/** GET /api/v1/workspaces/:workspaceId/specs — 当前 workspace 的全部 spec */
export const GET = handleRoute<Ctx>(async (_req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id);
  const rows = await db
    .select()
    .from(specs)
    .where(eq(specs.workspaceId, workspaceId))
    .orderBy(asc(specs.createdAt));
  return ok(rows.map(toSpec));
});

const createSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.enum([...SPEC_TYPES]),
  format: z.enum([...SPEC_FORMATS]).optional(),
  /** 缺省时按类型填充起始模板（同 Postman 新建 spec 的行为） */
  content: z.string().optional(),
});

/** POST /api/v1/workspaces/:workspaceId/specs — 新建 spec，editor+ */
export const POST = handleRoute<Ctx>(async (req, ctx, user) => {
  const { workspaceId } = await ctx.params;
  await requireWorkspaceRole(workspaceId, user.id, "editor");
  const body = createSchema.parse(await req.json());
  const format = body.format ?? "yaml";

  const [row] = await db
    .insert(specs)
    .values({
      workspaceId,
      name: body.name,
      type: body.type,
      format,
      content:
        body.content?.trim()
          ? body.content
          : createDefaultSpecContent(body.type, body.name, format),
    })
    .returning();
  if (!row) throw new Error("Failed to create spec");
  return ok(toSpec(row), { status: 201 });
});

import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { apiKeys } from "../../../../../../db/schema";
import { getSessionUser } from "../../../../../../lib/auth";
import { err, ok } from "../../../../../../lib/http";

type Ctx = { params: Promise<{ keyId: string }> };

/** DELETE /api/v1/auth/api-keys/:keyId — 吊销自己的 API Key（立即失效） */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return err(401, "UNAUTHORIZED", "Not signed in");
  const { keyId } = await ctx.params;
  const [row] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id)))
    .returning();
  if (!row) return err(404, "NOT_FOUND", "API key not found");
  return ok({ deleted: true });
}

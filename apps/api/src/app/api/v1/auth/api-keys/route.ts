import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiKey, ApiKeyWithToken } from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { apiKeys } from "../../../../../db/schema";
import { getSessionUser, issueApiKey, toApiKey } from "../../../../../lib/auth";
import { err, ok } from "../../../../../lib/http";

/**
 * API Key 管理仅限浏览器会话（避免 Key 自己管理自己形成的扩散面），
 * 因此这里不走 handleRoute 的 Bearer 分支。
 */
async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) return null;
  return user;
}

/** GET /api/v1/auth/api-keys — 当前用户的 API Key 列表（不含明文） */
export async function GET() {
  const user = await requireSessionUser();
  if (!user) return err(401, "UNAUTHORIZED", "Not signed in");
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .orderBy(desc(apiKeys.createdAt));
  return ok<ApiKey[]>(rows.map(toApiKey));
}

const createSchema = z.object({
  name: z.string().min(1).max(64),
});

/** POST /api/v1/auth/api-keys — 创建 API Key；明文 Token 仅此一次返回 */
export async function POST(req: Request) {
  const user = await requireSessionUser();
  if (!user) return err(401, "UNAUTHORIZED", "Not signed in");
  const body = createSchema.parse(await req.json());
  const issued = issueApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: user.id,
      name: body.name,
      keyHash: issued.keyHash,
      keyPrefix: issued.keyPrefix,
    })
    .returning();
  if (!row) throw new Error("Failed to create API key");
  return ok<ApiKeyWithToken>(
    { apiKey: toApiKey(row), token: issued.token },
    { status: 201 },
  );
}

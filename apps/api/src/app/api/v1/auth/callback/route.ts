import { z } from "zod";
import {
  createSession,
  exchangeCodeForUser,
  isCasdoorConfigured,
  upsertUser,
} from "../../../../../lib/auth";
import { env } from "../../../../../env";
import { err, ok } from "../../../../../lib/http";

const bodySchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url().optional(),
});

/**
 * POST /api/v1/auth/callback
 * 用授权码换取 Casdoor token -> 验签 -> upsert 本地用户 -> 写会话 cookie。
 * Casdoor 侧的错误原文透传。
 */
export async function POST(req: Request) {
  if (!isCasdoorConfigured()) {
    return err(
      503,
      "CASDOOR_NOT_CONFIGURED",
      "Casdoor is not configured. Set CASDOOR_* env variables (see .env.example).",
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return err(400, "BAD_REQUEST", "Missing or invalid 'code'");
  }

  try {
    const redirectUri = parsed.data.redirectUri ?? `${env.WEB_ORIGIN}/auth/callback`;
    const profile = await exchangeCodeForUser(parsed.data.code, redirectUri);
    const user = await upsertUser(profile);
    await createSession(user.id);
    return ok({ user });
  } catch (e) {
    // 透传 Casdoor 真实错误信息
    const message = e instanceof Error ? e.message : String(e);
    return err(502, "CASDOOR_EXCHANGE_FAILED", message);
  }
}

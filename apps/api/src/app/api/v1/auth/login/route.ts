import crypto from "node:crypto";
import { buildAuthorizeUrl, isCasdoorConfigured } from "../../../../../lib/auth";
import { env } from "../../../../../env";
import { err, ok } from "../../../../../lib/http";

/**
 * GET /api/v1/auth/login
 * 返回 Casdoor 授权地址，前端整页跳转。redirect_uri 默认为 WEB_ORIGIN/auth/callback。
 */
export async function GET(req: Request) {
  if (!isCasdoorConfigured()) {
    return err(
      503,
      "CASDOOR_NOT_CONFIGURED",
      "Casdoor is not configured. Set CASDOOR_* env variables (see .env.example).",
    );
  }
  const url = new URL(req.url);
  const redirectUri =
    url.searchParams.get("redirect_uri") ?? `${env.WEB_ORIGIN}/auth/callback`;
  const state = crypto.randomBytes(8).toString("hex");
  return ok({ authorizeUrl: buildAuthorizeUrl(redirectUri, state), state });
}

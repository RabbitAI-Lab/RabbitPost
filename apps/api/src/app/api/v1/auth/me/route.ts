import { getApiKeyUser, getSessionUser } from "../../../../../lib/auth";
import { ok } from "../../../../../lib/http";

/** GET /api/v1/auth/me — 当前登录用户（会话或 API Key）；未登录返回 data: null */
export async function GET(req: Request) {
  const user = (await getApiKeyUser(req)) ?? (await getSessionUser());
  return ok({ user });
}

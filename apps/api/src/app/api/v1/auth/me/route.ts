import { getSessionUser } from "../../../../../lib/auth";
import { ok } from "../../../../../lib/http";

/** GET /api/v1/auth/me — 返回当前登录用户；未登录返回 data: null */
export async function GET() {
  const user = await getSessionUser();
  return ok({ user });
}

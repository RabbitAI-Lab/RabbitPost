import { clearSession } from "../../../../../lib/auth";
import { ok } from "../../../../../lib/http";

/** POST /api/v1/auth/logout */
export async function POST() {
  await clearSession();
  return ok({ signedOut: true });
}

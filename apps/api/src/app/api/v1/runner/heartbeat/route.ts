import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Runner } from "@rabbitpost/shared";
import { db } from "../../../../../db";
import { runners } from "../../../../../db/schema";
import { ok } from "../../../../../lib/http";
import { handleRunnerRoute, toRunner } from "../../../../../lib/runner";

const heartbeatSchema = z.object({
  version: z.string().max(64).optional(),
  platform: z.string().max(128).optional(),
});

/**
 * POST /api/v1/runner/heartbeat
 * Runner 上线与保活：上报版本与平台，服务端刷新 lastSeenAt（由鉴权层统一写入）。
 */
export const POST = handleRunnerRoute(async (req, _ctx, runner) => {
  // 心跳可以不带 body，此时仅刷新 lastSeenAt
  const raw = await req.text();
  const patch = heartbeatSchema.parse(raw ? JSON.parse(raw) : {});
  const [row] = await db
    .update(runners)
    .set({
      version: patch.version ?? runner.version,
      platform: patch.platform ?? runner.platform,
      updatedAt: new Date(),
    })
    .where(eq(runners.id, runner.id))
    .returning();
  return ok<Runner>(toRunner(row ?? runner));
});

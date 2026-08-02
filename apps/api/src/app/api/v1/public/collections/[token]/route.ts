import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../../db";
import { collectionShares } from "../../../../../../db/schema";
import { err } from "../../../../../../lib/http";
import { exportCollectionFile } from "../../../../../../lib/collection-file";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /api/v1/public/collections/:token — 无需登录，凭分享链接读取 Collection。
 * 直接返回 RabbitPost Collection 文件 JSON（不套 ApiOk 信封），
 * 以便任意工具（含本站「按链接导入」）拿到即可解析。
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const [share] = await db
      .select()
      .from(collectionShares)
      .where(eq(collectionShares.token, token))
      .limit(1);
    if (!share) return err(404, "NOT_FOUND", "Share link not found or revoked");
    const file = await exportCollectionFile(share.collectionId);
    return NextResponse.json(file, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    // 未知错误原文透传，不做笼统封装
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api] public collection error:", e);
    return err(500, "INTERNAL_ERROR", message);
  }
}

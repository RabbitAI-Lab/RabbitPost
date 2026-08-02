import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const CLI_ARTIFACTS_DIR = path.join(process.cwd(), "public", "cli");

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * GET /api/v1/cli/artifacts/<version>/<file> — 下载 CLI 预编译产物（含 .sha256）。
 * 路径必须落在 public/cli 内，防目录穿越；二进制按附件形式返回。
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { path: segments } = await ctx.params;
  const resolved = path.resolve(CLI_ARTIFACTS_DIR, ...segments);
  if (!resolved.startsWith(CLI_ARTIFACTS_DIR + path.sep)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PATH", message: "Invalid artifact path" } },
      { status: 400 },
    );
  }
  try {
    const data = await readFile(resolved);
    const file = segments.at(-1) ?? "download";
    const isSha = file.endsWith(".sha256");
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": isSha ? "text/plain; charset=utf-8" : "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Content-Length": String(data.byteLength),
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Artifact not found" } },
      { status: 404 },
    );
  }
}

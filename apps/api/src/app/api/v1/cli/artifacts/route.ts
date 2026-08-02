import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const CLI_ARTIFACTS_DIR = path.join(process.cwd(), "public", "cli");

/** 取目录名最大的 vX.Y.Z 作为当前版本 */
async function newestVersionDir(): Promise<string> {
  const entries = await readdir(CLI_ARTIFACTS_DIR, { withFileTypes: true });
  const versions = entries
    .filter((e) => e.isDirectory() && /^v\d/.test(e.name))
    .map((e) => e.name)
    .sort();
  const latest = versions.at(-1);
  if (!latest) throw new Error("no version directory");
  return latest;
}

/**
 * GET /api/v1/cli/artifacts — CLI 预编译产物清单（最新版本的 manifest.json）。
 * 公开访问（下载场景常在未登录的终端/CI 里）；无产物时 404 并提示生成方式。
 */
export async function GET() {
  try {
    const manifest = await readFile(
      path.join(CLI_ARTIFACTS_DIR, await newestVersionDir(), "manifest.json"),
      "utf-8",
    );
    return new NextResponse(manifest, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NO_ARTIFACTS",
          message:
            "No prebuilt CLI artifacts: run `pnpm cli:package` to build, or publish via the cli-release workflow",
        },
      },
      { status: 404 },
    );
  }
}

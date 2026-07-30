/**
 * 开发环境嵌入式 PostgreSQL 启动脚本。
 * 首次运行会下载 PG 二进制并初始化数据目录（默认仓库根 .pgdata）。
 * 用法：pnpm db:up（保持前台运行，Ctrl+C 停止数据库）
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { env } from "../src/env";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const databaseDir = path.isAbsolute(env.EMBEDDED_PG_DIR)
  ? env.EMBEDDED_PG_DIR
  : path.join(repoRoot, env.EMBEDDED_PG_DIR);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: "postgres",
  port: env.EMBEDDED_PG_PORT,
  persistent: true,
  onLog: (msg) => process.stdout.write(`[pg] ${msg}`),
  onError: (msg) => process.stderr.write(`[pg:error] ${msg}`),
});

async function main() {
  // 数据目录已初始化过（存在 PG_VERSION）则跳过 initdb，直接启动
  if (existsSync(path.join(databaseDir, "PG_VERSION"))) {
    console.log(`[db] reusing existing data directory at ${databaseDir}`);
  } else {
    console.log(`[db] initialising embedded postgres at ${databaseDir} ...`);
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase("rabbitpost");
    console.log("[db] database 'rabbitpost' created");
  } catch {
    console.log("[db] database 'rabbitpost' already exists");
  }

  console.log(
    `[db] embedded postgres listening on 127.0.0.1:${env.EMBEDDED_PG_PORT} (user=postgres password=postgres db=rabbitpost)`,
  );
  console.log("[db] keep this process running while developing. Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[db] stopping embedded postgres...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[db] failed to start embedded postgres:", err);
  process.exit(1);
});

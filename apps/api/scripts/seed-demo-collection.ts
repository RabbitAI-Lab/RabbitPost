/**
 * 为已有 workspace 回填 Demo Collection（Rabbit Post Api Demo）。
 * 已存在同名 Collection 的 workspace 会跳过，可重复执行。
 * 用法：pnpm db:seed-demo（需数据库已启动）
 */
import { db, pool } from "../src/db";
import { workspaces } from "../src/db/schema";
import {
  DEMO_COLLECTION_NAME,
  hasDemoCollection,
  seedDemoCollection,
} from "../src/lib/demo-collection";

async function main() {
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces);
  console.log(`[seed] found ${rows.length} workspace(s)`);

  let seeded = 0;
  for (const ws of rows) {
    if (await hasDemoCollection(ws.id)) {
      console.log(`[seed] skip "${ws.name}" (${ws.id}) — already has "${DEMO_COLLECTION_NAME}"`);
      continue;
    }
    const collectionId = await seedDemoCollection(ws.id);
    seeded += 1;
    console.log(`[seed] seeded "${ws.name}" (${ws.id}) -> collection ${collectionId}`);
  }
  console.log(`[seed] done: ${seeded} seeded, ${rows.length - seeded} skipped`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());

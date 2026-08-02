/**
 * 每个 test worker 进程启动时执行：
 * - 在导入 src/db 之前把 DATABASE_URL 指向测试库（env 模块在 import 时固化连接串）
 * - beforeEach 清空全部业务表，测试之间完全隔离（配合单 fork 串行运行）
 */
import { beforeAll, beforeEach } from "vitest";
import pg from "pg";
import { testDatabaseUrl } from "./db-url";

process.env.DATABASE_URL = testDatabaseUrl();

// 只清业务数据：users 保留（全局种子在 beforeAll 创建一次），
// 避免 beforeEach 清表与并发插入 users 的外键竞态
const TABLES = [
  "notifications",
  "usage_events",
  "audit_logs",
  "organization_members",
  "organizations",
  "run_job_results",
  "run_jobs",
  "runners",
  "request_cases",
  "collection_shares",
  "collection_items",
  "collections",
  "histories",
  "environments",
  "document_items",
  "specs",
  "workspaces",
  "team_members",
  "teams",
  "api_keys",
];

async function truncateBusiness() {
  const client = new pg.Client(testDatabaseUrl());
  await client.connect();
  await client.query(`truncate ${TABLES.map((t) => `"${t}"`).join(", ")} cascade`);
  await client.end();
}

// 全局一次：清空并准备测试库（users 由 helpers 按需创建，但首轮 truncate 清掉历史残留）
beforeAll(async () => {
  const client = new pg.Client(testDatabaseUrl());
  await client.connect();
  await client.query(`truncate ${[...TABLES, "users"].map((t) => `"${t}"`).join(", ")} cascade`);
  await client.end();
});

beforeEach(truncateBusiness);

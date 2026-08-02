/**
 * vitest globalSetup（独立进程，跑一次）：
 * 1. 幂等创建测试库 rabbitpost_test；2. 把 drizzle schema 推送到测试库。
 * 注意：本进程的环境变量修改不会传入 test worker，worker 侧的 DATABASE_URL 在 setup.ts 设置。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminDatabaseUrl, testDatabaseUrl } from "./db-url";

export default async function setup() {
  const admin = new pg.Client(adminDatabaseUrl());
  await admin.connect();
  await admin.query("create database rabbitpost_test").catch(() => {
    // 已存在：忽略
  });
  await admin.end();

  const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // 固定参数数组（无 shell 插值），避免 shell 注入面
  execFileSync("pnpm", ["exec", "drizzle-kit", "push", "--force"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: "inherit",
  });
}

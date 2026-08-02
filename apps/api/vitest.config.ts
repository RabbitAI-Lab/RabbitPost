import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // 全部测试共享一个测试库且 beforeEach 清表：必须严格串行。
    // vitest 4 默认按文件并行（多 fork）且文件内并发执行测试函数，
    // 共享库 + 清表场景下两者都必须关掉，否则清表与种子插入互相踩外键。
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

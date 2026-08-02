/**
 * 测试库连接串：与开发库（rabbitpost）完全隔离的独立数据库 rabbitpost_test。
 * CI 上通过 TEST_DATABASE_URL 指向 GitHub service postgres；本地默认 embedded-postgres（5433）。
 */
export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    `postgres://postgres:postgres@localhost:${process.env.EMBEDDED_PG_PORT ?? "5433"}/rabbitpost_test`
  );
}

/** 连到默认 postgres 库，用于幂等创建测试库 */
export function adminDatabaseUrl(): string {
  return testDatabaseUrl().replace(/\/[^/]+$/, "/postgres");
}

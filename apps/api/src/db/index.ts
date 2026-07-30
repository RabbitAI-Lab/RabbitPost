import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDatabaseUrl } from "../env";
import * as schema from "./schema";

// Next.js dev 模式下热更新会重复创建连接池，挂到 globalThis 上复用
const globalForDb = globalThis as unknown as {
  __rabbitpostPool?: Pool;
};

const pool =
  globalForDb.__rabbitpostPool ??
  new Pool({
    connectionString: resolveDatabaseUrl(),
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__rabbitpostPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool, schema };

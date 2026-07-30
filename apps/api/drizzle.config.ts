import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// 加载 apps/api/.env* 与仓库根 .env
loadEnv({ path: [".env.local", ".env", "../../.env"], override: false });

const embeddedUrl = `postgres://postgres:postgres@localhost:${
  process.env.EMBEDDED_PG_PORT ?? "5433"
}/rabbitpost`;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || embeddedUrl,
  },
});

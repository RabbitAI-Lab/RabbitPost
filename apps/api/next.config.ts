import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rabbitpost/shared"],
  serverExternalPackages: [
    "pg",
    "embedded-postgres",
    "jsonwebtoken",
    "mysql2",
    "redis",
    "better-sqlite3",
  ],
};

export default nextConfig;

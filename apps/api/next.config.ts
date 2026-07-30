import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rabbitpost/shared"],
  serverExternalPackages: ["pg", "embedded-postgres", "jsonwebtoken"],
};

export default nextConfig;

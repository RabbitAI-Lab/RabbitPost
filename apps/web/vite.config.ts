import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": r("./src"),
      "@rabbitpost/shared": r("../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 代理到 Next.js API，规避 CORS 并让会话 cookie 同源
      //（长连接协议的 SSE 事件流也经此代理：/api/v1/rt/sessions/:id/events）
      "/api": {
        target: process.env.API_ORIGIN ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});

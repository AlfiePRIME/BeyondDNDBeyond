import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", ".next", "scripts/**"],
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
}));

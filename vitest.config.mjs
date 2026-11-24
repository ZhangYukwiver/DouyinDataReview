import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "collector/**/*.test.{mjs,js,ts,tsx}",
      "desktop/**/*.test.{mjs,js,ts,tsx}",
      "extension/**/*.test.{mjs,js,ts,tsx}",
      "scripts/**/*.test.{mjs,js,ts,tsx}",
      "src/**/*.test.{mjs,js,ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.claude/**",
      "**/.codex/**",
      "**/.expo/**",
      "**/android/**",
      "**/build/**",
      "**/dist/**",
      "**/docs/**",
      "**/output/**",
      "**/outputs/**",
      "**/release/**",
      "**/release-*/**",
    ],
  },
});

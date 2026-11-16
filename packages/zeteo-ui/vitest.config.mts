import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: { inline: [
          /@testing-library/,
          /@kosmeo-ui\//,
          /@tanstack\//,
          /@tereo-io\//,
        ] },
    },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

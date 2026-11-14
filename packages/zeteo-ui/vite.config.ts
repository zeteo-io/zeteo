import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const zeteo = env.VITE_ZETEO_URL || "http://localhost:4201";

  return {
    // Zeteo serves the production build at its root, around its reserved
    // paths (scripts/check-routes.mjs keeps routes clear of them).
    base: "/",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      // One copy of each: @kosmeo-ui/react shares the app's React and its
      // QueryClient context, which a second copy of react-query cannot see.
      dedupe: ["react", "react-dom", "@tanstack/react-query"],
    },
    build: {
      outDir: "./dist",
      emptyOutDir: true,
      // One stylesheet, loaded by index.html: with per-chunk CSS, a kosmeo
      // component shared by several lazy pages can render unstyled.
      cssCodeSplit: false,
    },
    plugins: [react()],
    server: {
      // Zeteo's CORS list and the login client's redirect URIs name this port.
      port: 4200,
      strictPort: true,
      // The built app calls zeteo on its own origin; the dev server forwards
      // the same paths so the code is identical in both.
      proxy: {
        "/v1": zeteo,
        "/ui-config.json": zeteo,
      },
    },
  };
});

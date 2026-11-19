import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The page is built from mcp-card.html; zeteo serves the file as card.html.
const renameToCard = (): Plugin => ({
  name: "zeteo-card-name",
  enforce: "post",
  generateBundle(_, bundle) {
    const page = bundle["mcp-card.html"];
    if (!page) throw new Error("mcp-card.html was not built");
    page.fileName = "card.html";
  },
});

// The MCP Apps preview card: one self-contained HTML file, scripts and
// styles inlined, because a host's default CSP allows no external scripts
// and zeteo declares no resource domains.
export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  // public/ holds the app's own files (favicon, theme-init.js); none belong here.
  publicDir: false,
  build: {
    outDir: "./dist-mcp",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "mcp-card.html"),
    },
  },
  plugins: [react(), viteSingleFile(), renameToCard()],
});

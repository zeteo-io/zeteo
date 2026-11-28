---
zeteo: patch
---

`packages/zeteo/.env.example` sets `NODE_ENV=development`, without which `npm run dev` stopped at start (the Tereo SDK refuses test mode when `NODE_ENV` is unset); an existing `.env` needs the line added. `local-instance/start.sh` runs a local instance to try Zeteo: Tereo and Zeteo in Docker with the admin UI, uploads and MCP on, and the first admin created.

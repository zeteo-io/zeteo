# zeteo-ui

The admin UI for zeteo: sources with their tables and relations, grants, concurrency limits and
the run record. A Vite + React app built on `@kosmeo-ui/react`; its production build ships in
zeteo's image and zeteo serves it at `/`. Server side: [admin-ui.md](../zeteo/docs/admin-ui.md).

```sh
cp .env.example .env.development.local
npm run dev        # http://localhost:4200, forwarding /v1 and /ui-config.json to zeteo on :4201
npm run build      # dist/
npm run check      # tsc and the reserved-path check
npx vitest run
```

Fonts and icons are bundled: zeteo's content security policy allows no inline script and no remote
origin besides Tereo.

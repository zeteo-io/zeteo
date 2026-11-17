# zeteo-ui

The admin UI for zeteo: sources with their tables and relations, grants, concurrency limits and
the run record. A Vite + React app built on `@kosmeo-ui/react`; its production build ships in
zeteo's image (the Dockerfile's `ui` stage) and zeteo serves it at `/` when `UI_CLIENT_ID` is set.
The screens, the login client and local development (zeteo on 4201 with `UI_CLIENT_ID`, the redirect
and CORS entries for port 4200, why sign-in needs https or localhost) are in
[admin-ui.md](../zeteo/docs/admin-ui.md).

```sh
cp .env.example .env.development.local
npm run dev        # http://localhost:4200, forwarding /v1 and /ui-config.json to zeteo on :4201
npm run build      # dist/
npm run check      # tsc and the reserved-path check
npx vitest run
```

Fonts and icons are bundled: zeteo's content security policy allows no inline script and no remote
origin besides Tereo.

Tests: component tests here (Vitest + jsdom), and a browser test of the built image against a real
Tereo, `e2e/browser/admin.spec.ts` (`e2e/run.sh --browser` from the root; see
[e2e/README.md](../../e2e/README.md)). Feature tests mock `@tereo-io/react` with
`src/test/authMock.ts` (signed in, with zeteo's client answering what the test gives it).

Sign-in is [`@tereo-io/react`](https://www.npmjs.com/package/@tereo-io/react): access and ID tokens
in `localStorage`, the refresh token in Tereo's httpOnly cookie, one session shared by tabs, and
permissions reloaded live when Tereo pushes a change.

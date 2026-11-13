# Code Style

CI enforces these rules and fails on any of them:

```sh
npm run format:check        # Prettier          (npm run format to fix)
npm run sort-imports:check  # import order      (npm run sort-imports to fix)
npm run lint                # ESLint
npx nx run-many -t check    # tsc --noEmit
```

## Formatting

Enforced by Prettier. Key settings:

- **Indent**: 2 spaces
- **Semicolons**: always
- **Quotes**: double
- **Trailing commas**: ES5 (objects, arrays, multi-line function params)
- **Print width**: 80 (soft limit)

## TypeScript

- **Strict mode**: enabled on all packages
- **No `any`**: use `unknown` or proper types; if unavoidable, add a comment explaining why
- **Runtime validation**: always Zod for data crossing a boundary (request bodies, query params, env vars)
- **ES modules**: `.js` extensions on all relative imports, directory imports included (`./v1/index.js`)
- **Type imports**: `import type { ... }` for type-only imports

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Variables / functions | camelCase | `getUserById`, `isActive` |
| Classes / interfaces / types | PascalCase | `SourceType`, `QueryInput` |
| Files | camelCase | `requestId.ts`, `validateReq.ts` |
| Database fields | camelCase (Prisma maps to snake_case in the DB) | `createdAt`, `organizationId` |
| Environment variables | SCREAMING_SNAKE_CASE | `REDIS_URL`, `DATABASE_URL` |

## Error Handling

- Use the error classes from `utils/errors.ts` — never `res.status(400).json(...)` directly
- Never swallow errors silently; log them with `logger.error` if you can't rethrow
- Log the error itself under `err` (`logger.error({ err }, "msg")`), which Pino serializes with its
  stack — not its message, and not under `error`. ESLint (`no-restricted-syntax`) refuses both
- Best-effort calls catch and log, never propagate

```typescript
// Good
throw new NotFoundError("Source not found");
throw new ForbiddenError("Write permission required");

// Bad
res.status(404).json({ message: "Not found" });
```

## Comments

Add comments only where the logic isn't self-evident. Don't comment what code does — comment why it
does it. The `comments` skill has the full rules.

```typescript
// Good — explains non-obvious reasoning
// A pooled connection keeps its own session state: reset it before reuse
await client.query("DISCARD ALL");

// Bad — restates the code
// Set the status to active
user.status = "active";
```

## Environment Variables

Zeteo has one env schema, `packages/zeteo/src/env.ts`, validated with Zod at startup; the
service fails to start with a clear error when a required variable is missing. `src/preload.ts`
(which loads `.env`) must be the first import of every entry point.

## Import Ordering

Imports are sorted by **line length, longest first**. Single-line imports come before multi-line
imports, which are ordered by the length of their last line.

```typescript
// packages/zeteo/src/routes/v1/sources/index.ts
import { authenticate } from "../../../middleware/auth.js";
import { CreateSourceSchema } from "./schemas.js";
import sourceRouter from "./source/index.js";
import { Router } from "express";
import {
  listSources,
  createSource,
  archiveSource,
  restoreSource,
} from "./controllers.js";
```

Two exceptions keep code working: side-effect imports that come before every other import
(`import "./preload.js"`) stay first, in order, and a comment above the first import stays on top.

```sh
npm run sort-imports                                  # every package's src/
npx tsx scripts/sort-imports.ts <file-or-dir>...      # specific paths
```

To sort on save in VS Code, install *Run on Save* (`emeraldwalk.runonsave`) and add to your
(gitignored) `.vscode/settings.json`:

```json
{
  "emeraldwalk.runonsave": {
    "commands": [
      {
        "match": "\\.(ts|tsx)$",
        "cmd": "npx tsx ${workspaceFolder}/scripts/sort-imports.ts ${file}",
        "isAsync": true,
        "silent": true
      }
    ]
  }
}
```

## Releases

`zeteo` is versioned with Nx release version plans, in one release group, `core`, tagged
`zeteo@<version>`. It is the image's version; the package is not published to npm.

A PR that changes the package needs a plan: `npm run version-plan`, then commit the file in
`.nx/version-plans/`. CI's version-plan check says when one is missing.

Merging a PR into `master` while plans are pending opens (or updates) the release PR,
`chore(release): bump versions`, from the branch `release/version-bump`: it applies the plans to
the version and changelog and deletes them (`.github/workflows/create-version-pr.yml`). Merging
that PR publishes `ghcr.io/zeteo-io/zeteo:<version>` (and `<major>.<minor>`) for amd64 and arm64
and tags `zeteo@<version>` (`.github/workflows/publish.yml`). The publish workflow can also be
started by hand, for the first release or to retry one; it skips a version whose tag exists.

Before 1.0, a plan's bump is one step smaller than its name: `major` for a breaking change gives
0.1 → 0.2, `minor` for a feature and `patch` for a fix both give 0.1.0 → 0.1.1. Plan a breaking
change as `major`.

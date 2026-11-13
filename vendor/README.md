# Vendored packages

Zeteo installs two of tereo's packages from tarballs here, because the versions it needs are not
on npm yet:

| Tarball | Package | Built from |
|---------|---------|------------|
| `tereo-io-mcp-0.0.0.tgz` | `@tereo-io/mcp` (unpublished) | tereo `013626e988c5250f141e6da38fc0437964f89fe2` |
| `tereo-io-sdk-0.5.0-013626e9.tgz` | `@tereo-io/sdk`, unreleased changes after 0.5.0 | the same commit |

They go together: `@tereo-io/mcp` imports `authContextFromIntrospection` and `hasPermission` from
`@tereo-io/sdk`, which the published 0.5.0 does not export. The SDK's version field still says
0.5.0; the commit in the file name is what was built.

`packages/zeteo/package.json` names them as `file:../../vendor/<tarball>`, and both Dockerfiles copy
this folder before `npm ci`.

## Replacing them

From a tereo checkout at the commit you want:

```sh
npm ci
npm run build -w @tereo-io/sdk -w @tereo-io/mcp
(cd packages/tereo-sdk && npm pack)
(cd packages/tereo-mcp && npm pack)
```

Move the two tarballs here (rename the SDK's to carry the new commit), update the `file:` paths in
`packages/zeteo/package.json` and the table above, and run `npm install` at zeteo's root to refresh
`package-lock.json`.

Once both are published, depend on the npm versions instead and delete this folder and the
`COPY vendor` lines in `docker/Dockerfile` and `docker/test/Dockerfile`.

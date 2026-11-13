# End-to-end run against a real Tereo

zeteo's unit and int suites run with Tereo in the SDK's test mode, so nothing in them talks to a
Tereo. This run does: it starts a Tereo, zeteo from this checkout's image (not in test mode), and a
source Postgres serving TLS, signs real users in, and checks what only a real Tereo can show.

It is a local script, not a CI job:

```sh
e2e/run.sh                 # or: npm run test:e2e
KEEP=1 e2e/run.sh          # leave the stack running afterwards (e2e/run.sh down removes it)
e2e/run.sh -t "MCP"        # extra arguments go to vitest
```

It needs Docker (with Compose), Node and `openssl` on the host, and `npm install` at the root.
A run takes about a minute and a half once the images are built, a minute of it in the group case,
which waits out zeteo's 30 s group cache twice.

## The stack

`e2e/docker-compose.yml`, compose project `zeteo-e2e`:

| Service | What |
|---------|------|
| `tereo`, with `tereo-postgres`, `tereo-redis`, `tereo-migrate` | Tereo in development mode (its production mode refuses a loopback `http` issuer), set up unattended with `SETUP_TOKEN`, provisioned with `packages/zeteo/tereo-provisioning.json` and `e2e/provisioning/e2e-clients.json` |
| `zeteo`, with `zeteo-postgres`, `zeteo-redis`, `zeteo-migrate` | zeteo's image in production mode, signed in to Tereo as the `zeteo` service, MCP on for `e2e-mcp`, `SOURCE_ALLOWED_HOSTS=source-pg` |
| `zeteo-ca` | A second replica of the same deploy (same database and Redis) whose process trusts the run's CA through `NODE_EXTRA_CA_CERTS` |
| `source-pg` | The source: Postgres with `ssl=on`, a certificate for `source-pg` from a CA generated for the run, and a read-only login `zeteo_ro` (`e2e/source/`) |

- **Tereo's image** is a released one, `TEREO_IMAGE` (default `ghcr.io/tereo-io/tereo:0.8.1`),
  pulled when it is not present. If it cannot be pulled the run stops and names the image it needs.
- **zeteo's image** is built from this checkout as `zeteo:e2e` (`ZETEO_IMAGE`; `SKIP_ZETEO_BUILD=1`
  reuses one already built).
- **Ports**: Tereo and both zeteo replicas are published on `127.0.0.1`; nothing else is. The
  script finds three free ports, releases them, and compose binds them a moment later. Another
  process could take one in between; that is rare, and `up` then fails loudly with the port in use
  (run again).
- **Secrets**: the setup token, user password, client secrets, master key, request handler key and
  the source login's password are generated for each run into `e2e/.env.run` (git-ignored); the
  databases' own passwords are fixed `*-e2e-only` constants on networks nothing outside reaches.
- **Teardown**: at the end, pass or fail, the script removes the project's containers, networks
  and volumes, then `e2e/.env.run` and `e2e/certs/`, unless `KEEP=1`. If `down` fails, the env file
  is kept and `e2e/run.sh down` tries again; without the env file it still uses the compose file, so
  the named volumes are found. The script refuses to start while any container or volume of the
  `zeteo-e2e` project exists. It touches no other compose project.
- **Images left behind**: the run keeps the images, so the next one starts faster:
  `ghcr.io/tereo-io/tereo:<tag>` (the `TEREO_IMAGE` used), `zeteo:e2e`, and the base images
  `postgres:18-alpine` and `redis:7-alpine` (which other stacks on the machine may share). Remove
  them with `docker image rm ghcr.io/tereo-io/tereo:0.8.1 zeteo:e2e`, adding the base images only if
  nothing else uses them; `docker builder prune` drops the build cache of `zeteo:e2e`.

Sign-in is scripted over HTTP, as Tereo's own tests do it: `GET /oauth/authorize`, the password
step the login page posts, consent when the client asks for it, and the code exchange with PKCE
(`e2e/support/oauth.ts`). No browser is involved.

## Login clients

`e2e/provisioning/e2e-clients.json`, beside zeteo's own document (whose service has a confidential
client, `zeteo`, with the run's `TEREO_CLIENT_SECRET`):

| Client | Type | Audience | Used for |
|--------|------|----------|----------|
| `e2e-web` | confidential | `zeteo` | users' tokens for `/v1` |
| `e2e-mcp` | public, consent | `zeteo` | the MCP client's sign-in; listed in `MCP_ALLOWED_CLIENTS` |
| `e2e-other` | public | none | a token for another audience |
| `tereo-ui` | Tereo's own | Tereo | the admin's calls to Tereo's admin API |

## What it checks

Users are created through Tereo's admin API: `alice` (role `zeteo_mcp_user`, granted tables
herself), `bob` (`zeteo_user`, granted only through the group `e2e-analysts`) and `dave`
(`zeteo_user`), plus the admin from setup.

| File | Case |
|------|------|
| `auth.e2e.test.ts` | A user's token reaches `GET /v1/catalog`; a token Tereo issued to a client without `zeteo` in its audience (live: Tereo answers its userinfo) is 401 |
| `groups.e2e.test.ts` | bob, refused before, can query once Tereo puts him in the group, and is refused again within 35 s of leaving it (`GET /v1/admin/users/:id/groups`); a group grant's `principal_status` is `active` (zeteo reads the group under its `group_resolver`; Tereo logs only requests it refuses, so there is no logged 200), a grant to a group Tereo never had is `orphaned` (Tereo logs the 404 from `GET /v1/admin/groups/:id`), and neither lookup logs a failure in zeteo |
| `serviceToken.e2e.test.ts` | Tereo revokes zeteo's service token (revoking and re-approving one of its access rows); the next query's group lookup gets the 401, the SDK retries it with a new token and the query answers 200 |
| `tls.e2e.test.ts` | `tls: verify` against the untrusted certificate is `502 source_unreachable`; the replica with `NODE_EXTRA_CA_CERTS` registers and queries the same source; `verify` with the CA in the source's `ca` setting works; `tls: require` works without trusting the CA |
| `audit.e2e.test.ts` | A query's `zeteo.query.run` and an export's `zeteo.export.started` and `zeteo.export.run` reach Tereo's audit log through the outbox |
| `mcp.e2e.test.ts` | An unauthenticated `initialize` gets the 401 challenge naming the resource metadata, which names Tereo; a token from a client not in `MCP_ALLOWED_CLIENTS` is refused; a user signed in through `e2e-mcp`, found from the challenge as an MCP client finds it, lists the four tools and runs `query` |

Some checks read the stack directly with `docker compose` (`e2e/support/compose.ts`): zeteo's log,
for failures a response would hide, and the count of zeteo's undelivered outbox rows.

The tests are Vitest files with their own config (`e2e/vitest.config.ts`), outside
`packages/zeteo`, so neither the unit nor the int project picks them up. `npx tsc -p e2e`
type-checks them.

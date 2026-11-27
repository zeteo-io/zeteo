# Your own local Zeteo instance

One command starts a Zeteo you can sign in to and try: Tereo for sign-in, users and groups, Zeteo
with its admin UI, uploads and MCP, all in Docker on your machine. Your data stays between restarts.
Use it to try Zeteo, not as a deployment: Tereo runs in development mode over plain http, and
nothing is published beyond `127.0.0.1`.

(The root `docker-compose.yml` and `npm run dev` run Zeteo in test mode, with fake tokens and no
UI: they're for working on Zeteo's code. See the main [README](../README.md#develop).)

## What you need

- Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
  [OrbStack](https://orbstack.dev), running. About 2 GB free disk for the images.
- Node 22 or later, `openssl` and `curl` (macOS has the last two). No `npm install` needed.
- Ports 4001 (Tereo) and 4201 (Zeteo) free, or others you choose (below).

## Start it

```sh
git clone https://github.com/zeteo-io/zeteo.git
cd zeteo
local-instance/start.sh
```

The first run builds Zeteo's image from the checkout (a few minutes), pulls Tereo's released
image, starts everything, creates the first admin and prints:

```
  Admin UI   http://localhost:4201
  Sign in    admin@example.com
  Password   Local-…-Pw!
```

Open the admin UI, click **Sign in**, and sign in on Tereo's page with that email and password.
They're also in `local-instance/.env`, with the instance's secrets. The admin can do everything in
Zeteo and in Tereo.

Other ports or admin email: set them on the **first** run, for example
`ZETEO_PORT=4301 TEREO_PORT=4302 ADMIN_EMAIL=you@example.com local-instance/start.sh`. Later, edit
the ports in `local-instance/.env` and run `start.sh` again (the email is fixed once the admin
exists).

## Everyday commands

| Command | Does |
|---------|------|
| `local-instance/start.sh` | Start, or update after `git pull`: rebuilds the image and restarts on the same data (`SKIP_BUILD=1` skips the build) |
| `local-instance/start.sh status` | The containers, the URLs and the sign-in |
| `local-instance/start.sh logs` | Follow Zeteo's and Tereo's logs |
| `local-instance/start.sh stop` | Stop it; the data stays |
| `local-instance/start.sh reset` | **Delete** the instance: sources, grants, users, uploads and `local-instance/.env`. The next `start.sh` makes a new one |

## Add data

### Upload a file

**My Zeteo → Uploads** takes a CSV or Excel file and makes it a source you can query and grant
like a database. Nothing to configure.

### Connect a Postgres or Azure SQL database

Zeteo connects only to hosts listed in `SOURCE_ALLOWED_HOSTS` in `local-instance/.env` (empty at
first, so no database can be added). Add the host, run `local-instance/start.sh` again, then
**Admin → Sources → New source**. The login you give Zeteo should be read-only: Zeteo refuses a
login that can write unless you tell it otherwise. More in
[docs/sources.md](../packages/zeteo/docs/sources.md).

Zeteo runs inside Docker, so `localhost` there is Zeteo's own container, not your Mac. Where the
database is decides what to list:

| Database | `SOURCE_ALLOWED_HOSTS` | Host in the form |
|----------|------------------------|------------------|
| In the cloud or on your network (`db.example.com`) | `db.example.com` | `db.example.com` |
| In a Docker container on your Mac | its container name, after `docker network connect zeteo-local_default <container>` | the container name, port 5432 inside the container |
| On your Mac, with **Docker Desktop** | `host.docker.internal` | `host.docker.internal` |
| On your Mac, with **OrbStack** | your Mac's LAN address, such as `192.168.1.20` (the database must listen on it) | that address |

OrbStack's `host.docker.internal` resolves into `0.0.0.0/8`, which Zeteo always refuses, whatever
the list says. Moving the database into a container (row 2) avoids the question.

Several entries are comma separated; `*.example.com` and CIDRs like `10.0.0.0/8` work too.

### Let people query

Zeteo shows nobody any data until it's granted:

1. Add people in **Tereo** (`http://localhost:4001`, same admin sign-in): **Users → New user**.
   Give them the role `zeteo_user` (query), `zeteo_mcp_user` (query and connect an AI), or
   `zeteo_admin`. Groups work too.
2. In Zeteo, **Admin → Grants → New grant**: a person or group, a source, a table, its columns.
   Grant yourself as well: the admin can manage everything but sees only the data it's granted.

They then sign in at the admin UI and find what they may query under **My Zeteo**.

## Connect Claude over MCP

MCP is on, for the login client `zeteo-mcp`. In Claude Code:

```sh
claude mcp add --transport http --client-id zeteo-mcp --callback-port 8765 zeteo-local http://localhost:4201/mcp
```

Then `/mcp` in Claude Code to sign in (as someone with `zeteo_mcp_user` or the admin). The
callback ports `8765` (Claude Code) and `8766` (`mcp-remote`, for Claude Desktop) are registered
in `local-instance/provisioning/clients.json`. More in [docs/mcp.md](../packages/zeteo/docs/mcp.md).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `start.sh` stops with a port in use | Change `ZETEO_PORT` or `TEREO_PORT` in `local-instance/.env` and run it again |
| A source fails with `host_not_allowed` | The host isn't in `SOURCE_ALLOWED_HOSTS`, or it resolves to an address Zeteo always refuses (see the table above). Run `start.sh` after editing `.env` |
| A source fails with `source_unreachable` | Zeteo can't reach the database from inside Docker: check the host, the port and that the database listens on that address |
| Tereo answers `Invalid redirect URI` at sign-in | Open the UI as `http://localhost:<port>`, not `127.0.0.1`: the login client knows only `localhost` |
| Lost the password | `local-instance/start.sh status` prints it |
| Something's off and you don't need the data | `local-instance/start.sh reset`, then `local-instance/start.sh` |

## What's inside

`docker-compose.yml` (project `zeteo-local`): Tereo (`ghcr.io/tereo-io/tereo:0.8.3`, or
`TEREO_IMAGE`) with its Postgres and Redis, provisioned with Zeteo's
`packages/zeteo/tereo-provisioning.json` and this folder's `provisioning/clients.json` (the admin
UI's login client `zeteo-ui`, which `start.sh` points at your Zeteo port, and `zeteo-mcp`); Zeteo
(image `zeteo:local-instance`, or `ZETEO_IMAGE`) in production mode with its Postgres, Redis and
the uploads reader role. Named volumes hold both databases and Tereo's files. `start.sh` writes
`.env` (git-ignored) on the first run and `.run/clients.json` on every run.

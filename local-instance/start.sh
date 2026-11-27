#!/usr/bin/env bash
# A local Zeteo instance with a real Tereo to sign in to. From the repo root:
#
#   local-instance/start.sh          # build Zeteo's image, start, print the sign-in
#   local-instance/start.sh stop     # stop the containers, keep the data
#   local-instance/start.sh logs     # follow Zeteo's and Tereo's logs
#   local-instance/start.sh status   # the containers and the URLs
#   local-instance/start.sh reset    # DELETE the instance: containers, volumes, secrets
#
# The first run writes local-instance/.env (secrets, ports, the admin's
# sign-in) and creates Tereo's first admin. Later runs reuse it and rebuild the
# image from the checkout, so `git pull && local-instance/start.sh` updates the
# instance in place. SKIP_BUILD=1 reuses the image already built.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ENV_FILE="$DIR/.env"
RUN_DIR="$DIR/.run"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml" --env-file "$ENV_FILE")

log() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in docker node openssl curl; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
docker info >/dev/null 2>&1 || die "Docker is not running (start Docker Desktop or OrbStack)"

envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

print_access() {
  local zeteo tereo
  zeteo="http://localhost:$(envval ZETEO_PORT)"
  tereo="http://localhost:$(envval TEREO_PORT)"
  cat >&2 <<EOF

Zeteo is running.

  Admin UI   $zeteo
  Sign in    $(envval ADMIN_EMAIL)
  Password   $(envval ADMIN_PASSWORD)
  Tereo      $tereo  (users, groups and roles; same sign-in)
  MCP        $zeteo/mcp  (client id zeteo-mcp)

The sign-in is also in local-instance/.env. Next: add a source (local-instance/README.md).
EOF
}

case "${1:-start}" in
  start) ;;
  stop)
    [[ -f "$ENV_FILE" ]] || die "no instance here ($ENV_FILE is missing)"
    "${COMPOSE[@]}" stop
    exit 0
    ;;
  logs)
    [[ -f "$ENV_FILE" ]] || die "no instance here ($ENV_FILE is missing)"
    exec "${COMPOSE[@]}" logs --follow --tail 50 zeteo tereo
    ;;
  status)
    [[ -f "$ENV_FILE" ]] || die "no instance here ($ENV_FILE is missing)"
    "${COMPOSE[@]}" ps
    print_access
    exit 0
    ;;
  reset)
    [[ -f "$ENV_FILE" ]] || die "no instance here ($ENV_FILE is missing)"
    if [[ "${2:-}" != "--yes" ]]; then
      printf 'This deletes the instance: its sources, grants, users and uploads. Type "reset" to go on: ' >&2
      read -r answer
      [[ "$answer" == "reset" ]] || die "not reset"
    fi
    "${COMPOSE[@]}" down --volumes --remove-orphans
    rm -rf "$RUN_DIR" "$ENV_FILE"
    log "Removed. local-instance/start.sh starts a new one."
    exit 0
    ;;
  *) die "unknown command: $1 (start, stop, logs, status or reset)" ;;
esac

# --- First run: secrets and ports -------------------------------------------
b64url() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }
hex() { openssl rand -hex "$1"; }

if [[ ! -f "$ENV_FILE" ]]; then
  log "First run: writing local-instance/.env"
  cat >"$ENV_FILE" <<EOF
# This instance's settings and secrets, written by start.sh on its first run.
# Keep it: Zeteo's master key encrypts the sources' passwords, and the data
# cannot be read without it. reset deletes it with the instance.

# Host ports, on 127.0.0.1. Change them before the first run, or run
# start.sh again after changing them.
ZETEO_PORT=${ZETEO_PORT:-4201}
TEREO_PORT=${TEREO_PORT:-4001}

# Where sources may connect, comma separated: hostnames, *.suffix, IPs and
# CIDRs. Empty means no source can be added (uploads still work). Run
# start.sh again after changing it. See local-instance/README.md.
SOURCE_ALLOWED_HOSTS=

# Tereo's first admin, created on the first run.
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
ADMIN_PASSWORD=Local-$(hex 8)-Pw!

# Secrets.
SETUP_TOKEN=$(hex 16)
ZETEO_CLIENT_SECRET=tereo_sk_$(b64url 32)
ZETEO_MASTER_KEY=$(b64url 32)
REQUEST_HANDLER_KEY=$(hex 32)
EOF
  chmod 0600 "$ENV_FILE"
fi

ZETEO_PORT="$(envval ZETEO_PORT)"
TEREO_PORT="$(envval TEREO_PORT)"
[[ "$ZETEO_PORT" != "$TEREO_PORT" ]] || die "ZETEO_PORT and TEREO_PORT must differ"

# Tereo matches redirect URIs exactly, port included: the UI's login client
# gets this instance's Zeteo origin.
mkdir -p "$RUN_DIR"
node -e '
  const fs = require("fs");
  const [template, origin] = process.argv.slice(1);
  const doc = JSON.parse(fs.readFileSync(template, "utf8"));
  const ui = doc.clients.find((c) => c.clientId === "zeteo-ui");
  ui.redirectUris = [`${origin}/callback`];
  ui.postLogoutRedirectUris = [`${origin}/`];
  console.log(JSON.stringify(doc, null, 2));
' "$DIR/provisioning/clients.json" "http://localhost:$ZETEO_PORT" >"$RUN_DIR/clients.json"

# --- Image and stack --------------------------------------------------------
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  log "Building Zeteo's image from this checkout (a few minutes the first time)"
  docker build -f "$ROOT/docker/Dockerfile" -t "${ZETEO_IMAGE:-zeteo:local-instance}" "$ROOT"
fi

log "Starting Tereo on $TEREO_PORT and Zeteo on $ZETEO_PORT"
if ! "${COMPOSE[@]}" up --detach --wait --wait-timeout 300 --remove-orphans; then
  "${COMPOSE[@]}" ps -a >&2 || true
  "${COMPOSE[@]}" logs --no-color --tail 60 tereo zeteo >&2 || true
  die "the instance did not start; the logs above say why (a port in use: change it in local-instance/.env)"
fi

# --- Tereo's first admin ----------------------------------------------------
TEREO="http://localhost:$TEREO_PORT"
if curl -fsS "$TEREO/v1/setup/status" | grep -q '"setupComplete":false'; then
  log "Creating Tereo's first admin, $(envval ADMIN_EMAIL)"
  body="$(ADMIN_EMAIL="$(envval ADMIN_EMAIL)" ADMIN_PASSWORD="$(envval ADMIN_PASSWORD)" \
    SETUP_TOKEN="$(envval SETUP_TOKEN)" node -e '
    const e = process.env;
    console.log(JSON.stringify({
      token: e.SETUP_TOKEN,
      admin: { email: e.ADMIN_EMAIL, name: "Admin", password: e.ADMIN_PASSWORD },
      organization: { name: "Local", slug: "local", code: "LOCAL" },
    }));
  ')"
  status="$(curl -sS -o "$RUN_DIR/setup-response.json" -w '%{http_code}' \
    -X POST "$TEREO/v1/setup" -H 'Content-Type: application/json' --data-binary @- <<<"$body")"
  if [[ "$status" != "201" ]]; then
    cat "$RUN_DIR/setup-response.json" >&2
    die "Tereo's setup answered $status"
  fi
  rm -f "$RUN_DIR/setup-response.json"
fi

print_access

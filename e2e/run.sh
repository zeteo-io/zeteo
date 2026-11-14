#!/usr/bin/env bash
# One end-to-end run of zeteo against a real Tereo. From the repo root:
#
#   e2e/run.sh                     # or: npm run test:e2e
#   KEEP=1 e2e/run.sh              # leave the stack running afterwards
#   e2e/run.sh down                # tear down a stack left by KEEP=1
#
# Tereo is a released image, TEREO_IMAGE (default
# ghcr.io/tereo-io/tereo:0.8.1), pulled when missing. zeteo's image is built
# from this checkout as zeteo:e2e (ZETEO_IMAGE).
#
# Everything runs in the compose project zeteo-e2e on free host ports bound to
# 127.0.0.1. Secrets and the source's certificates are generated for the run
# and removed with the containers, networks and volumes at the end, pass or
# fail, unless KEEP=1. Extra arguments are passed to vitest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/e2e"
PROJECT=zeteo-e2e
ENV_FILE="$E2E/.env.run"
CERTS="$E2E/certs"
COMPOSE=(docker compose -p "$PROJECT" -f "$E2E/docker-compose.yml" --env-file "$ENV_FILE")

log() { printf '\n==> %s\n' "$*" >&2; }

# Removes the project's containers, networks and volumes, then the run's
# certificates and env file. Without the env file (deleted by hand, or a run
# that stopped early), the compose file is still used, with placeholders for
# the values it requires, so its named volumes are found and removed. The env
# file is kept when `down` fails, so it can be run again.
teardown() {
  local env_file="$ENV_FILE" placeholder=""
  if [[ ! -f "$ENV_FILE" ]]; then
    placeholder="$(mktemp)"
    grep -o '\${[A-Z0-9_]*:?}' "$E2E/docker-compose.yml" | sort -u |
      sed -E 's/^\$\{([A-Z0-9_]+):\?\}$/\1=1/' >"$placeholder"
    env_file="$placeholder"
  fi
  local ok=0
  docker compose -p "$PROJECT" -f "$E2E/docker-compose.yml" --env-file "$env_file" \
    down --volumes --remove-orphans --timeout 5 >&2 || ok=$?
  [[ -n "$placeholder" ]] && rm -f "$placeholder"
  if [[ $ok -ne 0 ]]; then
    echo "Tearing down $PROJECT failed; e2e/run.sh down tries again" >&2
    return $ok
  fi
  rm -rf "$CERTS" "$ENV_FILE"
}

if [[ "${1:-}" == "down" ]]; then
  teardown
  exit $?
fi

if docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | grep -q . ||
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | grep -q .; then
  echo "Containers or volumes of $PROJECT exist from an earlier run; remove them with: e2e/run.sh down" >&2
  exit 1
fi

for tool in docker node npx openssl; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

STARTED=$SECONDS

# Before any image or container, so a build failure fails fast.
log "Building @zeteo-io/sdk for the SDK's cases"
(cd "$ROOT" && npx nx run @zeteo-io/sdk:build) >&2

# --- Images --------------------------------------------------------------
TEREO_IMAGE="${TEREO_IMAGE:-ghcr.io/tereo-io/tereo:0.8.1}"
if ! docker image inspect "$TEREO_IMAGE" >/dev/null 2>&1; then
  log "Pulling $TEREO_IMAGE"
  if ! docker pull "$TEREO_IMAGE" >&2; then
    echo "The run needs the Tereo image $TEREO_IMAGE, which could not be pulled." >&2
    echo "Check the tag and your access to its registry, or set TEREO_IMAGE to a released image you have." >&2
    exit 1
  fi
fi
log "Tereo image: $TEREO_IMAGE"

ZETEO_IMAGE="${ZETEO_IMAGE:-zeteo:e2e}"
if [[ "${SKIP_ZETEO_BUILD:-}" != "1" ]]; then
  log "Building $ZETEO_IMAGE from this checkout"
  docker build -f "$ROOT/docker/Dockerfile" -t "$ZETEO_IMAGE" "$ROOT" >&2
fi

if [[ "${KEEP:-}" != "1" ]]; then
  trap teardown EXIT
fi

# --- Secrets, ports, certificates -----------------------------------------
b64url() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }
hex() { openssl rand -hex "$1"; }

# Free ports on 127.0.0.1, held together so they differ, then released.
read -r TEREO_PORT ZETEO_PORT ZETEO_CA_PORT < <(node -e '
  const net = require("net");
  const servers = [0, 1, 2].map(() => net.createServer());
  Promise.all(servers.map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))))
    .then(() => {
      console.log(servers.map((s) => s.address().port).join(" "));
      servers.forEach((s) => s.close());
    });
')

log "Generating the source's certificates"
rm -rf "$CERTS" && mkdir -p "$CERTS"
openssl req -x509 -new -nodes -newkey rsa:2048 -days 2 \
  -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" -subj "/CN=zeteo e2e CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -new -nodes -newkey rsa:2048 \
  -keyout "$CERTS/server.key" -out "$CERTS/server.csr" -subj "/CN=source-pg" 2>/dev/null
printf '%s\n' \
  "basicConstraints=CA:FALSE" \
  "keyUsage=critical,digitalSignature,keyEncipherment" \
  "extendedKeyUsage=serverAuth" \
  "subjectAltName=DNS:source-pg" >"$CERTS/server.ext"
openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" \
  -CAcreateserial -days 2 -extfile "$CERTS/server.ext" -out "$CERTS/server.crt" 2>/dev/null
rm -f "$CERTS/ca.key" "$CERTS/server.csr" "$CERTS/server.ext" "$CERTS/ca.srl"
# The postgres image copies the key with its own ownership; it only has to be readable here.
chmod 0644 "$CERTS/server.key"

# Throwaway values for this run only.
cat >"$ENV_FILE" <<EOF
TEREO_IMAGE=$TEREO_IMAGE
ZETEO_IMAGE=$ZETEO_IMAGE
E2E_TEREO_PORT=$TEREO_PORT
E2E_ZETEO_PORT=$ZETEO_PORT
E2E_ZETEO_CA_PORT=$ZETEO_CA_PORT
E2E_SETUP_TOKEN=$(hex 16)
E2E_ZETEO_CLIENT_SECRET=tereo_sk_$(b64url 32)
E2E_WEB_CLIENT_SECRET=tereo_sk_$(b64url 32)
E2E_APP_CLIENT_SECRET=tereo_sk_$(b64url 32)
E2E_ZETEO_MASTER_KEY=$(b64url 32)
E2E_REQUEST_HANDLER_KEY=$(hex 32)
E2E_SOURCE_READER_PASSWORD=$(hex 16)
E2E_USER_PASSWORD=E2e-$(hex 12)-Pw!
EOF
chmod 0600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --- Stack ------------------------------------------------------------------
log "Starting the stack (Tereo on $TEREO_PORT, zeteo on $ZETEO_PORT and $ZETEO_CA_PORT)"
if ! "${COMPOSE[@]}" up --detach --wait --wait-timeout 300 tereo zeteo zeteo-ca >&2; then
  "${COMPOSE[@]}" ps -a >&2 || true
  "${COMPOSE[@]}" logs --no-color --tail 80 >&2 || true
  exit 1
fi
STACK_READY=$SECONDS

# --- Tests ------------------------------------------------------------------
export E2E_TEREO_URL="http://127.0.0.1:$TEREO_PORT"
export E2E_ZETEO_URL="http://127.0.0.1:$ZETEO_PORT"
export E2E_ZETEO_CA_URL="http://127.0.0.1:$ZETEO_CA_PORT"
export E2E_CA_CERT_PATH="$CERTS/ca.crt"
E2E_COMPOSE_ARGS="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- \
  -p "$PROJECT" -f "$E2E/docker-compose.yml" --env-file "$ENV_FILE")"
export E2E_COMPOSE_ARGS

log "Running the tests"
status=0
(cd "$ROOT" && npx vitest run --config e2e/vitest.config.ts "$@") || status=$?

if [[ $status -ne 0 ]]; then
  log "Tests failed; the last log lines of Tereo and zeteo"
  "${COMPOSE[@]}" logs --no-color --tail 60 tereo zeteo zeteo-ca >&2 || true
fi
log "Stack up in $((STACK_READY - STARTED)) s; whole run $((SECONDS - STARTED)) s"
if [[ "${KEEP:-}" == "1" ]]; then
  log "KEEP=1: the stack is still running (Tereo $E2E_TEREO_URL, zeteo $E2E_ZETEO_URL); e2e/run.sh down removes it"
fi
exit $status

#!/usr/bin/env bash
# Builds the image, then checks it end to end against a local Docker engine, and removes
# everything it created except the image:
#   1. the image: user 1001, no setup code in its config or history, no dev dependencies
#   2. one app container on a new named volume: healthy, id 1001, migrations applied,
#      the wizard claimed through its API
#   3. SIGTERM: a clean exit within the grace period and an intact database file
#   4. a new container on the same volume: the workspace and its token are still there,
#      and the backup command writes a copy and refuses to overwrite it
#   5. the compose stack with Caddy in front (DOMAIN=localhost, internal certificate):
#      only Caddy published, on 127.0.0.1, and the wizard claimed through Caddy with the
#      same-origin check still enforced
# Ports are published on 127.0.0.1 only. Real certificate issuance is not exercised.
#
# Usage: bash deploy/test-container.sh   (env: IMAGE, APP_PORT, HTTPS_PORT, TEST_TMP)
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/.."
IMAGE="${IMAGE:-demo-platform:dev}"
APP_PORT="${APP_PORT:-13000}"
HTTPS_PORT="${HTTPS_PORT:-18443}"
RUN_ID="dptest$$"
VOLUME="${RUN_ID}-data"
APP1="${RUN_ID}-app1"
APP2="${RUN_ID}-app2"
APP3="${RUN_ID}-app3"
STACK="${RUN_ID}-stack"

SETUP_CODE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BASE="http://127.0.0.1:${APP_PORT}"
FAILS=0

# A path Docker on this host understands (Windows form under Git Bash).
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
# Also handed to native Windows tools (curl, docker) under Git Bash, so in host form.
# mktemp runs on its own line so that set -e stops the script if it fails.
TMP_DIR="$(mktemp -d "${TEST_TMP:-${TMPDIR:-/tmp}}/dp-container-XXXXXX")"
WORK="$(host_path "$TMP_DIR")"
case "$WORK" in
  "" | / | ?: | ?:/) echo "refusing to run: no usable temporary folder" >&2; exit 1 ;;
esac

# rm -rf that refuses an empty path, the root of a drive and anything outside $WORK.
safe_rm() {
  local p
  for p in "$@"; do
    case "$p" in
      "" | / | ?: | ?:/ | */..* ) echo "refusing to remove '$p'" >&2; return 1 ;;
    esac
    case "$p" in
      "$WORK" | "$WORK"/*) rm -rf -- "$p" ;;
      *) echo "refusing to remove '$p' outside the test folder" >&2; return 1 ;;
    esac
  done
}

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

cleanup() {
  set +e
  docker rm -f "$APP1" "$APP2" "$APP3" >/dev/null 2>&1
  if [ -f "$WORK/stack/docker-compose.yml" ]; then
    docker compose -p "$STACK" --project-directory "$(host_path "$WORK/stack")" \
      -f "$(host_path "$WORK/stack/docker-compose.yml")" -f "$(host_path "$WORK/stack/docker-compose.test.yml")" \
      down -v --remove-orphans >/dev/null 2>&1
  fi
  docker volume rm "$VOLUME" >/dev/null 2>&1
  # The stack's data folder is written by id 1001 inside the VM; remove it from a container.
  if [ -d "$WORK/stack" ]; then
    docker run --rm --user 0 --entrypoint sh -v "$(host_path "$WORK/stack"):/w" "$IMAGE" -c 'rm -rf /w/data /w/caddy-data /w/caddy-config' >/dev/null 2>&1
  fi
  safe_rm "$WORK"
}
trap cleanup EXIT

wait_healthy() { # container name
  local i status
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && return 1
    sleep 1
  done
  return 1
}

# status <method> <url> [curl args...]: prints the HTTP status, the body goes to $WORK/body.
status() { local m="$1" u="$2"; shift 2; curl -s -o "$WORK/body" -w '%{http_code}' -X "$m" "$@" "$u"; }
body_has() { grep -q -- "$1" "$WORK/body"; }

sql() { # container, query: prints JSON rows read with node:sqlite inside the container
  docker exec "$1" node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/db.sqlite");console.log(JSON.stringify(d.prepare(process.argv[1]).all()));d.close()' "$2"
}

echo "== build"
docker build -q -t "$IMAGE" . >/dev/null
docker image ls "$IMAGE" --format '{{.Repository}}:{{.Tag}} {{.Size}}'

echo "== 1. the image"
check "runs as user 1001" test "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = "1001:1001"
check "declares /data as a volume" sh -c "docker image inspect -f '{{json .Config.Volumes}}' '$IMAGE' | grep -q '\"/data\"'"
check "has a health check" sh -c "docker image inspect -f '{{json .Config.Healthcheck}}' '$IMAGE' | grep -q healthz"
check "no SETUP_CODE in the image config" sh -c "! docker image inspect -f '{{json .Config.Env}}' '$IMAGE' | grep -qi setup_code"
check "no SETUP_CODE in the layer history" sh -c "! docker history --no-trunc --format '{{.CreatedBy}}' '$IMAGE' | grep -qi setup_code"
check "no .env, sqlite, test or source files in /app" sh -c "! docker run --rm --entrypoint sh '$IMAGE' -c 'find /app -path /app/node_modules -prune -o \( -name \".env*\" -o -name \"*.sqlite*\" -o -name \"*.ts\" -o -name test \) -print' | grep -q ."
check "no npm, npx, bundled packages or C headers" docker run --rm --entrypoint sh "$IMAGE" -c '! command -v npm && ! command -v npx && [ ! -e /usr/local/lib/node_modules ] && [ ! -e /usr/local/include ]'
check "only production dependencies" test "$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/node_modules | grep -v "^\." | tr "\n" " "')" = "@hono hono "

echo "== 2. one container on a named volume"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$APP1" -e SETUP_CODE="$SETUP_CODE" -v "$VOLUME:/data" -p "127.0.0.1:${APP_PORT}:3000" "$IMAGE" >/dev/null
check "turns healthy" wait_healthy "$APP1"
check "/healthz answers 200 ok" sh -c "[ \"\$(curl -s '$BASE/healthz')\" = '{\"ok\":true}' ]"
check "process runs as id 1001" test "$(docker exec "$APP1" id -u)" = "1001"
check "published on 127.0.0.1 only" sh -c "docker port '$APP1' 3000/tcp | grep -qx '127.0.0.1:${APP_PORT}'"
check "migrations applied on start" sh -c "docker exec '$APP1' node -e 'const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/db.sqlite\");const r=d.prepare(\"SELECT name FROM _migrations\").all().map(x=>x.name);process.exit(r.includes(\"0001_init.sql\")?0:1)'"
check "the wizard page opens on /setup" test "$(status GET "$BASE/setup")" = "200"
check "a cross-origin claim is refused" test "$(status POST "$BASE/setup/claim" -H 'content-type: application/json' -H 'origin: https://elsewhere.example' --data "{\"code\":\"$SETUP_CODE\",\"workspace\":\"Volume Test\",\"email\":\"owner@example.com\"}")" = "403"
check "the claim creates the workspace" test "$(status POST "$BASE/setup/claim" -H 'content-type: application/json' -H "origin: $BASE" --data "{\"code\":\"$SETUP_CODE\",\"workspace\":\"Volume Test\",\"email\":\"owner@example.com\"}")" = "201"
TOKEN="$(sed -n 's/.*"token":"\(dp_[0-9a-f]\{40\}\)".*/\1/p' "$WORK/body")"
check "the claim returned a token" test -n "$TOKEN"
check "app process umask is 0077" sh -c "docker exec '$APP1' grep -qx 'Umask:[[:space:]]*0077' /proc/1/status"
check "db.sqlite and its WAL are mode 600" test "$(docker exec "$APP1" stat -c '%a' /data/db.sqlite /data/db.sqlite-wal | tr -d '\r' | tr '\n' ' ')" = "600 600 "
check "the token works" test "$(status GET "$BASE/api/v1/setup/connected" -H "authorization: Bearer $TOKEN")" = "200"
check "no log line holds the setup code or the token" sh -c "! docker logs '$APP1' 2>&1 | grep -qE '$SETUP_CODE|${TOKEN:-none}'"

echo "== 3. SIGTERM"
START=$(date +%s)
docker stop -t 10 "$APP1" >/dev/null
ELAPSED=$(( $(date +%s) - START ))
check "stopped within the grace period (${ELAPSED}s)" test "$ELAPSED" -lt 9
check "exit code 0" test "$(docker inspect -f '{{.State.ExitCode}}' "$APP1")" = "0"
check "logged a clean stop" sh -c "docker logs '$APP1' 2>&1 | grep -qx stopped"
INTEGRITY="$(docker run --rm -v "$VOLUME:/data" --entrypoint sh "$IMAGE" -c 'ls /data; node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/db.sqlite\",{readOnly:true});console.log(d.prepare(\"PRAGMA integrity_check\").get().integrity_check)"')"
check "database intact after stop" sh -c "printf '%s' '$INTEGRITY' | grep -qx ok"
check "WAL checkpointed into db.sqlite (no -wal file left)" sh -c "! printf '%s' '$INTEGRITY' | grep -q 'db.sqlite-wal'"
docker rm "$APP1" >/dev/null

echo "== 4. a new container on the same volume"
docker run -d --name "$APP2" -e SETUP_CODE="$SETUP_CODE" -v "$VOLUME:/data" -p "127.0.0.1:${APP_PORT}:3000" "$IMAGE" >/dev/null
check "turns healthy" wait_healthy "$APP2"
check "setup is closed: the workspace survived" test "$(status GET "$BASE/setup")" = "404"
check "the token from before still works" test "$(status GET "$BASE/api/v1/setup/connected" -H "authorization: Bearer $TOKEN")" = "200"
has_workspace() { sql "$APP2" "SELECT name FROM workspace" | grep -q 'Volume Test'; }
check "the workspace row is there" has_workspace
check "backup writes a copy" docker exec "$APP2" node dist/node/backup.js /data/backup-test.sqlite
check "the backup copy is mode 600" test "$(docker exec "$APP2" stat -c '%a' /data/backup-test.sqlite | tr -d '\r')" = "600"
check "backup refuses to overwrite it" sh -c "! docker exec '$APP2' node dist/node/backup.js /data/backup-test.sqlite 2>/dev/null"
docker rm -f "$APP2" >/dev/null

echo "== 4b. a data folder the app user cannot write"
# A tmpfs owned by root with mode 755, as Docker leaves a folder it created itself.
docker run --name "$APP3" --mount type=tmpfs,destination=/data,tmpfs-mode=0755 "$IMAGE" >/dev/null 2>&1 || true
check "exits non-zero" sh -c "[ \"\$(docker inspect -f '{{.State.ExitCode}}' '$APP3')\" != 0 ]"
docker logs "$APP3" >"$WORK/app3.log" 2>&1 || true
check "one log line naming /data and uid 1001" sh -c "[ \"\$(grep -c . '$WORK/app3.log')\" = 1 ] && grep -q '/data' '$WORK/app3.log' && grep -q 'uid 1001' '$WORK/app3.log'"
check "no stack trace" sh -c "! grep -qE '^[[:space:]]+at ' '$WORK/app3.log'"
docker rm -f "$APP3" >/dev/null

echo "== 4c. the real Caddyfile"
CADDY_IMAGE="$(grep -o 'caddy@sha256:[0-9a-f]\{64\}' deploy/docker-compose.yml)"
docker run --rm -e DOMAIN=tours.example.com -e ACME_EMAIL=admin@example.com -v "$(host_path "$PWD/deploy/caddy"):/etc/caddy:ro" "$CADDY_IMAGE" caddy adapt --config /etc/caddy/Caddyfile >"$WORK/caddy.json" 2>/dev/null || true
check "adapts, with the domain as the site" grep -q '"tours.example.com"' "$WORK/caddy.json"
check "sends HSTS with max-age=604800" sh -c "grep -q 'Strict-Transport-Security' '$WORK/caddy.json' && grep -q 'max-age=604800' '$WORK/caddy.json'"
check "HSTS has no preload or includeSubDomains" sh -c "! grep -qiE 'preload|includeSubDomains' '$WORK/caddy.json'"

echo "== 5. the compose stack behind Caddy"
mkdir -p "$WORK/stack/data"
cp deploy/docker-compose.yml deploy/test/docker-compose.test.yml "$WORK/stack/"
cp -r deploy/caddy "$WORK/stack/caddy"
cp -r deploy/test/caddy "$WORK/stack/caddy-test"
cat >"$WORK/stack/.env" <<EOF
DOMAIN=localhost
ACME_EMAIL=admin@example.com
DATA_DIR=$(host_path "$WORK/stack/data")
APP_IMAGE=$IMAGE
SETUP_CODE=$SETUP_CODE
EOF
export TEST_HTTPS_PORT="$HTTPS_PORT"
COMPOSE=(docker compose -p "$STACK" --project-directory "$(host_path "$WORK/stack")" -f "$(host_path "$WORK/stack/docker-compose.yml")" -f "$(host_path "$WORK/stack/docker-compose.test.yml")")
# A missing data folder: compose must refuse rather than create it owned by root. The
# path is a Linux path on the engine's own machine, as on a server; Docker Desktop
# creates any missing folder shared from Windows itself, whatever the compose file says.
MISSING="/tmp/${RUN_ID}-missing"
if DATA_DIR="$MISSING" "${COMPOSE[@]}" up -d app >"$WORK/missing.log" 2>&1; then MISSING_UP=started; else MISSING_UP=refused; fi
check "a missing data folder is refused" sh -c "[ '$MISSING_UP' = refused ] && grep -q 'does not exist' '$WORK/missing.log'"
check "and is not created" docker run --rm -v /tmp:/enginetmp:ro --entrypoint sh "$IMAGE" -c "[ ! -e '/enginetmp/${RUN_ID}-missing' ]"
"${COMPOSE[@]}" down >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait --wait-timeout 90 >/dev/null 2>&1 || true
APP_C="$("${COMPOSE[@]}" ps -q app)"
CADDY_C="$("${COMPOSE[@]}" ps -q caddy)"
check "app healthy in the stack" wait_healthy "$APP_C"
check "app publishes no port" test -z "$(docker port "$APP_C")"
check "app logs rotate (10m x 3)" sh -c "docker inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config \"max-size\"}} {{index .HostConfig.LogConfig.Config \"max-file\"}}' '$APP_C' | grep -qx 'json-file 10m 3'"
check "caddy logs rotate (10m x 3)" sh -c "docker inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config \"max-size\"}} {{index .HostConfig.LogConfig.Config \"max-file\"}}' '$CADDY_C' | grep -qx 'json-file 10m 3'"
check "only Caddy's HTTPS port, on 127.0.0.1" test "$(docker port "$CADDY_C" | tr -d '\r')" = "443/tcp -> 127.0.0.1:${HTTPS_PORT}"
FRONT="https://localhost:${HTTPS_PORT}"
CURL_TLS=(-k --resolve "localhost:${HTTPS_PORT}:127.0.0.1")
ok=""; for _ in $(seq 1 30); do [ "$(status GET "$FRONT/healthz" "${CURL_TLS[@]}")" = "200" ] && { ok=1; break; }; sleep 1; done
check "/healthz through Caddy over HTTPS" test -n "$ok"
check "no HSTS on the localhost test site" sh -c "! curl -sI ${CURL_TLS[*]} '$FRONT/healthz' | grep -qi strict-transport-security"
check "the wizard page through Caddy" test "$(status GET "$FRONT/setup" "${CURL_TLS[@]}")" = "200"
issuer_is_caddy() { openssl s_client -connect "127.0.0.1:${HTTPS_PORT}" -servername localhost </dev/null 2>/dev/null | openssl x509 -noout -issuer | grep -q 'Caddy Local Authority'; }
if command -v openssl >/dev/null 2>&1; then
  check "the certificate is from Caddy's internal authority" issuer_is_caddy
else
  echo "SKIP  certificate issuer (no openssl)"
fi
check "cross-origin claim refused through Caddy" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${CURL_TLS[*]} -X POST -H 'content-type: application/json' -H 'origin: https://elsewhere.example' --data '{\"code\":\"$SETUP_CODE\",\"workspace\":\"Front\",\"email\":\"owner@example.com\"}' '$FRONT/setup/claim')\" = 403 ]"
check "wrong code passes the origin check and is refused" sh -c "[ \"\$(curl -s ${CURL_TLS[*]} -X POST -H 'content-type: application/json' -H 'origin: $FRONT' --data '{\"code\":\"wrong-code-wrong-code\"}' '$FRONT/setup/check')\" = '{\"error\":\"wrong_code\"}' ]"
check "same-origin claim succeeds through Caddy" test "$(status POST "$FRONT/setup/claim" "${CURL_TLS[@]}" -H 'content-type: application/json' -H "origin: $FRONT" --data "{\"code\":\"$SETUP_CODE\",\"workspace\":\"Front\",\"email\":\"owner@example.com\"}")" = "201"
"${COMPOSE[@]}" down -v >/dev/null 2>&1

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi

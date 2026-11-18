#!/usr/bin/env bash
# Tests deploy/install.sh without a server. On the host it starts one disposable
# official Debian 13 container and one Debian 12 container (no network, the deploy
# folder mounted read-only, removed afterwards) and runs this same file inside each as
# root. Inside, install.sh runs against a temporary root (DP_ROOT) with docker, apt-get,
# curl, gpg, snap, dpkg, dpkg-query, ss, getent, ip and sleep replaced by stubs that
# record what would be run; the tests assert on that record and on the files written.
#
# Not covered here, only on a clean server: real package installation, real
# certificate issuance, real ports and a real Cloudflare Tunnel (the tunnel tests use a
# made-up token and the docker stub, so cloudflared never runs here), and a real answer
# from /healthz (the curl stub answers for the two addresses in the sandbox's .env).
#
# Usage: bash deploy/test-install.sh          (env: DEBIAN_IMAGES="debian:13 debian:12")
#        bash deploy/test-install.sh --inside (inside a Debian container, as root)
set -euo pipefail

# ================================================================ host side

if [ "${1:-}" != "--inside" ]; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  cd "$(dirname "$0")"
  host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
  SRC="$(host_path "$PWD")"
  counts() { printf 'containers=%s volumes=%s networks=%s' "$(docker ps -aq | wc -l | tr -d ' ')" "$(docker volume ls -q | wc -l | tr -d ' ')" "$(docker network ls -q | wc -l | tr -d ' ')"; }
  echo "Docker before: $(counts)"
  status=0
  for image in ${DEBIAN_IMAGES:-debian:13 debian:12}; do
    echo
    echo "######## $image"
    # --init: a real PID 1 that passes Ctrl-C on, so an interrupted run stops.
    docker run --rm --init --network none --user 0 -v "$SRC:/src:ro" "$image" bash /src/test-install.sh --inside || status=1
  done
  echo
  echo "Docker after:  $(counts)"
  exit "$status"
fi

# ================================================================ inside the container

[ "$(id -u)" = 0 ] || { echo "run inside a container as root" >&2; exit 1; }
SCRIPT=/src/install.sh
# shellcheck source=/dev/null
. /etc/os-release
OS_LINE="$PRETTY_NAME"
CODENAME="$VERSION_CODENAME"
DEBIAN_MAJOR="$VERSION_ID"
WORK="$(mktemp -d /tmp/dp-install-test.XXXXXX)"
DOMAIN=tours.example.com
EMAIL=admin@example.com
# The first answer, an empty line, takes the default of the first question: direct mode.
ANSWERS="
$DOMAIN
$EMAIL

"
# Made-up tokens of the right shape; they name no tunnel.
TOK="eyJhIjoi$(printf 'ZHVtbXk%.0s' {1..25})"
TOK2="eyJhIjoi$(printf 'b3RoZXI%.0s' {1..25})"
TUNNEL_ANSWERS="$DOMAIN
$TOK

"
DOCKER_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# The second address of a two-address install, and an address of this server (the ip
# stub's), which makes a name resolve here.
APP=app.example.com
HERE=203.0.113.10
# The Caddyfiles of version 0.1.3, by checksum: an install without a second address
# still writes exactly these bytes.
CADDYFILE_0_1_3=0f121757a027ffd30a0154a22501f6dcfa5b18a3eeff2d8735092098cb0ce001
TUNNEL_CADDYFILE_0_1_3=fc5e331bb4f60c0a465550aef5f72fafa9801e7b240c180d7d8b3ff581d2c041
PASSES=0
FAILS=0

# ---------------------------------------------------------------- per-test sandbox

# Sets T (test folder), R (the DP_ROOT), LOG (stub record), STATE (stub state).
new_sandbox() {
  T="$(mktemp -d "$WORK/t.XXXXXX")"
  R="$T/root"
  LOG="$T/log"
  STATE="$T/state"
  mkdir -p "$R/etc/apt/sources.list.d" "$T/bin" "$STATE"
  : >"$LOG"
  cp /etc/os-release "$R/etc/os-release"
  write_stubs "$T/bin"
  INST="$R/opt/demo-platform"
  DATA="$INST/data"
  STUB_DATA="$DATA"
}

write_stubs() {
  local b="$1"
  cat >"$b/docker" <<'EOF'
#!/bin/bash
printf 'docker %s\n' "$*" >>"$STUB_LOG"
args=" $* "
installed() { [ "${STUB_DOCKER_MISSING:-0}" != 1 ] || [ -e "$STUB_STATE/docker-installed" ]; }
if [[ "$args" == " compose version"* ]]; then
  installed || exit 1
  if [[ "$args" == *" --short "* ]]; then echo "${STUB_COMPOSE_VERSION:-5.0.0}"; else echo "Docker Compose version v${STUB_COMPOSE_VERSION:-5.0.0}"; fi
  exit 0
fi
installed || { echo "docker: command not found" >&2; exit 127; }
# Like Compose, every command that reads the tunnel stack file fails while TUNNEL_TOKEN
# has no value in its environment or in .env (the file's ${TUNNEL_TOKEN:?...}).
if [[ "$args" == *" compose "* ]]; then
  cf=""; pd=""; prev=""
  for a in "$@"; do [ "$prev" != "-f" ] || cf="$a"; [ "$prev" != "--project-directory" ] || pd="$a"; prev="$a"; done
  if [ -n "$cf" ] && grep -q 'TUNNEL_TOKEN:?' "$cf" 2>/dev/null; then
    tok="${TUNNEL_TOKEN:-$(sed -n 's/^TUNNEL_TOKEN=//p' "$pd/.env" 2>/dev/null | tail -n 1)}"
    [ -n "$tok" ] || { echo "required variable TUNNEL_TOKEN is missing a value: TUNNEL_TOKEN is not set in .env" >&2; exit 1; }
  fi
fi
case "$args" in
  " info "*)
    [ "${STUB_DAEMON_DOWN:-0}" != 1 ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    echo "Server Version: 29.0.0"; exit 0 ;;
  " image inspect "*)
    case "${STUB_IMAGE:-local}" in
      local) echo 0 ;;
      pulled) echo 1 ;;
      missing) [ -e "$STUB_STATE/pulled" ] || { echo "Error: No such image" >&2; exit 1; }; echo 1 ;;
    esac
    exit 0 ;;
  " pull "*)
    [ "${STUB_PULL_OK:-0}" = 1 ] || { echo "pull access denied" >&2; exit 1; }
    touch "$STUB_STATE/pulled"; exit 0 ;;
esac
case "$args" in
  *" config --quiet "*)
    [ "${STUB_FAIL_CONFIG:-0}" != 1 ] || { echo "the compose file is not valid" >&2; exit 1; } ;;
  *" config "*)
    # Like Compose, prints the stack file as it reads it, values filled in from its own
    # environment and then .env, secrets included. Only what the tests look at is
    # modelled: the app's environment (in direct mode with every line of .env, as
    # env_file gives it), and the token in cloudflared's. STUB_RENDER=wrong: a Compose
    # that does not fill in TOURS_HOST the way the stack file means it.
    val() { if [ -n "${!1+set}" ]; then printf '%s' "${!1}"; else sed -n "s/^$1=//p" "$pd/.env" 2>/dev/null | tail -n 1; fi; }
    yaml() { if [ -n "$1" ]; then printf '%s' "$1"; else printf '""'; fi; }
    d="$(val DOMAIN)"; a="$(val APP_DOMAIN)"
    tours=""; [ -z "$a" ] || tours="$d"
    if [ "${STUB_RENDER:-}" = wrong ]; then if [ -n "$a" ]; then tours="'\${DOMAIN}'"; else tours="'}'"; fi; fi
    printf 'name: demo-platform\nservices:\n  app:\n    environment:\n'
    if grep -q 'TUNNEL_TOKEN:?' "$cf"; then
      printf '      SETUP_CODE: %s\n' "$(val SETUP_CODE)"
    else
      grep -E '^[A-Z_]+=' "$pd/.env" | grep -vE '^(DATA_DIR|TOURS_HOST|APP_HOST)=' | sed 's/^\([A-Z_]*\)=/      \1: /'
    fi
    printf '      APP_HOST: %s\n      DATA_DIR: /data\n      TOURS_HOST: %s\n' "$(yaml "$a")" "$(yaml "$tours")"
    printf '    image: %s\n  caddy:\n    environment:\n      APP_DOMAIN: %s\n      DOMAIN: %s\n' "$(val APP_IMAGE)" "$(yaml "$a")" "$d"
    if grep -q 'TUNNEL_TOKEN:?' "$cf"; then
      printf '  cloudflared:\n    environment:\n      TUNNEL_TOKEN: %s\n' "$(val TUNNEL_TOKEN)"
    fi ;;
  *" up "*)
    n=$(cat "$STUB_STATE/ups" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STUB_STATE/ups"
    # Like Compose, a start takes TUNNEL_TOKEN from its own environment before .env.
    # up-tokens gets the token each start hands to cloudflared, up-env-tokens the one
    # .env held at that moment. Neither file is under the root the tests search.
    envfile=""; prev=""
    for a in "$@"; do [ "$prev" != "--project-directory" ] || envfile="$a/.env"; prev="$a"; done
    in_env="$(sed -n 's/^TUNNEL_TOKEN=//p' "$envfile" 2>/dev/null | tail -n 1)"
    printf '%s\n' "${TUNNEL_TOKEN:-$in_env}" >>"$STUB_STATE/up-tokens"
    printf '%s\n' "$in_env" >>"$STUB_STATE/up-env-tokens"
    # up-names: the two host names as this start's own environment holds them, which
    # Compose would read before .env.
    printf '%s %s\n' "${DOMAIN-unset}" "${APP_DOMAIN-unset}" >>"$STUB_STATE/up-names"
    # STUB_UP_SIGNAL: the run gets that signal during the starts listed in STUB_UP_SIGNAL_ON
    # (default: the first). The first start is cut short by it; a later one finishes.
    if [ -n "${STUB_UP_SIGNAL:-}" ] && [[ " ${STUB_UP_SIGNAL_ON:-1} " == *" $n "* ]]; then
      kill -s "$STUB_UP_SIGNAL" "$PPID"
      [ "$n" != 1 ] || exit 130
    fi
    # Like the real app, a started app writes its database into the data folder.
    # STUB_FAIL_UP=1: the app itself never turns healthy and writes nothing.
    # STUB_FAIL_UP=tunnel: the app is healthy and has written, then cloudflared fails.
    app_writes() { [ ! -d "$STUB_DATA" ] || [ -e "$STUB_DATA/db.sqlite" ] || { printf 'SQLite format 3 (stub)\n' >"$STUB_DATA/db.sqlite"; chown 1001:1001 "$STUB_DATA/db.sqlite"; }; }
    if [ "${STUB_FAIL_UP:-0}" = 1 ] && [ "$n" = 1 ]; then echo "container app is unhealthy" >&2; exit 1; fi
    if [ "${STUB_FAIL_UP:-0}" = tunnel ] && [ "$n" = 1 ]; then app_writes; echo "container cloudflared is unhealthy" >&2; exit 1; fi
    app_writes
    touch "$STUB_STATE/running" ;;
  *" down "*) rm -f "$STUB_STATE/running" ;;
  *" restart caddy "*) [ "${STUB_FAIL_RESTART:-0}" != 1 ] || { echo "cannot restart container" >&2; exit 1; } ;;
  *" ps -q "*) [ ! -e "$STUB_STATE/running" ] || echo 0123456789ab ;;
  *" logs "*)
    if [[ "$args" == *" cloudflared "* ]]; then printf '%s\n' "${STUB_CF_LOG:-cloudflared  | stub log line}"; else echo "app  | stub log line"; fi ;;
  *" exec -T app node dist/node/backup.js "*)
    [ "${STUB_FAIL_EXEC:-0}" != 1 ] || { echo "service app is not running" >&2; exit 1; }
    target="${*: -1}"; printf 'SQLite format 3 (stub copy)\n' >"$STUB_DATA/${target#/data/}"; chown 1001:1001 "$STUB_DATA/${target#/data/}" ;;
  *" inspect "*) echo healthy ;;
esac
exit 0
EOF
  cat >"$b/apt-get" <<'EOF'
#!/bin/bash
printf 'apt-get %s\n' "$*" >>"$STUB_LOG"
umask >>"$STUB_STATE/apt-umask"
[[ " $* " != *" docker-ce "* ]] || touch "$STUB_STATE/docker-installed"
exit 0
EOF
  cat >"$b/curl" <<'EOF'
#!/bin/bash
printf 'curl %s\n' "$*" >>"$STUB_LOG"
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" != "-o" ] || out="$a"
  case "$a" in https://*/healthz) url="$a" ;; esac
  prev="$a"
done
# /healthz of an address: what the platform answers when it sees the host it was asked
# on, going by the two names in the sandbox's .env. STUB_HEALTH_TOURS and STUB_HEALTH_APP
# replace the answer of that address; "fail" means no answer at all.
if [ -n "$url" ]; then
  host="${url#https://}"; host="${host%/healthz}"
  envfile="$DP_ROOT/opt/demo-platform/.env"
  role=""
  [ "$host" != "$(sed -n 's/^DOMAIN=//p' "$envfile" 2>/dev/null)" ] || role=tours
  [ "$host" != "$(sed -n 's/^APP_DOMAIN=//p' "$envfile" 2>/dev/null)" ] || role=app
  answer='{"ok":true}'
  [ -z "$role" ] || answer="{\"ok\":true,\"address\":\"$role\"}"
  [ "$role" != tours ] || [ -z "${STUB_HEALTH_TOURS:-}" ] || answer="$STUB_HEALTH_TOURS"
  [ "$role" != app ] || [ -z "${STUB_HEALTH_APP:-}" ] || answer="$STUB_HEALTH_APP"
  [ "$answer" != fail ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
  # STUB_HEALTH_SIGNAL: the run gets that signal while an address is asked. The run is
  # this stub's parent, or that one's parent when the stub was started from a subshell.
  if [ -n "${STUB_HEALTH_SIGNAL:-}" ]; then
    run_pid="$PPID"
    above="$(awk '{print $4}' "/proc/$PPID/stat")"
    if tr '\0' ' ' <"/proc/$above/cmdline" | grep -q '/src/install\.sh'; then run_pid="$above"; fi
    kill -s "$STUB_HEALTH_SIGNAL" "$run_pid"
    exit 143
  fi
  printf '%s' "$answer"
  exit 0
fi
[ -z "$out" ] || printf -- '-----BEGIN PGP PUBLIC KEY BLOCK-----\nstub\n-----END PGP PUBLIC KEY BLOCK-----\n' >"$out"
exit 0
EOF
  cat >"$b/gpg" <<'EOF'
#!/bin/bash
printf 'gpg %s\n' "$*" >>"$STUB_LOG"
echo "pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESC::::::23::0:"
echo "fpr:::::::::${STUB_KEY_FPR:-9DC858229FC7DD38854AE2D88D81803C0EBFCD88}:"
echo "uid:-::::1487792064::B50C::Docker Release (CE deb) <docker@docker.com>::::::::::0:"
echo "sub:-:4096:1:7EA0A9C3F273FCD8:1487788586::::::s::::::23:"
echo "fpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:"
EOF
  cat >"$b/snap" <<'EOF'
#!/bin/bash
if [ "${STUB_SNAP_DOCKER:-0}" = 1 ] && [ "$1 ${2:-}" = "list docker" ]; then echo "docker 28.1.1 3221 latest/stable canonical"; exit 0; fi
exit 1
EOF
  cat >"$b/dpkg" <<'EOF'
#!/bin/bash
[ "$1" = --print-architecture ] && { echo amd64; exit 0; }
exit 1
EOF
  cat >"$b/dpkg-query" <<'EOF'
#!/bin/bash
pkg="${*: -1}"
for c in ${STUB_CONFLICT:-}; do [ "$c" != "$pkg" ] || { echo "ii "; exit 0; }; done
exit 1
EOF
  cat >"$b/ss" <<'EOF'
#!/bin/bash
[ "${STUB_SS_FAIL:-0}" != 1 ] || { echo "Cannot open netlink socket: Permission denied" >&2; exit 1; }
if [ -n "${STUB_PORT_BUSY:-}" ] && [[ "$*" == *"sport = :$STUB_PORT_BUSY"* ]] && [[ "$1" == *t* ]]; then
  echo "LISTEN 0 511 0.0.0.0:$STUB_PORT_BUSY 0.0.0.0:* users:((\"webserver\",pid=4242,fd=6))"
fi
exit 0
EOF
  cat >"$b/getent" <<'EOF'
#!/bin/bash
[ -n "${STUB_RESOLVE:-}" ] || exit 2
# STUB_NO_RESOLVE: names that do not resolve although the others do.
for n in ${STUB_NO_RESOLVE:-}; do [ "$n" != "$2" ] || exit 2; done
for ip in $STUB_RESOLVE; do echo "$ip      STREAM $2"; done
EOF
  cat >"$b/ip" <<'EOF'
#!/bin/bash
for a in ${STUB_LOCAL_IPS:-203.0.113.10}; do
  echo "2: eth0    inet $a/24 brd 203.0.113.255 scope global eth0"
done
EOF
  # The pauses between two tries of an address take no time here.
  cat >"$b/sleep" <<'EOF'
#!/bin/bash
printf 'sleep %s\n' "$*" >>"$STUB_LOG"
exit 0
EOF
  chmod +x "$b"/*
}

# Runs install.sh in the sandbox: install_sh <stdin text> <args...>; sets RC, OUT, ERR.
install_sh() {
  local input="$1"; shift
  OUT="$T/out"; ERR="$T/err"
  set +e
  printf '%s' "$input" | env PATH="$T/bin:$PATH" DP_ROOT="$R" STUB_LOG="$LOG" STUB_STATE="$STATE" \
    STUB_DATA="$STUB_DATA" bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}

# Sources install.sh's functions only, against the sandbox root, in the current shell.
# shellcheck source=deploy/install.sh
load_functions() { DP_ROOT="$R"; DP_SOURCE_ONLY=1; . "$SCRIPT"; set +e; }

# Every path under the root with its type, mode and owner, and every file's checksum.
snapshot() {
  (cd "$R" && find . -printf '%y %m %u:%g %p\n' | sort && find . -type f -exec sha256sum {} + | sort)
}

fresh_install() { install_sh "$ANSWERS" install --yes; [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "fresh install failed"; }; }
setup_code() { sed -n 's/^SETUP_CODE=//p' "$INST/.env"; }
# A fresh install with the data folder at /srv/<name> (answers given), STUB_DATA set.
install_with_data() {
  STUB_DATA="$R$1"
  install_sh "
$DOMAIN
$EMAIL
$1
" install --yes
  [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "install with data folder $1 failed"; }
}
tunnel_install() { install_sh "$TUNNEL_ANSWERS" install --tunnel --yes; [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "tunnel install failed"; }; }
# A fresh direct install with a second address; both names resolve to this server.
two_install() {
  STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "install with a second address failed"; }
}
tunnel_two_install() {
  install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
  [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "tunnel install with a second address failed"; }
}
# How often /healthz of a host was asked for.
asked() { grep -c -- "^curl .*https://$1/healthz\$" "$LOG" || true; }
sum_of() { sha256sum <"$1" | awk '{print $1}'; }
# The sentence a run prints when an address does not report its own role.
wrong_role() { printf 'https://%s/healthz answered, but the platform does not see it as its %s address. Check DOMAIN and APP_DOMAIN in /opt/demo-platform/.env, and that nothing in front of the platform changes the Host header.' "$1" "$2"; }
# The sentence for an address that answers without naming any role.
old_platform() { printf 'https://%s/healthz answered, but the platform running here is older than two addresses. Run: sudo bash %s update' "$1" "$SCRIPT"; }
# The token appears nowhere in what the run printed or in any stub's command line.
token_not_shown() { ! grep -qF -- "$TOK" "$OUT" "$ERR" "$LOG"; }
# Nor does a piece of either token: its first or last 12 characters.
no_token_part_shown() {
  ! grep -qF -e "${TOK:0:12}" -e "${TOK: -12}" -e "${TOK2:0:12}" -e "${TOK2: -12}" "$OUT" "$ERR" "$LOG"
}
env_token() { sed -n 's/^TUNNEL_TOKEN=//p' "$INST/.env"; }
# The token the last start handed to cloudflared (see the docker stub).
last_up_token() { tail -n 1 "$STATE/up-tokens"; }
forget_starts() { rm -f "$STATE/ups" "$STATE/up-tokens" "$STATE/up-env-tokens"; : >"$LOG"; }
# A mv that, with STUB_MV_SIGNAL set, interrupts the run at the moment the new .env
# would take the old one's place, after noting the mode and owner of the new file.
stub_mv() {
  cat >"$T/bin/mv" <<'EOF'
#!/bin/bash
if [ -n "${STUB_MV_SIGNAL:-}" ] && [[ " $* " == *"/.env.new."* ]]; then
  for a in "$@"; do case "$a" in */.env.new.*) stat -c '%a %u:%g' "$a" >"$STUB_STATE/env-tmp-mode" ;; esac; done
  kill -s "$STUB_MV_SIGNAL" "$PPID"
  exit 1
fi
exec /bin/mv "$@"
EOF
  chmod +x "$T/bin/mv"
}
# A cp that, with STUB_FAIL_RESTORE_CP=1, fails when a replaced file is copied back.
stub_cp() {
  cat >"$T/bin/cp" <<'EOF'
#!/bin/bash
if [ "${STUB_FAIL_RESTORE_CP:-0}" = 1 ] && [[ "${*: -1}" == */.restore.* ]]; then
  echo "cp: error writing '${*: -1}': No space left on device" >&2
  exit 1
fi
exec /bin/cp "$@"
EOF
  chmod +x "$T/bin/cp"
}
# What the last start gave cloudflared is what .env holds.
containers_match_env() { [ "$(last_up_token)" = "$(env_token)" ]; }

die() { printf '      %s\n' "$*"; exit 1; }
expect() { local msg="$1"; shift; "$@" || die "$msg"; }
has() { grep -qF -- "$2" "$1"; }
hasnt() { ! grep -qF -- "$2" "$1"; }
no_recursive_chown() { ! grep -qE 'chown[[:space:]]+-[A-Za-z]*R' "$OUT" "$ERR"; }

run_test() {
  local name="$1"
  if ( set -e; "$name" ) >"$WORK/last" 2>&1; then
    PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$name"
  else
    FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$name"; sed 's/^/      /' "$WORK/last" | tail -n 25
  fi
}

# ---------------------------------------------------------------- pure functions

test_argument_parsing() {
  new_sandbox; load_functions
  parse_args; [ "$COMMAND $DRY_RUN $ASSUME_YES" = "install 0 0" ] || die "defaults"
  parse_args uninstall --delete-data --yes --dry-run
  [ "$COMMAND $DELETE_DATA $ASSUME_YES $DRY_RUN" = "uninstall 1 1 1" ] || die "uninstall flags"
  local bad
  for bad in "--nope" "install update" "install --delete-data" "backup --delete-data" "rm"; do
    # shellcheck disable=SC2086
    (parse_args $bad) >/dev/null 2>&1; [ $? = 2 ] || die "accepted: $bad"
  done
}

test_domain_validation() {
  new_sandbox; load_functions
  local d
  for d in tours.example.com a.io sub-1.example.co.uk xn--bcher-kva.example tutorials.mythic-example.dev; do
    valid_domain "$d" || die "refused good domain $d"
  done
  # shellcheck disable=SC2016 # literal $(id) is the hostile input
  for d in "" localhost example 1.2.3.4 -a.com a-.com a..com .a.com a.com. A.COM "a b.com" "a.com;id" 'a.com$(id)' \
           "a.com/x" "*.example.com" "a_b.example.com" "example.c" "$(printf 'a%.0s' {1..64}).com"; do
    ! valid_domain "$d" || die "accepted bad domain '$d'"
  done
}

test_email_validation() {
  new_sandbox; load_functions
  local e
  for e in admin@example.com first.last+tag@sub.example.org a_b%c-d@example.io; do
    valid_email "$e" || die "refused good email $e"
  done
  for e in "" admin example.com @example.com "admin@" "a@b@example.com" ".a@example.com" "a.@example.com" "a..b@example.com" \
           "a b@example.com" "admin@localhost" "admin@example" '"q"@example.com' "a;id@example.com" "admin@EXAMPLE.COM"; do
    ! valid_email "$e" || die "accepted bad email '$e'"
  done
}

test_data_dir_validation() {
  new_sandbox; load_functions
  local p
  for p in /opt/demo-platform/data /srv/demo-platform /var/lib/demo-platform /mnt/disk1/dp /home/alex/demo-data /opt/new-dedicated; do
    valid_data_dir "$p" || die "refused good folder $p"
  done
  for p in "" / relative/x /etc /etc/dp /usr/local/dp /tmp/dp /proc/x /opt /srv /data /home /home/alex /var /var/lib /var/log \
           /var/dp /var/log/dp /var/cache/dp /root /root/dp /opt/demo-platform /opt/demo-platform/.env \
           /opt/demo-platform/docker-compose.yml /opt/demo-platform/backups /opt/demo-platform/other \
           /opt/demo-platform/caddy-data/x /opt/demo-platform/data/x /a/../etc "/a b" "/a;b" /var/lib/docker/volumes/x; do
    ! valid_data_dir "$p" || die "accepted bad folder '$p'"
  done
}

test_new_data_dir_must_be_new_or_empty() {
  new_sandbox; load_functions
  mkdir -p "$R/opt/other-app" "$R/srv/full" "$R/srv/empty" "$R/srv/real-empty" "$R/etc"
  echo x >"$R/opt/other-app/config"; echo x >"$R/srv/full/file"; echo x >"$R/srv/afile"
  ln -s "$R/etc" "$R/srv/to-etc"; ln -s "$R/srv/real-empty" "$R/srv/link-empty"
  mkdir -p "$INST"; echo x >"$INST/.env"; echo x >"$INST/docker-compose.yml"
  local p
  for p in /opt/other-app /srv/full /srv/afile /srv/to-etc /opt/demo-platform/.env /opt/demo-platform/docker-compose.yml; do
    (check_new_data_dir "$p") >/dev/null 2>&1 && die "accepted existing or unsafe folder $p"
  done
  (check_new_data_dir /srv/empty) >/dev/null 2>&1 || die "refused an empty folder"
  (check_new_data_dir /srv/new/dp) >/dev/null 2>&1 || die "refused a folder that does not exist"
  [ "$(check_new_data_dir /srv/link-empty 2>/dev/null)" = /srv/real-empty ] || die "a link is not recorded as the resolved folder"
  [ "$(check_new_data_dir /opt/demo-platform/data 2>/dev/null)" = /opt/demo-platform/data ] || die "refused the default folder"
  return 0
}

test_path_guard() {
  new_sandbox; load_functions
  mkdir -p "$INST" "$R/etc" "$R/srv/dp"
  ln -s /etc "$INST/link"
  local p
  # With no data folder known yet, only the install folder is allowed.
  DATA_DIR=""; DATA_PATH=""
  for p in "" / relative "$R/etc/passwd" "$INST/../etc/x" "$INST/./x" "$INST/link/passwd" "$R/opt" "$R/srv/dp"; do
    (guard_path "$p") >/dev/null 2>&1 && die "allowed '$p' with no data folder"
  done
  DATA_DIR=/srv/dp; DATA_PATH="$R/srv/dp"
  for p in "$INST" "$INST/.env" "$INST/caddy/Caddyfile" "$DATA_PATH" "$DATA_PATH/drafts/x" "$KEYRING" "$DOCKER_SOURCES"; do
    (guard_path "$p") >/dev/null 2>&1 || die "refused '$p'"
  done
  for p in "$R/srv" "$R/srv/dp2" "$R/etc/apt/keyrings/other.asc" "$INST/link/shadow"; do
    (guard_path "$p") >/dev/null 2>&1 && die "allowed '$p'"
  done
  # A data folder that no longer resolves to itself (a parent became a link) is not trusted.
  mv "$R/srv" "$R/srv-real"; mkdir -p "$R/victim/dp"; ln -s "$R/victim" "$R/srv"
  (guard_path "$DATA_PATH/x") >/dev/null 2>&1 && die "allowed a path through a linked parent"
  (safe_rm_file "$INST") >/dev/null 2>&1 && die "safe_rm_file removed a folder"
  [ -d "$INST" ] || die "install folder gone"
  return 0
}

test_env_file_writing() {
  new_sandbox; load_functions
  mkdir -p "$INST"
  # shellcheck disable=SC2034 # read by the sourced write_env_file
  DOMAIN=tours.example.com ACME_EMAIL=admin@example.com DATA_DIR=/srv/dp DATA_PATH="$R/srv/dp" IMAGE=demo-platform:latest
  write_env_file >/dev/null
  expect ".env mode 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "keys" grep -qx "DOMAIN=tours.example.com" "$INST/.env"
  expect "email" grep -qx "ACME_EMAIL=admin@example.com" "$INST/.env"
  expect "data dir" grep -qx "DATA_DIR=/srv/dp" "$INST/.env"
  expect "image" grep -qx "APP_IMAGE=demo-platform:latest" "$INST/.env"
  expect "setup code is 32 hex" grep -Eqx 'SETUP_CODE=[0-9a-f]{32}' "$INST/.env"
  local before; before="$(sha256sum "$INST/.env")"
  DOMAIN=other.example.com write_env_file >/dev/null
  expect "a second write changes nothing" test "$(sha256sum "$INST/.env")" = "$before"
  expect "no temporary files left" test "$(find "$INST" -name '.env.new.*' | wc -l)" = 0
}

test_embedded_files_match_deploy() {
  new_sandbox; load_functions
  expect "compose file differs from deploy/docker-compose.yml" cmp -s <(compose_file_content) /src/docker-compose.yml
  expect "Caddyfile differs from deploy/caddy/Caddyfile" cmp -s <(caddyfile_content) /src/caddy/Caddyfile
  expect "tunnel compose file differs from deploy/tunnel/docker-compose.yml" cmp -s <(tunnel_compose_file_content) /src/tunnel/docker-compose.yml
  expect "tunnel Caddyfile differs from deploy/tunnel/caddy/Caddyfile" cmp -s <(tunnel_caddyfile_content) /src/tunnel/caddy/Caddyfile
  expect "two-address Caddyfile differs from deploy/caddy/Caddyfile.two" cmp -s <(caddyfile_two_content) /src/caddy/Caddyfile.two
  expect "two-address tunnel Caddyfile differs from deploy/tunnel/caddy/Caddyfile.two" cmp -s <(tunnel_caddyfile_two_content) /src/tunnel/caddy/Caddyfile.two
  # The two-address files are the one-address files with another site address line.
  expect "direct: only the site address line differs" test "$(diff <(caddyfile_content) <(caddyfile_two_content) | grep -c '^[<>]')" = 2
  expect "tunnel: only the site address line differs" test "$(diff <(tunnel_caddyfile_content) <(tunnel_caddyfile_two_content) | grep -c '^[<>]')" = 2
}

test_token_validation() {
  new_sandbox; load_functions
  local t
  for t in "$TOK" "$TOK2" "${TOK}==" "eyJ$(printf 'aB3-_+/%.0s' {1..20})"; do
    valid_token "$t" || die "refused a token-shaped text"
  done
  # shellcheck disable=SC2016 # literal $(id) is the hostile input
  for t in "" eyJ eyJhIjoi "abc${TOK}" "${TOK} x" "${TOK};id" "${TOK}"'$(id)' "cloudflared tunnel run --token $TOK" \
           "$(printf 'A%.0s' {1..180})" "eyJ$(printf 'A%.0s' {1..3000})" "${TOK}==="; do
    ! valid_token "$t" || die "accepted a text that is not a token: '${t:0:40}'"
  done
}

test_mode_flags() {
  new_sandbox; load_functions
  parse_args; [ -z "$MODE_FLAG" ] || die "a mode without a flag"
  parse_args --tunnel; [ "$MODE_FLAG" = tunnel ] || die "--tunnel"
  MODE_FLAG=""; parse_args install --direct; [ "$MODE_FLAG" = direct ] || die "--direct"
  local bad
  NEW_TOKEN=0; parse_args install --new-token; [ "$NEW_TOKEN" = 1 ] || die "--new-token"
  for bad in "--tunnel --direct" "update --tunnel" "status --direct" "backup --tunnel" "uninstall --tunnel" "update --new-token" "status --new-token"; do
    # shellcheck disable=SC2086
    (MODE_FLAG=""; NEW_TOKEN=0; parse_args $bad) >/dev/null 2>&1; [ $? = 2 ] || die "accepted: $bad"
  done
}

# ---------------------------------------------------------------- refusals

test_refuses_non_root() {
  new_sandbox
  # shellcheck disable=SC2016 # the stub's own $1 and $@
  printf '#!/bin/bash\n[ "$1" = -u ] && { echo 1000; exit 0; }\nexec /usr/bin/id "$@"\n' >"$T/bin/id"; chmod +x "$T/bin/id"
  install_sh "$ANSWERS" install
  expect "exit code 1" test "$RC" = 1
  expect "message names root" has "$ERR" "needs root"
  expect "log is empty" test ! -s "$LOG"
  expect "nothing written" test ! -e "$R/opt"
  # Piped into bash, $0 is "bash": the message still names the script.
  set +e
  env PATH="$T/bin:$PATH" DP_ROOT="$R" STUB_LOG="$LOG" STUB_STATE="$STATE" bash -s -- install <"$SCRIPT" >"$OUT" 2>"$ERR"
  set -e
  expect "piped: names install.sh" has "$ERR" "sudo bash install.sh install"
}

test_refuses_non_debian() {
  new_sandbox
  printf 'PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\n' >"$R/etc/os-release"
  install_sh "$ANSWERS" install
  expect "exit code 1" test "$RC" = 1
  expect "message names the system" has "$ERR" "Ubuntu 26.04 LTS"
  expect "message names Debian 13" has "$ERR" "Debian 13"
  expect "log is empty" test ! -s "$LOG"
  expect "nothing written" test ! -e "$R/opt"
  install_sh "$ANSWERS" install --force --dry-run --yes
  expect "--force goes on" test "$RC" = 0
  expect "--force warns" has "$ERR" "because of --force"
}

test_debian_release_notice() {
  new_sandbox
  install_sh "$ANSWERS" install --dry-run --yes
  expect "dry run on $OS_LINE succeeds" test "$RC" = 0
  if [ "$DEBIAN_MAJOR" = 12 ]; then
    expect "Debian 12 gets the notice" has "$ERR" "this is Debian 12 (bookworm)"
  else
    expect "Debian $DEBIAN_MAJOR gets no notice" hasnt "$ERR" "Debian 12"
  fi
}

test_busy_port_refused() {
  new_sandbox
  STUB_PORT_BUSY=443 install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the port and program" has "$ERR" "TCP port 443"
  expect "names the program" has "$ERR" "webserver"
  expect "nothing written" test ! -e "$R/opt"
}

test_ss_error_is_unknown_not_free() {
  new_sandbox
  STUB_SS_FAIL=1 install_sh "$ANSWERS" install --yes
  expect "install goes on" test "$RC" = 0
  expect "warns the ports are unknown" has "$ERR" "could not check port 80"
  expect "does not claim they are free" hasnt "$OUT" "nothing else listens on ports 80 and 443"
}

test_conflicting_packages_refused() {
  new_sandbox
  STUB_DOCKER_MISSING=1 STUB_CONFLICT="docker.io podman-docker" install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the packages" has "$ERR" "docker.io podman-docker"
  expect "no apt-get run" hasnt "$LOG" "apt-get"
}

test_docker_snap_refused() {
  new_sandbox
  STUB_SNAP_DOCKER=1 install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "says snap" has "$ERR" "snap"
  expect "nothing written" test ! -e "$R/opt"
}

test_docker_daemon_must_answer() {
  new_sandbox
  STUB_DAEMON_DOWN=1 install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the daemon" has "$ERR" "daemon"
  expect "nothing written" test ! -e "$R/opt"
}

test_old_compose_refused() {
  new_sandbox
  STUB_COMPOSE_VERSION=2.12.2 install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the versions" has "$ERR" "2.12.2"
  expect "nothing written" test ! -e "$R/opt"
}

test_invalid_answers_are_asked_again() {
  new_sandbox
  STUB_DATA="$R/srv/dp"
  install_sh "
not a domain
TOURS.Example.COM
admin@EXAMPLE.com
/etc/evil
/srv/dp
" install --yes
  expect "succeeds after retries" test "$RC" = 0
  expect "domain lowercased" grep -qx "DOMAIN=$DOMAIN" "$INST/.env"
  expect "email domain lowercased" grep -qx "ACME_EMAIL=admin@example.com" "$INST/.env"
  expect "data folder taken" grep -qx "DATA_DIR=/srv/dp" "$INST/.env"
  expect "data folder created" test -d "$R/srv/dp"
  new_sandbox
  install_sh "
bad
worse
1.2.3.4
" install --yes
  expect "three bad answers stop" test "$RC" = 1
  expect "nothing written" test ! -e "$R/opt"
}

test_existing_folders_refused_as_data() {
  new_sandbox
  mkdir -p "$R/var/lib/dpkg" "$R/home/alex/docs" "$R/srv/full"
  echo keep >"$R/home/alex/docs/thesis"; echo keep >"$R/srv/full/file"
  install_sh "
$DOMAIN
$EMAIL
/var/lib
/home/alex
/srv/full
" install --yes
  expect "three refused folders stop" test "$RC" = 1
  expect "nothing written" test ! -e "$R/opt"
  expect "the folders are untouched" test "$(stat -c '%u' "$R/home/alex")" = 0
  expect "no recursive chown advice" no_recursive_chown
  new_sandbox
  mkdir -p "$R/srv/empty"
  install_with_data /srv/empty
  expect "an empty folder becomes the data folder, owned by 1001, mode 700" test "$(stat -c '%a %u' "$R/srv/empty")" = "700 1001"
}

test_rerun_accepts_only_the_recorded_folder() {
  new_sandbox
  fresh_install
  chown 0:0 "$DATA"
  install_sh "" install
  expect "a wrongly owned folder is reported" has "$ERR" "owned by id 0"
  expect "no recursive chown advice" no_recursive_chown
  sed -i 's|^DATA_DIR=.*|DATA_DIR=/var/lib|' "$INST/.env"
  install_sh "" install
  expect "an edited DATA_DIR of /var/lib is refused" test "$RC" = 1
  sed -i 's|^DATA_DIR=.*|DATA_DIR=/opt/demo-platform/data|' "$INST/.env"
  mv "$DATA" "$R/elsewhere"; ln -s "$R/elsewhere" "$DATA"
  install_sh "" install
  expect "a recorded folder that became a link is refused" test "$RC" = 1
}

test_image_must_exist_before_anything_is_written() {
  new_sandbox
  STUB_IMAGE=missing install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "explains loading an image" has "$ERR" "docker load"
  expect "nothing written" test ! -e "$R/opt"
  expect "no stack started" hasnt "$LOG" " up "
  new_sandbox
  APP_IMAGE=registry.example.com/demo/platform:1.0 STUB_IMAGE=missing STUB_PULL_OK=1 install_sh "$ANSWERS" install --yes
  expect "a pullable image installs" test "$RC" = 0
  expect "it was pulled" has "$LOG" "docker pull registry.example.com/demo/platform:1.0"
}

# ---------------------------------------------------------------- install

test_fresh_install_writes_env_compose_caddyfile() {
  new_sandbox
  fresh_install
  local code; code="$(setup_code)"
  expect ".env is 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "SETUP_CODE is 32 hex" grep -Eqx '[0-9a-f]{32}' <<<"$code"
  expect "install folder is 700 root" test "$(stat -c '%a %u' "$INST")" = "700 0"
  expect "data folder is 700, owned by 1001" test "$(stat -c '%a %u:%g' "$DATA")" = "700 1001:1001"
  expect "compose file is the deploy copy" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
  expect "Caddyfile is the deploy copy" cmp -s "$INST/caddy/Caddyfile" /src/caddy/Caddyfile
  # shellcheck disable=SC2016 # the literal Caddyfile placeholder
  expect "Caddyfile reads the domain and email" has "$INST/caddy/Caddyfile" '{$DOMAIN}'
  expect "compose file validated before use" grep -q 'docker compose --project-name demo-platform --project-directory .* config --quiet' "$LOG"
  expect "stack started with a health wait" grep -q 'compose .* up -d --pull missing --wait --wait-timeout 120' "$LOG"
  expect "daemon checked" grep -qx 'docker info' "$LOG"
  expect "Docker present: no apt-get" hasnt "$LOG" "apt-get"
  expect "address printed" has "$OUT" "https://$DOMAIN/setup"
  expect "code printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "code not on stderr" hasnt "$ERR" "$code"
  expect "code never on a stub's command line" hasnt "$LOG" "$code"
  expect "no temporary files left" test "$(find "$R" -name '.*.new.*' -o -name '.partial.*' -o -name '.gnupg.*' | wc -l)" = 0
  expect "DNS warning names the record" has "$ERR" "$DOMAIN.  A     203.0.113.10"
  # Direct mode writes the same .env as before tunnel mode existed: no mode line, no token.
  local want="# Written by install.sh. Root only: SETUP_CODE claims this install. Never share or commit.
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
DATA_DIR=/opt/demo-platform/data
APP_IMAGE=demo-platform:latest
SETUP_CODE=$code"
  expect ".env is exactly the direct-mode file" test "$(cat "$INST/.env")" = "$want"
  expect "no cloudflared in the direct stack" hasnt "$INST/docker-compose.yml" cloudflared
  expect "the start command is the one from before tunnel mode" grep -q 'compose .* up -d --pull missing --wait --wait-timeout 120$' "$LOG"
  expect "nothing is removed as an orphan on start" test "$(grep -c ' up .*--remove-orphans' "$LOG")" = 0
  expect "no tunnel marker in direct mode" test ! -e "$INST/.tunnel-pending"
  expect "the mode question was asked, with direct as the default" has "$ERR" "Choice [1]"
  new_sandbox
  install_sh "$DOMAIN
$EMAIL

" install --direct --yes
  expect "--direct installs without the mode question" test "$RC" = 0
  expect "--direct asks no mode question" hasnt "$ERR" "Choice [1]"
  expect "--direct writes the direct stack" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
}

test_second_install_changes_nothing() {
  new_sandbox
  fresh_install
  echo marker >"$DATA/marker"
  local before code; before="$(snapshot)"; code="$(setup_code)"
  : >"$LOG"
  install_sh "" install
  expect "second run succeeds without input" test "$RC" = 0
  expect "every file, mode and owner unchanged" test "$(snapshot)" = "$before"
  expect "SETUP_CODE unchanged" test "$(setup_code)" = "$code"
  expect "no question asked" hasnt "$ERR" "Domain name for the platform"
  expect "no backup copies made" test "$(find "$R" -name '*.bak-*' | wc -l)" = 0
  expect "own Caddy holds the ports" has "$OUT" "own Caddy"
  expect "the code is not printed again" hasnt "$OUT" "$code"
  expect "says where the code is" has "$OUT" "/opt/demo-platform/.env"
}

test_docker_is_installed_only_when_missing() {
  new_sandbox
  STUB_DOCKER_MISSING=1 install_sh "$ANSWERS" install --yes
  expect "install succeeds" test "$RC" = 0
  local want got
  want="apt-get update
apt-get install -y ca-certificates curl gpg
curl --proto =https --tlsv1.2 -fsSL https://download.docker.com/linux/debian/gpg -o
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  got="$(grep -E '^(apt-get|curl)' "$LOG" | sed 's/ -o .*/ -o/')"
  expect "the commands from Docker's page, in order" test "$got" = "$want"
  expect "the key's fingerprint is checked" grep -q '^gpg .*--show-keys' "$LOG"
  expect "apt-get runs under umask 022" test "$(sort -u "$STATE/apt-umask")" = 0022
  expect "key in place, readable" test "$(stat -c '%a' "$R/etc/apt/keyrings/docker.asc")" = 644
  expect "key is the download" has "$R/etc/apt/keyrings/docker.asc" "BEGIN PGP PUBLIC KEY BLOCK"
  expect "sources file names $CODENAME" grep -qx "Suites: $CODENAME" "$R/etc/apt/sources.list.d/docker.sources"
  expect "sources file arch" grep -qx "Architectures: amd64" "$R/etc/apt/sources.list.d/docker.sources"
  expect "sources file key" grep -qx "Signed-By: /etc/apt/keyrings/docker.asc" "$R/etc/apt/sources.list.d/docker.sources"
  expect "sources file readable" test "$(stat -c '%a' "$R/etc/apt/sources.list.d/docker.sources")" = 644
  : >"$LOG"
  STUB_DOCKER_MISSING=1 install_sh "" install
  expect "second run succeeds" test "$RC" = 0
  expect "second run: no apt-get" hasnt "$LOG" "apt-get"
  # A file move that fails (no sources.list.d folder) must stop the run, not be skipped.
  new_sandbox
  rmdir "$R/etc/apt/sources.list.d"
  STUB_DOCKER_MISSING=1 install_sh "$ANSWERS" install --yes
  expect "a failed move stops the install" test "$RC" != 0
  expect "no Docker packages installed after it" hasnt "$LOG" "docker-ce"
  expect "no .env written after it" test ! -e "$INST/.env"
}

test_wrong_key_fingerprint_refused() {
  new_sandbox
  STUB_DOCKER_MISSING=1 STUB_KEY_FPR=0000000000000000000000000000000000000000 install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the expected fingerprint" has "$ERR" "$DOCKER_FPR"
  expect "no key installed" test ! -e "$R/etc/apt/keyrings/docker.asc"
  expect "no sources file" test ! -e "$R/etc/apt/sources.list.d/docker.sources"
  expect "no Docker packages installed" hasnt "$LOG" "docker-ce"
}

test_changed_compose_file_is_backed_up_first() {
  new_sandbox
  fresh_install
  printf '# edited by hand\n' >>"$INST/docker-compose.yml"
  local old; old="$(sha256sum <"$INST/docker-compose.yml")"
  install_sh "" install
  expect "run succeeds" test "$RC" = 0
  local bak; bak="$(find "$INST" -maxdepth 1 -name 'docker-compose.yml.bak-*')"
  expect "one backup copy" test "$(printf '%s\n' "$bak" | grep -c .)" = 1
  expect "backup holds the old bytes" test "$(sha256sum <"$bak")" = "$old"
  expect "file is the deploy copy again" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
}

test_a_failed_fresh_install_removes_what_it_created() {
  new_sandbox
  STUB_FAIL_UP=1 install_sh "$ANSWERS" install --yes
  expect "fresh run fails" test "$RC" != 0
  expect "shows the app's log" has "$LOG" " logs --tail"
  expect "takes the half-started stack down" grep -q 'compose .* down' "$LOG"
  expect ".env removed" test ! -e "$INST/.env"
  expect "compose file removed" test ! -e "$INST/docker-compose.yml"
  expect "empty data folder removed" test ! -e "$DATA"
  expect "says what it removed" has "$ERR" "removed $INST/.env"
  expect "does not claim .env was unchanged" hasnt "$ERR" "were not changed"
}

test_a_failed_compose_up_restores_the_previous_setup() {
  new_sandbox
  fresh_install
  echo marker >"$DATA/marker"
  printf '# previous working state\n' >>"$INST/docker-compose.yml"
  local env_sum compose_sum; env_sum="$(sha256sum <"$INST/.env")"; compose_sum="$(sha256sum <"$INST/docker-compose.yml")"
  rm -f "$STATE/ups"; : >"$LOG"
  STUB_FAIL_UP=1 install_sh "" install
  expect "exit code non-zero" test "$RC" != 0
  expect ".env unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect "data marker survives" test "$(cat "$DATA/marker")" = marker
  expect "previous compose file restored" test "$(sha256sum <"$INST/docker-compose.yml")" = "$compose_sum"
  expect "previous setup started again" test "$(grep -c ' up -d' "$LOG")" = 2
  expect "not taken down" hasnt "$LOG" " down"
}

test_update_backs_up_then_restarts() {
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  : >"$LOG"
  STUB_IMAGE=pulled install_sh "" update
  expect "update succeeds" test "$RC" = 0
  expect "pull, backup, then up" test "$(grep -oE 'compose .* (pull|up -d|exec -T app)' "$LOG" | grep -oE '(pull|up -d|exec -T app)$' | tr '\n' ' ')" = "pull exec -T app up -d "
  expect "a backup archive written" test "$(find "$INST/backups" -name 'demo-platform-*.tar.gz' | wc -l)" = 1
  expect "only the backup is new" test "$(diff <(printf '%s\n' "$before") <(snapshot) | grep '^>' | grep -vc 'backups/demo-platform-')" = 0
  : >"$LOG"
  install_sh "" update
  expect "local image: update succeeds" test "$RC" = 0
  expect "local image: only caddy is pulled" grep -q 'compose .* pull caddy$' "$LOG"
  expect "local image: says so" has "$OUT" "loaded on this server"
  : >"$LOG"
  STUB_FAIL_EXEC=1 install_sh "" update
  expect "a failed backup stops the update" test "$RC" = 1
  expect "and nothing is restarted" hasnt "$LOG" " up -d"
}

test_backup_never_removes_older_backups() {
  new_sandbox
  fresh_install
  mkdir -p "$DATA/drafts/u1" "$DATA/public/t1"
  echo d >"$DATA/drafts/u1/step-001.png"; echo p >"$DATA/public/t1/step-001.png"
  install_sh "" backup
  expect "first backup succeeds" test "$RC" = 0
  install_sh "" backup
  expect "second backup succeeds" test "$RC" = 0
  local archives; archives="$(find "$INST/backups" -name 'demo-platform-*.tar.gz' | sort)"
  expect "two archives" test "$(printf '%s\n' "$archives" | grep -c .)" = 2
  local a
  for a in $archives; do
    expect "$a is mode 600" test "$(stat -c '%a' "$a")" = 600
    expect "$a name" grep -Eq '/demo-platform-[0-9]{8}-[0-9]{6}(-[0-9]+)?\.tar\.gz$' <<<"$a"
    expect "$a holds db.sqlite, drafts and public" test "$(tar -tzf "$a" | grep -cE '^(db\.sqlite|drafts/u1/step-001\.png|public/t1/step-001\.png)$')" = 3
  done
  expect "temporary copies removed from the data folder" test "$(find "$DATA" -maxdepth 1 -name '.backup-*' | wc -l)" = 0
  expect "copy made inside the container" grep -q 'exec -T app node dist/node/backup.js /data/.backup-' "$LOG"
}

# ---------------------------------------------------------------- uninstall

test_uninstall_keeps_the_data_folder() {
  new_sandbox
  fresh_install
  echo marker >"$DATA/marker"
  install_sh "" backup
  : >"$LOG"
  install_sh "" uninstall --yes
  expect "uninstall succeeds" test "$RC" = 0
  expect "containers taken down" grep -q 'compose .* down --remove-orphans' "$LOG"
  expect "marker survives" test "$(cat "$DATA/marker")" = marker
  expect ".env survives" test -f "$INST/.env"
  expect "backup survives" test "$(find "$INST/backups" -name '*.tar.gz' | wc -l)" = 1
  expect "says where the data is" has "$OUT" "data folder:  /opt/demo-platform/data"
  install_sh "" uninstall
  expect "without --yes and no answer: cancelled" test "$RC" = 1
}

test_delete_data_needs_the_typed_domain() {
  new_sandbox
  fresh_install
  mkdir -p "$DATA/drafts"; echo marker >"$DATA/drafts/marker"
  install_sh "" backup
  local answer
  for answer in "wrong.example.com" "" "yes" "TOURS.EXAMPLE.COM"; do
    install_sh "$answer
" uninstall --delete-data --yes
    expect "'$answer' is refused" test "$RC" = 1
    expect "'$answer' keeps the data" test "$(cat "$DATA/drafts/marker")" = marker
  done
  install_sh "$DOMAIN
" uninstall --delete-data --yes
  expect "the right name succeeds" test "$RC" = 0
  expect "data folder removed" test ! -e "$DATA"
  expect ".env kept" test -f "$INST/.env"
  expect "backup kept" test "$(find "$INST/backups" -name '*.tar.gz' | wc -l)" = 1
  expect "install folder kept" test -f "$INST/docker-compose.yml"
}

test_delete_data_never_follows_a_linked_parent() {
  new_sandbox
  mkdir -p "$R/srv"
  install_with_data /srv/home
  mkdir -p "$R/srv/home/drafts"
  # /srv is replaced by a link to another folder that has its own "home".
  mv "$R/srv" "$R/srv-real"
  mkdir -p "$R/victim/home"; echo precious >"$R/victim/home/precious"
  ln -s "$R/victim" "$R/srv"
  install_sh "$DOMAIN
" uninstall --delete-data --yes
  expect "refused" test "$RC" != 0
  expect "the link's target survives" test "$(cat "$R/victim/home/precious")" = precious
  expect "the real data folder survives" test -d "$R/srv-real/home/drafts"
}

test_delete_data_refuses_a_folder_that_is_not_the_platforms() {
  new_sandbox
  fresh_install
  echo "not ours" >"$DATA/notes.txt"
  install_sh "$DOMAIN
" uninstall --delete-data --yes
  expect "refused" test "$RC" != 0
  expect "names the unexpected entry" has "$ERR" "notes.txt"
  expect "folder survives" test -f "$DATA/notes.txt"
}

# ---------------------------------------------------------------- dry run

test_dry_run_writes_nothing() {
  new_sandbox
  local before; before="$(snapshot)"
  STUB_DOCKER_MISSING=1 install_sh "$ANSWERS" install --dry-run --yes
  expect "dry run succeeds" test "$RC" = 0
  expect "the root is unchanged" test "$(snapshot)" = "$before"
  expect "prints the Docker commands" has "$OUT" "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  expect "prints the folder creation" has "$OUT" "install -d -m 0700 -o 1001 -g 1001"
  expect "prints the .env write" has "$OUT" "would write DOMAIN, ACME_EMAIL, DATA_DIR, APP_IMAGE and a new SETUP_CODE"
  expect "prints the start" grep -q 'up -d --pull missing --wait' "$OUT"
  expect "says what it would check in the rendered stack file" has "$OUT" "would check that Docker Compose fills in the new stack file with TOURS_HOST and APP_HOST both empty for the app"
  expect "runs no apt-get, curl or compose up" test "$(grep -cE '^(apt-get|curl)| up | config ' "$LOG")" = 0
  expect "prints no setup code" test "$(grep -cE '[0-9a-f]{32}' "$OUT" "$ERR" | awk -F: '{s+=$2} END {print s}')" = 0
  # On an existing install too, for every command.
  new_sandbox
  fresh_install
  before="$(snapshot)"
  local cmd
  for cmd in install update backup uninstall; do
    install_sh "" "$cmd" --dry-run --yes
    expect "$cmd --dry-run succeeds" test "$RC" = 0
  done
  install_sh "$DOMAIN
" uninstall --delete-data --dry-run --yes
  expect "uninstall --delete-data --dry-run prints the rm" has "$OUT" "rm -rf --one-file-system"
  expect "nothing changed by any dry run" test "$(snapshot)" = "$before"
}

# ---------------------------------------------------------------- tunnel mode

test_tunnel_install_publishes_no_ports_and_keeps_the_token_in_env() {
  new_sandbox
  # A busy port stops a direct install; a tunnel install does not look at the ports.
  STUB_PORT_BUSY=443 tunnel_install
  local code; code="$(setup_code)"
  expect ".env is 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  local want="# Written by install.sh. Root only: SETUP_CODE claims this install and TUNNEL_TOKEN runs its tunnel. Never share or commit.
DOMAIN=$DOMAIN
DEPLOY_MODE=tunnel
DATA_DIR=/opt/demo-platform/data
APP_IMAGE=demo-platform:latest
SETUP_CODE=$code
TUNNEL_TOKEN=$TOK"
  expect ".env holds the mode and the token, and no email" test "$(cat "$INST/.env")" = "$want"
  expect "compose file is the tunnel copy" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  expect "Caddyfile is the tunnel copy" cmp -s "$INST/caddy/Caddyfile" /src/tunnel/caddy/Caddyfile
  expect "compose file is 600 root" test "$(stat -c '%a %u:%g' "$INST/docker-compose.yml")" = "600 0:0"
  expect "no service publishes a port" test "$(grep -cE '^[[:space:]]*(ports|network_mode|expose):' "$INST/docker-compose.yml")" = 0
  expect "no host port mapping anywhere in the stack file" test "$(grep -cE '^[[:space:]]*- "[0-9.:]+(/udp)?"' "$INST/docker-compose.yml")" = 0
  expect "the Caddyfile asks for no certificate" has "$INST/caddy/Caddyfile" "auto_https off"
  # shellcheck disable=SC2016 # the literal Caddyfile placeholder
  expect "the Caddyfile serves plain HTTP for the domain" has "$INST/caddy/Caddyfile" 'http://{$DOMAIN}'
  expect "the Caddyfile still sends HSTS" has "$INST/caddy/Caddyfile" 'Strict-Transport-Security "max-age=604800"'
  expect "cloudflared is pinned by digest" grep -Eq 'image: cloudflare/cloudflared@sha256:[0-9a-f]{64}$' "$INST/docker-compose.yml"
  expect "cloudflared runs without a token argument" grep -qx '    command: tunnel --no-autoupdate --metrics 127.0.0.1:20241 run' "$INST/docker-compose.yml"
  # shellcheck disable=SC2016 # the literal compose placeholder
  expect "the token reaches cloudflared from .env" has "$INST/docker-compose.yml" 'TUNNEL_TOKEN: ${TUNNEL_TOKEN:?'
  expect "the app is not handed the whole .env" test "$(grep -cE '^[[:space:]]*env_file:' "$INST/docker-compose.yml")" = 0
  expect "no file but .env holds the token" test "$(grep -rlF -- "$TOK" "$R" | sed "s|^$R||")" = /opt/demo-platform/.env
  expect "the token is not printed and on no command line" token_not_shown
  expect "the token prompt was shown" has "$ERR" "Tunnel token"
  expect "no certificate email question" hasnt "$ERR" "Email for the certificate"
  expect "no mode question with --tunnel" hasnt "$ERR" "Choice [1]"
  expect "the port check is skipped" hasnt "$OUT" "Checking that ports 80 and 443"
  expect "the DNS check is skipped" hasnt "$OUT" "points at this server"
  expect "no DNS warning" hasnt "$ERR" "A     203.0.113.10"
  expect "compose file validated before use" grep -q 'docker compose --project-name demo-platform --project-directory .* config --quiet' "$LOG"
  expect "stack started with a health wait" grep -q 'compose .* up -d --pull missing --wait --wait-timeout 120$' "$LOG"
  expect "the marker of a tunnel that never connected is gone" test ! -e "$INST/.tunnel-pending"
  expect "prints the service URL for the dashboard" has "$OUT" "http://caddy:80"
  expect "prints the hostname for the dashboard" has "$OUT" "Hostname:     $DOMAIN"
  expect "address printed" has "$OUT" "https://$DOMAIN/setup"
  expect "code printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "code never on a stub's command line" hasnt "$LOG" "$code"
  expect "no temporary files left" test "$(find "$R" -name '.*.new.*' -o -name '.partial.*' | wc -l)" = 0
}

test_tunnel_mode_can_be_chosen_at_the_question() {
  new_sandbox
  install_sh "what
2
$DOMAIN
$TOK

" install --yes
  expect "install succeeds" test "$RC" = 0
  expect "tunnel mode recorded" grep -qx "DEPLOY_MODE=tunnel" "$INST/.env"
  expect "the tunnel stack was written" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  expect "the token is not shown" token_not_shown
}

test_tunnel_token_from_the_environment() {
  new_sandbox
  TUNNEL_TOKEN="$TOK" install_sh "$DOMAIN

" install --tunnel --yes
  expect "install succeeds" test "$RC" = 0
  expect "the token is in .env" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "no token prompt" hasnt "$ERR" "Tunnel token from"
  expect "the token is not shown" token_not_shown
  new_sandbox
  TUNNEL_TOKEN="not-a-token-$TOK" install_sh "$DOMAIN

" install --tunnel --yes
  expect "a malformed token in the environment stops the install" test "$RC" = 1
  expect "names the variable" has "$ERR" "TUNNEL_TOKEN"
  expect "nothing written" test ! -e "$R/opt"
  expect "the bad value is not shown" token_not_shown
}

test_tunnel_token_shape_is_checked_and_never_echoed() {
  new_sandbox
  install_sh "$DOMAIN
hunter2-not-a-token
sudo cloudflared service install $TOK

" install --tunnel --yes
  expect "succeeds on the second try, from the pasted install command" test "$RC" = 0
  expect "the token alone is stored" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "the refusal says what a token looks like" has "$ERR" "eyJ"
  expect "the wrong text is not echoed" test "$(cat "$OUT" "$ERR" "$LOG" | grep -c hunter2)" = 0
  expect "the token is not shown" token_not_shown
  new_sandbox
  install_sh "$DOMAIN
one
two
three
" install --tunnel --yes
  expect "three bad tokens stop" test "$RC" = 1
  expect "nothing written" test ! -e "$R/opt"
}

test_tunnel_second_install_asks_nothing_and_keeps_the_token() {
  new_sandbox
  tunnel_install
  echo marker >"$DATA/marker"
  local before code; before="$(snapshot)"; code="$(setup_code)"
  : >"$LOG"
  # No input at all, a busy port, and another token in the environment: none matters.
  STUB_PORT_BUSY=80 TUNNEL_TOKEN="$TOK2" install_sh "" install
  expect "second run succeeds without input" test "$RC" = 0
  expect "every file, mode and owner unchanged" test "$(snapshot)" = "$before"
  expect "the token is unchanged" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "no question asked" test "$(grep -cE 'Domain name for the platform|Tunnel token from|Choice \[1\]|Email for' "$ERR")" = 0
  expect "no backup copies made" test "$(find "$R" -name '*.bak-*' | wc -l)" = 0
  expect "neither token is shown" test "$(cat "$OUT" "$ERR" "$LOG" | grep -cF -e "$TOK" -e "$TOK2")" = 0
  expect "the code is not printed again" hasnt "$OUT" "$code"
  expect "prints the service URL again" has "$OUT" "http://caddy:80"
  : >"$LOG"
  install_sh "" install --tunnel
  expect "--tunnel on a tunnel install is fine" test "$RC" = 0
  expect "still unchanged" test "$(snapshot)" = "$before"
  # A token that lost its shape by a hand edit is reported without being printed.
  sed -i 's/^TUNNEL_TOKEN=.*/TUNNEL_TOKEN=broken-by-hand/' "$INST/.env"
  install_sh "" install
  expect "a broken token in .env is refused" test "$RC" = 1
  expect "names the setting" has "$ERR" "TUNNEL_TOKEN"
  expect "does not print the value" hasnt "$ERR" "broken-by-hand"
}

test_tunnel_dry_run_writes_nothing() {
  new_sandbox
  local before; before="$(snapshot)"
  STUB_DOCKER_MISSING=1 install_sh "$TUNNEL_ANSWERS" install --tunnel --dry-run --yes
  expect "dry run succeeds" test "$RC" = 0
  expect "the root is unchanged" test "$(snapshot)" = "$before"
  expect "prints the .env write" has "$OUT" "would write DOMAIN, DEPLOY_MODE, DATA_DIR, APP_IMAGE, a new SETUP_CODE and the TUNNEL_TOKEN"
  expect "prints the start" grep -q 'up -d --pull missing --wait' "$OUT"
  expect "runs no apt-get, curl or compose up" test "$(grep -cE '^(apt-get|curl)| up | config ' "$LOG")" = 0
  expect "the token is not shown" token_not_shown
  expect "prints no setup code" test "$(cat "$OUT" "$ERR" | grep -cE '[0-9a-f]{32}')" = 0
  new_sandbox
  tunnel_install
  before="$(snapshot)"
  local cmd
  for cmd in install update backup status uninstall; do
    install_sh "" "$cmd" --dry-run --yes
    expect "$cmd --dry-run succeeds" test "$RC" = 0
    expect "$cmd --dry-run does not show the token" token_not_shown
  done
  expect "nothing changed by any dry run" test "$(snapshot)" = "$before"
}

test_switching_modes_is_refused() {
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  : >"$LOG"
  install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "--tunnel on a direct install is refused" test "$RC" = 1
  expect "names the current mode" has "$ERR" "direct mode"
  expect "gives the manual steps" has "$ERR" "DEPLOY_MODE=tunnel"
  expect "nothing changed" test "$(snapshot)" = "$before"
  expect "nothing started or stopped" test "$(grep -cE ' (up|down|pull) ' "$LOG")" = 0
  expect "the token is not shown" token_not_shown
  new_sandbox
  tunnel_install
  before="$(snapshot)"
  : >"$LOG"
  install_sh "" install --direct --yes
  expect "--direct on a tunnel install is refused" test "$RC" = 1
  expect "names the current mode" has "$ERR" "tunnel mode"
  expect "gives the manual steps" has "$ERR" "ACME_EMAIL"
  expect "nothing changed" test "$(snapshot)" = "$before"
  expect "nothing started or stopped" test "$(grep -cE ' (up|down|pull) ' "$LOG")" = 0
}

test_switching_modes_by_hand() {
  new_sandbox
  fresh_install
  local code; code="$(setup_code)"
  echo marker >"$DATA/marker"
  printf 'DEPLOY_MODE=tunnel\nTUNNEL_TOKEN=%s\n' "$TOK" >>"$INST/.env"
  local before; before="$(snapshot)"
  install_sh "" install
  expect "refused while the direct stack is still running" test "$RC" = 1
  expect "says to uninstall first" has "$ERR" "uninstall"
  expect "nothing changed" test "$(snapshot)" = "$before"
  install_sh "" uninstall --yes
  expect "uninstall succeeds" test "$RC" = 0
  : >"$LOG"
  install_sh "" install
  expect "the install in the new mode succeeds" test "$RC" = 0
  expect "the tunnel stack was written" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  expect "the tunnel Caddyfile was written" cmp -s "$INST/caddy/Caddyfile" /src/tunnel/caddy/Caddyfile
  expect "the direct stack file was saved first" test "$(find "$INST" -maxdepth 1 -name 'docker-compose.yml.bak-*' -exec cmp -s {} /src/docker-compose.yml \; -print | wc -l)" = 1
  expect "the direct Caddyfile was saved first" test "$(find "$INST/caddy" -name 'Caddyfile.bak-*' | wc -l)" = 1
  expect "the setup code is kept" test "$(setup_code)" = "$code"
  expect "the data is kept" test "$(cat "$DATA/marker")" = marker
  expect "start removes no container it did not make" test "$(grep -c ' up .*--remove-orphans' "$LOG")" = 0
  expect "the token is not shown" token_not_shown
  # And back: the lines taken out again, the email still there.
  install_sh "" uninstall --yes
  sed -i '/^DEPLOY_MODE=/d; /^TUNNEL_TOKEN=/d' "$INST/.env"
  install_sh "" install
  expect "back to direct succeeds" test "$RC" = 0
  expect "the direct stack was written" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
  expect "the port check ran again" has "$OUT" "Checking that ports 80 and 443"
}

test_tunnel_app_that_never_starts_removes_what_the_run_created() {
  new_sandbox
  STUB_FAIL_UP=1 install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "fresh run fails" test "$RC" != 0
  expect "shows cloudflared's log" grep -q ' logs .*cloudflared' "$LOG"
  expect "shows the app's log too" grep -q ' logs .*app' "$LOG"
  expect "takes the half-started stack down" grep -q 'compose .* down' "$LOG"
  expect ".env removed, the token with it" test ! -e "$INST/.env"
  expect "the marker removed" test ! -e "$INST/.tunnel-pending"
  expect "compose file removed" test ! -e "$INST/docker-compose.yml"
  expect "empty data folder removed" test ! -e "$DATA"
  expect "no file holds the token" test -z "$(grep -rlF -- "$TOK" "$R")"
  expect "the token is not shown" token_not_shown
}

# The real order of events: the app starts, turns healthy and writes its database, and
# only then cloudflared fails on the token. The data folder is no longer empty, so .env
# stays; the next run must ask for the token again and print the setup code.
test_tunnel_wrong_token_then_right_token() {
  new_sandbox
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "the first run fails" test "$RC" != 0
  expect "the app wrote its database" test -f "$DATA/db.sqlite"
  expect "says the token could not be read" has "$ERR" "is not a complete tunnel token"
  expect "says the next run asks for the token again" has "$ERR" "asks for the tunnel token again"
  expect "does not say .env was removed" hasnt "$ERR" "removed $INST/.env"
  expect ".env is kept with the data" test -f "$INST/.env"
  expect "the tunnel is marked as never connected" test -f "$INST/.tunnel-pending"
  expect "the marker is 600 root" test "$(stat -c '%a %u:%g' "$INST/.tunnel-pending")" = "600 0:0"
  expect "the stack file was removed again" test ! -e "$INST/docker-compose.yml"
  local code; code="$(setup_code)"
  expect "a setup code was generated" grep -Eqx '[0-9a-f]{32}' <<<"$code"
  expect "the setup code was not printed by the failed run" test "$(cat "$OUT" "$ERR" "$LOG" | grep -c -- "$code")" = 0
  expect "the token is not shown" token_not_shown
  local env_before; env_before="$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")"
  # Second run, no flag: only the token is asked for, and the right one works.
  : >"$LOG"
  install_sh "$TOK2
" install
  expect "the second run succeeds" test "$RC" = 0
  expect "it asked for the token again" has "$ERR" "Tunnel token from"
  expect "it asked nothing else" test "$(grep -cE 'Domain name for the platform|Choice \[1\]|Email for|Data folder' "$ERR")" = 0
  expect "the new token is in .env" grep -qx "TUNNEL_TOKEN=$TOK2" "$INST/.env"
  expect "the old token is in no file" test -z "$(grep -rlF -- "$TOK" "$R")"
  expect "only .env holds the new token" test "$(grep -rlF -- "$TOK2" "$R" | sed "s|^$R||")" = /opt/demo-platform/.env
  expect "every other line of .env is unchanged" test "$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")" = "$env_before"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "no copy of .env was made" test "$(find "$R" -name '.env.*' | wc -l)" = 0
  expect "the setup code is the same" test "$(setup_code)" = "$code"
  expect "the setup code is printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "with the address" has "$OUT" "https://$DOMAIN/setup"
  expect "the marker is gone" test ! -e "$INST/.tunnel-pending"
  expect "neither token is shown" test "$(cat "$OUT" "$ERR" "$LOG" | grep -cF -e "$TOK" -e "$TOK2")" = 0
  # Third run: nothing is asked, the code is not printed again.
  local before; before="$(snapshot)"
  install_sh "" install
  expect "the third run succeeds without input" test "$RC" = 0
  expect "it asks nothing" hasnt "$ERR" "Tunnel token from"
  expect "the code is not printed again" hasnt "$OUT" "$code"
  expect "nothing changed" test "$(snapshot)" = "$before"
}

test_tunnel_never_connected_takes_a_token_from_the_environment_or_keeps_the_stored_one() {
  new_sandbox
  STUB_FAIL_UP=tunnel STUB_CF_LOG='cloudflared-1  | ERR Register tunnel error from server side error="Unauthorized: stub"' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "a refused token fails" test "$RC" != 0
  expect "says Cloudflare refused it" has "$ERR" "Cloudflare refused"
  local code; code="$(setup_code)"
  TUNNEL_TOKEN="$TOK2" install_sh "" install
  expect "the second run succeeds with the token from the environment" test "$RC" = 0
  expect "no prompt" hasnt "$ERR" "Tunnel token from"
  expect "the new token is in .env" grep -qx "TUNNEL_TOKEN=$TOK2" "$INST/.env"
  expect "the setup code is printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "neither token is shown" test "$(cat "$OUT" "$ERR" "$LOG" | grep -cF -e "$TOK" -e "$TOK2")" = 0
  # Cloudflare was unreachable, the token was right: Enter keeps it.
  new_sandbox
  STUB_FAIL_UP=tunnel STUB_CF_LOG='cloudflared-1  | ERR edge discovery: error looking up Cloudflare edge IPs: the DNS query failed' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "an unreachable Cloudflare fails" test "$RC" != 0
  expect "says it could not reach Cloudflare" has "$ERR" "could not reach Cloudflare"
  expect "names the outbound port" has "$ERR" "7844"
  code="$(setup_code)"
  local env_sum; env_sum="$(sha256sum <"$INST/.env")"
  install_sh "
" install
  expect "the second run succeeds on an empty answer" test "$RC" = 0
  expect "the prompt offers to keep the token" has "$ERR" "Enter keeps the one"
  expect ".env is unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect "the setup code is printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  # A second failure leaves it asking again.
  new_sandbox
  STUB_FAIL_UP=tunnel install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  rm -f "$STATE/ups"
  STUB_FAIL_UP=tunnel install_sh "$TOK2
" install
  expect "a second failure fails" test "$RC" != 0
  expect "still marked as never connected" test -f "$INST/.tunnel-pending"
  expect ".env still there" test -f "$INST/.env"
  expect "the setup code is still not printed" test "$(cat "$OUT" "$ERR" | grep -c -- "$(setup_code)")" = 0
  install_sh "$TOK
" install
  expect "the third run succeeds" test "$RC" = 0
  expect "with the token given last" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "and prints the code once" test "$(grep -c -- "$(setup_code)" "$OUT")" = 1
}

test_tunnel_failed_start_masks_the_token_in_the_log() {
  # A log line that did hold the token would be masked before it is printed.
  new_sandbox
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | token=$TOK" install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "fails" test "$RC" != 0
  expect "the log line is shown" has "$OUT" "cloudflared-1  | token="
  expect "with the token masked" test "$(cat "$OUT" "$ERR" | grep -cF -- "$TOK")" = 0
}

test_new_token_replaces_the_token_of_a_working_install() {
  new_sandbox
  tunnel_install
  local code before; code="$(setup_code)"; before="$(snapshot | grep -v '/\.env$')"
  local env_before; env_before="$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")"
  # Without --new-token a token in the environment is not taken, and the run says so.
  TUNNEL_TOKEN="$TOK2" install_sh "" install
  expect "a run without the option succeeds" test "$RC" = 0
  expect "keeps the token" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "says how to replace it" has "$ERR" "--new-token"
  install_sh "" install --new-token --dry-run
  expect "a dry run asks and changes nothing" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  : >"$LOG"
  install_sh "one
$TOK2
" install --new-token
  expect "--new-token succeeds on the second try" test "$RC" = 0
  expect "it asked at the hidden prompt" has "$ERR" "Tunnel token from"
  expect "the new token is in .env" grep -qx "TUNNEL_TOKEN=$TOK2" "$INST/.env"
  expect "every other line of .env is unchanged" test "$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")" = "$env_before"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "no copy of .env was made" test "$(find "$R" -name '.env.*' | wc -l)" = 0
  expect "the old token is in no file" test -z "$(grep -rlF -- "$TOK" "$R")"
  expect "nothing but .env changed" test "$(snapshot | grep -v '/\.env$')" = "$before"
  expect "the stack was started again, so cloudflared gets the token" grep -q 'compose .* up -d --pull missing --wait' "$LOG"
  expect "the setup code is not printed" hasnt "$OUT" "$code"
  expect "neither token is shown" test "$(cat "$OUT" "$ERR" "$LOG" | grep -cF -e "$TOK" -e "$TOK2")" = 0
  # A new token that does not connect: the working one is put back.
  rm -f "$STATE/ups"; : >"$LOG"
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "$TOK
" install --new-token
  expect "a new token that does not connect fails" test "$RC" != 0
  expect "the working token is back in .env" grep -qx "TUNNEL_TOKEN=$TOK2" "$INST/.env"
  expect "says so" has "$ERR" "previous token"
  expect "the previous setup is started again" test "$(grep -c ' up -d' "$LOG")" = 2
  expect "not taken down" hasnt "$LOG" " down"
  expect "not marked as never connected" test ! -e "$INST/.tunnel-pending"
  expect "the stack file is still there" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  # From the environment, without a prompt.
  TUNNEL_TOKEN="$TOK" install_sh "" install --new-token
  expect "--new-token takes the environment's token" test "$RC" = 0
  expect "no prompt" hasnt "$ERR" "Tunnel token from"
  expect "the token is replaced" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  # Not on a direct install.
  new_sandbox
  fresh_install
  before="$(snapshot)"
  install_sh "$TOK
" install --new-token
  expect "--new-token on a direct install is refused" test "$RC" = 1
  expect "says why" has "$ERR" "tunnel mode"
  expect "nothing changed" test "$(snapshot)" = "$before"
}

# A paste with a line break in it: the rest must not fall into the next question, where
# a refusal would echo it. Needs a terminal, which script(1) provides.
test_a_token_pasted_with_a_line_break_is_not_leaked() {
  new_sandbox
  command -v script >/dev/null 2>&1 || die "script(1) is missing"
  local half="${TOK:0:120}" rest="RESTOFTHETOKEN${TOK:120}"
  OUT="$T/out"
  set +e
  { sleep 1; printf '%s\n' "$DOMAIN"; sleep 1; printf '%s\n%s\n' "$half" "$rest"; sleep 2; printf '%s\n' "$TOK"; sleep 1; printf '\n'; sleep 2; } \
    | env PATH="$T/bin:$PATH" DP_ROOT="$R" STUB_LOG="$LOG" STUB_STATE="$STATE" STUB_DATA="$STUB_DATA" \
      script -qec "bash $SCRIPT install --tunnel --yes" /dev/null >"$OUT" 2>&1
  RC=$?
  set -e
  expect "the install succeeds once the token is pasted whole" test "$RC" = 0
  expect "the two-line paste was refused" has "$OUT" "more than one line"
  expect "the whole token is stored, not its first line" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "the rest of the paste is shown nowhere" test "$(cat "$OUT" "$LOG" | grep -c RESTOFTHETOKEN)" = 0
  expect "the first line is shown nowhere" test "$(cat "$OUT" "$LOG" | grep -cF -- "$half")" = 0
  expect "the data folder is the default, not the rest of the paste" grep -qx "DATA_DIR=/opt/demo-platform/data" "$INST/.env"
}

test_tunnel_failed_restart_of_a_working_install_keeps_everything() {
  new_sandbox
  tunnel_install
  printf '# previous working state\n' >>"$INST/docker-compose.yml"
  local env_sum compose_sum; env_sum="$(sha256sum <"$INST/.env")"; compose_sum="$(sha256sum <"$INST/docker-compose.yml")"
  rm -f "$STATE/ups"; : >"$LOG"
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "" install
  expect "exit code non-zero" test "$RC" != 0
  expect ".env unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect "previous compose file restored" test "$(sha256sum <"$INST/docker-compose.yml")" = "$compose_sum"
  expect "explains the token here too" has "$ERR" "is not a complete tunnel token"
  expect "says how to replace the token" has "$ERR" "--new-token"
  expect "not taken down" hasnt "$LOG" " down"
  expect "not marked as never connected" test ! -e "$INST/.tunnel-pending"
}

test_tunnel_update_status_backup_uninstall() {
  new_sandbox
  tunnel_install
  mkdir -p "$DATA/drafts/u1"; echo d >"$DATA/drafts/u1/step-001.png"
  : >"$LOG"
  install_sh "" update
  expect "update succeeds without the flag" test "$RC" = 0
  expect "local image: caddy and cloudflared are pulled" grep -q 'compose .* pull caddy cloudflared$' "$LOG"
  expect "pull, backup, then up" test "$(grep -oE 'compose .* (pull caddy cloudflared|up -d|exec -T app)' "$LOG" | grep -oE '(pull caddy cloudflared|up -d|exec -T app)$' | tr '\n' ' ')" = "pull caddy cloudflared exec -T app up -d "
  expect "update does not show the token" token_not_shown
  install_sh "" backup
  expect "backup succeeds" test "$RC" = 0
  local a
  for a in "$INST"/backups/demo-platform-*.tar.gz; do
    expect "$a holds no .env" test "$(tar -tzf "$a" | grep -c '\.env')" = 0
    expect "$a does not hold the token" test "$(tar -xzOf "$a" | grep -cF -- "$TOK")" = 0
  done
  expect "backup does not show the token" token_not_shown
  install_sh "" status
  expect "status succeeds" test "$RC" = 0
  expect "status reports the tunnel" has "$OUT" "Health check of the tunnel"
  expect "status repeats the service URL" has "$OUT" "http://caddy:80"
  expect "status does not show the token" token_not_shown
  : >"$LOG"
  install_sh "" uninstall --yes
  expect "uninstall succeeds" test "$RC" = 0
  expect "containers taken down" grep -q 'compose .* down --remove-orphans' "$LOG"
  expect ".env survives with the token" grep -qx "TUNNEL_TOKEN=$TOK" "$INST/.env"
  expect "says the token stays in .env" has "$OUT" "tunnel token"
  expect "says the tunnel stays at Cloudflare" has "$OUT" "Cloudflare"
  expect "uninstall does not show the token" token_not_shown
}

# ---------------------------------------------------------------- tunnel mode: follow-ups

test_new_token_is_saved_only_after_it_has_connected() {
  new_sandbox
  tunnel_install
  local env_before; env_before="$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")"
  forget_starts
  install_sh "$TOK2
" install --new-token
  expect "--new-token succeeds" test "$RC" = 0
  expect "cloudflared was started on the new token" test "$(last_up_token)" = "$TOK2"
  expect "while .env still held the old one" test "$(tail -n 1 "$STATE/up-env-tokens")" = "$TOK"
  expect "the new token is in .env afterwards" test "$(env_token)" = "$TOK2"
  expect "every other line of .env is unchanged" test "$(grep -v '^TUNNEL_TOKEN=' "$INST/.env")" = "$env_before"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "no copy of .env was made" test "$(find "$R" -name '.env.*' | wc -l)" = 0
  expect "says the token is saved only once it has connected" has "$OUT" "until the new one has connected"
  expect "no part of a token is shown" no_token_part_shown
  # The next plain run starts from .env alone, on the new token.
  forget_starts
  install_sh "" install
  expect "the next run succeeds without input" test "$RC" = 0
  expect "it starts on the token in .env" test "$(last_up_token) $(tail -n 1 "$STATE/up-env-tokens")" = "$TOK2 $TOK2"
}

test_new_token_run_that_fails_before_the_start_keeps_the_old_token() {
  new_sandbox
  tunnel_install
  local before; before="$(snapshot)"
  forget_starts
  STUB_FAIL_CONFIG=1 install_sh "$TOK2
" install --new-token
  expect "the run fails" test "$RC" != 0
  expect "every file, .env included, is as it was" test "$(snapshot)" = "$before"
  expect "nothing was started or stopped" test "$(grep -cE ' (up|down) ' "$LOG")" = 0
  expect "no part of a token is shown" no_token_part_shown
}

test_interrupted_new_token_keeps_the_old_token_and_the_site_running() {
  local sig
  for sig in TERM INT HUP; do
    new_sandbox
    tunnel_install
    local env_sum; env_sum="$(sha256sum <"$INST/.env")"
    forget_starts
    STUB_UP_SIGNAL="$sig" install_sh "$TOK2
" install --new-token
    local want=143
    case "$sig" in INT) want=130 ;; HUP) want=129 ;; esac
    expect "$sig: the run ends with exit code $want" test "$RC" = "$want"
    expect "$sig: the new token was being tried" test "$(head -n 1 "$STATE/up-tokens")" = "$TOK2"
    expect "$sig: .env is unchanged, the old token in it" test "$(sha256sum <"$INST/.env")" = "$env_sum"
    expect "$sig: .env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
    expect "$sig: no temporary file is left" test "$(find "$R" -name '.*.new.*' -o -name '.restore.*' | wc -l)" = 0
    expect "$sig: the new token is in no file" test -z "$(grep -rlF -- "$TOK2" "$R")"
    expect "$sig: the site is started again, once, on the old token" test "$(wc -l <"$STATE/up-tokens") $(last_up_token)" = "2 $TOK"
    expect "$sig: not taken down" hasnt "$LOG" " down"
    expect "$sig: says the new token was not saved" has "$ERR" "the new token was not saved"
    expect "$sig: says the site was started again and had been out of reach" has "$ERR" "The site is started again on the previous token; it could not be reached while the new one was tried."
    expect "$sig: does not claim nothing happened" test "$(cat "$OUT" "$ERR" | grep -c 'keeps running')" = 0
    expect "$sig: names the command to try again" has "$ERR" "sudo bash $SCRIPT install --new-token"
    expect "$sig: not marked as never connected" test ! -e "$INST/.tunnel-pending"
    expect "$sig: no part of a token is shown" no_token_part_shown
    install_sh "" install
    expect "$sig: the next plain run succeeds on the old token" test "$RC $(env_token)" = "0 $TOK"
  done
}

test_new_token_interrupted_while_it_is_saved_keeps_the_old_token() {
  new_sandbox
  tunnel_install
  stub_mv
  local env_sum; env_sum="$(sha256sum <"$INST/.env")"
  forget_starts
  STUB_MV_SIGNAL=TERM install_sh "$TOK2
" install --new-token
  expect "the run stops with an error" test "$RC" != 0
  expect "the new .env was private before it took the old one's place" test "$(cat "$STATE/env-tmp-mode")" = "600 0:0"
  expect "the new token had connected before it was saved" test "$(head -n 1 "$STATE/up-tokens") $(head -n 1 "$STATE/up-env-tokens")" = "$TOK2 $TOK"
  expect ".env is unchanged, the old token in it" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "the temporary file was removed on the way out" test "$(find "$R" -name '.env.*' | wc -l)" = 0
  expect "the new token is in no file" test -z "$(grep -rlF -- "$TOK2" "$R")"
  expect "the site is started again on the old token" test "$(last_up_token)" = "$TOK"
  expect "says the new token was not saved" has "$ERR" "the new token was not saved"
  expect "no part of a token is shown" no_token_part_shown
}

test_new_token_without_a_usable_answer_changes_nothing() {
  new_sandbox
  tunnel_install
  local before input; before="$(snapshot)"
  # No answer at all, then three answers that are not tokens.
  for input in "" "one
two
three
"; do
    forget_starts
    install_sh "$input" install --new-token
    expect "the run stops" test "$RC" = 1
    expect "every file is as it was" test "$(snapshot)" = "$before"
    expect "nothing was started or stopped" test "$(grep -cE ' (up|down) ' "$LOG")" = 0
    expect "says nothing was changed" has "$ERR" "Nothing was changed"
    expect "says the stored token is still the one in use" has "$ERR" "the token already stored is still the one in use"
    expect "names the command to try again" has "$ERR" "sudo bash $SCRIPT install --new-token"
    expect "no part of a token is shown" no_token_part_shown
  done
  # An empty paste keeps the token.
  forget_starts
  install_sh "
" install --new-token
  expect "an empty answer succeeds" test "$RC" = 0
  expect "every file is as it was" test "$(snapshot)" = "$before"
  expect "the site runs on the old token" test "$(last_up_token)" = "$TOK"
  # A dry run with a new token starts nothing and saves nothing.
  forget_starts
  install_sh "$TOK2
" install --new-token --dry-run
  expect "a dry run succeeds" test "$RC" = 0
  expect "a dry run changes no file" test "$(snapshot)" = "$before"
  expect "a dry run starts nothing" test ! -e "$STATE/up-tokens"
  expect "a dry run shows no part of a token" no_token_part_shown
  # A new token that does not connect: not saved, and the message says what to run.
  forget_starts
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "$TOK2
" install --new-token
  expect "a token that does not connect fails" test "$RC" != 0
  expect "every file is as it was" test "$(snapshot)" = "$before"
  expect "the site is started again on the old token" test "$(wc -l <"$STATE/up-tokens") $(last_up_token)" = "2 $TOK"
  expect "says the new token was not saved" has "$ERR" "the new token was not saved"
  expect "says the site was started again and had been out of reach" has "$ERR" "The site is started again on the previous token; it could not be reached while the new one was tried."
  expect "names the command to try again" has "$ERR" "sudo bash $SCRIPT install --new-token"
  expect "no part of a token is shown" no_token_part_shown
}

test_asking_for_the_token_again_says_what_happened_and_what_to_do() {
  new_sandbox
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "the first run fails" test "$RC" != 0
  expect "the failed run names the command to run next" has "$ERR" "Run: sudo bash $SCRIPT install"
  expect "the failed run shows no part of the token" no_token_part_shown
  # Three answers that are not tokens: nothing changes, and the message says what to run.
  local before; before="$(snapshot)"
  install_sh "one
two
three
" install
  expect "three bad answers stop" test "$RC" = 1
  expect "every file is as it was" test "$(snapshot)" = "$before"
  expect "says what happened" has "$OUT" "The last install here did not finish"
  expect "says nothing was changed" has "$ERR" "Nothing was changed"
  expect "names the command to try again" has "$ERR" "run: sudo bash $SCRIPT install"
  # The right way out: the same command, and Enter keeps the stored token.
  install_sh "
" install
  expect "the next run succeeds on an empty answer" test "$RC" = 0
  expect "says what happened" has "$OUT" "The last install here did not finish: its tunnel never connected to Cloudflare, so the site cannot be reached yet"
  expect "says what to do" has "$OUT" "Paste the tunnel token again at the question below"
  expect "says Enter keeps the stored token" has "$OUT" "press Enter to keep the token already stored"
  expect "uses no word for the script's own bookkeeping" test "$(cat "$OUT" "$ERR" | grep -ciE 'pending|marker')" = 0
  expect "no part of a token is shown" no_token_part_shown
  # On a working install, --new-token says what it is about to do.
  install_sh "$TOK2
" install --new-token
  expect "--new-token succeeds" test "$RC" = 0
  expect "says the old token stays until the new one works" has "$OUT" "The token in use now stays in"
  expect "says the site is out of reach for a moment" has "$OUT" "the site cannot be reached for a moment"
  expect "does not claim nothing happens" test "$(cat "$OUT" "$ERR" | grep -c 'keeps running')" = 0
  expect "no part of a token is shown" no_token_part_shown
}

test_new_token_without_an_install_stops_early() {
  new_sandbox
  local before args; before="$(snapshot)"
  for args in "--new-token" "--new-token --yes" "--tunnel --new-token --yes" "--new-token --dry-run"; do
    # shellcheck disable=SC2086
    TUNNEL_TOKEN="$TOK" install_sh "$TUNNEL_ANSWERS" install $args
    expect "$args: refused" test "$RC" = 1
    expect "$args: says nothing is installed here" has "$ERR" "nothing is installed on this machine"
    expect "$args: names the command that installs in tunnel mode" has "$ERR" "run: sudo bash $SCRIPT install --tunnel"
    expect "$args: says nothing was changed" has "$ERR" "Nothing was changed"
    expect "$args: asks no question" test "$(grep -cE 'Domain name for the platform|Tunnel token from|Choice \[1\]|Continue' "$ERR")" = 0
    expect "$args: runs no command" test ! -s "$LOG"
    expect "$args: writes nothing" test "$(snapshot)" = "$before"
    expect "$args: no part of a token is shown" no_token_part_shown
  done
  # On a direct install: refused before anything is looked at or run.
  new_sandbox
  fresh_install
  before="$(snapshot)"
  : >"$LOG"
  TUNNEL_TOKEN="$TOK" install_sh "$TOK
" install --new-token
  expect "direct: refused" test "$RC" = 1
  expect "direct: says this install is not in tunnel mode" has "$ERR" "this install is not in tunnel mode"
  expect "direct: says nothing was changed" has "$ERR" "Nothing was changed"
  expect "direct: names the command without the option" has "$ERR" "sudo bash $SCRIPT install"
  expect "direct: runs no command" test ! -s "$LOG"
  expect "direct: writes nothing" test "$(snapshot)" = "$before"
  expect "direct: no part of a token is shown" no_token_part_shown
}

test_update_leaves_a_tunnel_that_never_connected_marked() {
  new_sandbox
  tunnel_install
  # The state a run killed outright can leave: the stack files, and the mark.
  printf 'x\n' >"$INST/.tunnel-pending"; chmod 600 "$INST/.tunnel-pending"
  local code; code="$(setup_code)"
  forget_starts
  install_sh "" update
  expect "update succeeds" test "$RC" = 0
  expect "the mark is still there" test -f "$INST/.tunnel-pending"
  expect "says at the start that the install is not finished" has "$ERR" "this install was never finished"
  expect "the closing message says so again" test "$(tail -n 1 "$ERR" | grep -c 'this install is still not finished')" = 1
  expect "and names the command" test "$(tail -n 1 "$ERR" | grep -cF "Run: sudo bash $SCRIPT install")" = 1
  expect "update does not print the setup code" test "$(cat "$OUT" "$ERR" | grep -c -- "$code")" = 0
  expect "update asks nothing" hasnt "$ERR" "Tunnel token from"
  expect "no part of a token is shown" no_token_part_shown
  install_sh "" update --dry-run
  expect "a dry run of update succeeds" test "$RC" = 0
  expect "a dry run leaves the mark" test -f "$INST/.tunnel-pending"
  expect "a dry run repeats what to do" has "$ERR" "Run: sudo bash $SCRIPT install"
  # An update whose tunnel does not connect: still marked, and the last line says what to do.
  forget_starts
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "" update
  expect "an update that does not turn healthy fails" test "$RC" != 0
  expect "the mark is still there" test -f "$INST/.tunnel-pending"
  expect "the closing message repeats what to do" test "$(tail -n 1 "$ERR" | grep -cF "Run: sudo bash $SCRIPT install")" = 1
  expect "no part of a token is shown" no_token_part_shown
  # The command the message names finishes the install: it confirms the tunnel, removes
  # the mark and prints the setup code once.
  install_sh "
" install
  expect "install succeeds" test "$RC" = 0
  expect "the mark is gone once the tunnel is confirmed" test ! -e "$INST/.tunnel-pending"
  expect "the setup code is printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  install_sh "" update
  expect "update on the finished install succeeds" test "$RC" = 0
  expect "and says nothing about an unfinished install" test "$(cat "$OUT" "$ERR" | grep -c 'not finished')" = 0
  # After a first install that failed on the token, the stack file is gone: update stops,
  # leaves the mark and says what to run.
  new_sandbox
  STUB_FAIL_UP=tunnel install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "the first install fails" test "$RC" != 0
  local before; before="$(snapshot)"
  install_sh "" update
  expect "update stops" test "$RC" = 1
  expect "nothing changed, the mark included" test "$(snapshot)" = "$before"
  expect "the closing message repeats what to do" test "$(tail -n 1 "$ERR" | grep -cF "Run: sudo bash $SCRIPT install")" = 1
  expect "no part of a token is shown" no_token_part_shown
}

# ---------------------------------------------------------------- tunnel mode: review of the follow-ups

# S1: a second signal while the site is being started again does not cut that short.
test_a_second_signal_does_not_stop_the_site_being_started_again() {
  local sig
  for sig in TERM INT; do
    # Interrupted, then signalled again during the start on the previous token.
    new_sandbox
    tunnel_install
    forget_starts
    STUB_UP_SIGNAL="$sig" STUB_UP_SIGNAL_ON="1 2" install_sh "$TOK2
" install --new-token
    expect "$sig twice: the run ends with an error" test "$RC" != 0
    expect "$sig twice: the site was started again on the old token" test "$(wc -l <"$STATE/up-tokens") $(last_up_token)" = "2 $TOK"
    expect "$sig twice: the site is marked running by that start" test -e "$STATE/running"
    expect "$sig twice: the closing message is still printed" has "$ERR" "To replace the token, run: sudo bash $SCRIPT install --new-token"
    expect "$sig twice: containers and .env agree" containers_match_env
    # The new token does not connect, and the signal comes during the start that follows.
    new_sandbox
    tunnel_install
    forget_starts
    STUB_FAIL_UP=tunnel STUB_UP_SIGNAL="$sig" STUB_UP_SIGNAL_ON="2" install_sh "$TOK2
" install --new-token
    expect "$sig in the restore: the run ends with an error" test "$RC" != 0
    expect "$sig in the restore: the last start is on the old token" test "$(last_up_token)" = "$TOK"
    expect "$sig in the restore: the site is marked running" test -e "$STATE/running"
    expect "$sig in the restore: .env holds the old token" test "$(env_token)" = "$TOK"
    expect "$sig in the restore: says the new token was not saved" has "$ERR" "the new token was not saved"
    expect "$sig in the restore: names the command to try again" has "$ERR" "sudo bash $SCRIPT install --new-token"
    expect "$sig in the restore: no part of a token is shown" no_token_part_shown
  done
}

# S2: once the tunnel has connected on the new token it is saved, whatever a later step does.
test_a_new_token_that_connected_is_kept_when_a_later_step_fails() {
  new_sandbox
  tunnel_install
  printf '# edited by hand\n' >>"$INST/caddy/Caddyfile"
  forget_starts
  STUB_FAIL_RESTART=1 install_sh "$TOK2
" install --new-token
  expect "the failed Caddy restart fails the run" test "$RC" != 0
  expect "Caddy was being restarted" grep -q 'compose .* restart caddy$' "$LOG"
  expect "the new token, which connected, is in .env" test "$(env_token)" = "$TOK2"
  expect "the stack was not started again on the old token" test "$(wc -l <"$STATE/up-tokens") $(last_up_token)" = "1 $TOK2"
  expect "does not say the token was not saved" hasnt "$ERR" "was not saved"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "containers and .env agree" containers_match_env
  expect "no part of a token is shown" no_token_part_shown
  # The token is saved before Caddy is restarted.
  new_sandbox
  tunnel_install
  printf '# edited by hand\n' >>"$INST/caddy/Caddyfile"
  forget_starts
  install_sh "$TOK2
" install --new-token
  expect "the run succeeds" test "$RC" = 0
  expect "saving comes before the Caddy restart" test "$(grep -nE 'saving it in|Restarting Caddy' "$OUT" | sed 's/^[0-9]*:==> //; s/ .*//' | tr '\n' ' ')" = "The Restarting "
}

# S3: while the tunnel has never connected there is no working token to protect, so the
# token given is saved at once and the containers never run on a token .env does not hold.
test_a_retry_on_an_unfinished_install_keeps_env_and_containers_in_step() {
  new_sandbox
  tunnel_install
  printf 'x\n' >"$INST/.tunnel-pending"; chmod 600 "$INST/.tunnel-pending"
  forget_starts
  STUB_FAIL_UP=tunnel STUB_CF_LOG="cloudflared-1  | ERR edge discovery: error looking up Cloudflare edge IPs" install_sh "$TOK2
" install
  expect "the retry fails" test "$RC" != 0
  expect "this run replaced no file" test "$(find "$R" -name '*.bak-*' | wc -l)" = 0
  expect "the token given is in .env" test "$(env_token)" = "$TOK2"
  expect "cloudflared runs on the token .env holds" containers_match_env
  expect "there was one start, and nothing was taken down" test "$(wc -l <"$STATE/up-tokens") $(grep -c ' down' "$LOG")" = "1 0"
  expect "still marked as never connected" test -f "$INST/.tunnel-pending"
  expect ".env is still 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "no copy of .env was made" test "$(find "$R" -name '.env.*' | wc -l)" = 0
  expect "names the command to run next" has "$ERR" "Run: sudo bash $SCRIPT install"
  expect "no part of a token is shown" no_token_part_shown
  # Interrupted instead: the same.
  forget_starts
  STUB_UP_SIGNAL=TERM install_sh "$TOK
" install
  expect "interrupted: exit code 143" test "$RC" = 143
  expect "interrupted: cloudflared runs on the token .env holds" containers_match_env
  expect "interrupted: one start, no second one" test "$(wc -l <"$STATE/up-tokens")" = 1
  # The network is put right: Enter keeps the token, and the run finishes the install.
  forget_starts
  install_sh "
" install
  expect "the next run succeeds" test "$RC" = 0
  expect "on the token given last" test "$(env_token) $(last_up_token)" = "$TOK $TOK"
  expect "the mark is gone" test ! -e "$INST/.tunnel-pending"
}

# N1: whether Caddy runs is asked of Docker itself, so it is answered also when .env has
# no token for Compose to fill in; a changed Caddyfile then still gets its restart.
test_caddy_is_restarted_when_env_had_no_token() {
  new_sandbox
  tunnel_install
  sed -i '/^TUNNEL_TOKEN=/d' "$INST/.env"
  printf '# edited by hand\n' >>"$INST/caddy/Caddyfile"
  forget_starts
  install_sh "$TOK2
" install --new-token
  expect "the run succeeds" test "$RC" = 0
  expect "whether Caddy runs is asked by label, not through the stack file" grep -qx 'docker ps -q --filter label=com.docker.compose.project=demo-platform --filter label=com.docker.compose.service=caddy' "$LOG"
  expect "Caddy was restarted for the new Caddyfile" grep -q 'compose .* restart caddy$' "$LOG"
  expect "the token is in .env" test "$(env_token)" = "$TOK2"
  expect "containers and .env agree" containers_match_env
  expect "no Compose command failed for a missing token" test "$(cat "$OUT" "$ERR" | grep -c 'missing a value')" = 0
}

# N2: a stack that was not running is not "started again".
test_new_token_on_a_stopped_stack_does_not_claim_the_site_runs() {
  local how
  for how in fails interrupted; do
    new_sandbox
    tunnel_install
    install_sh "" uninstall --yes
    expect "$how: uninstall succeeds" test "$RC" = 0
    local env_sum; env_sum="$(sha256sum <"$INST/.env")"
    forget_starts
    if [ "$how" = fails ]; then
      STUB_FAIL_UP=tunnel install_sh "$TOK2
" install --new-token
    else
      STUB_UP_SIGNAL=TERM install_sh "$TOK2
" install --new-token
    fi
    expect "$how: the run ends with an error" test "$RC" != 0
    expect "$how: .env is unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
    expect "$how: no start on the old token" test "$(wc -l <"$STATE/up-tokens")" = 1
    expect "$how: what the run started is taken down" grep -q 'compose .* down$' "$LOG"
    expect "$how: nothing is left running" test ! -e "$STATE/running"
    expect "$how: says the platform was not running before" has "$ERR" "was not running before this run"
    expect "$how: says at the start that the platform is not running" has "$OUT" "The platform is not running now"
    expect "$how: does not claim the site runs" test "$(cat "$OUT" "$ERR" | grep -cE 'keeps running|is started again on the previous token')" = 0
    expect "$how: says the new token was not saved" has "$ERR" "the new token was not saved"
    expect "$how: no part of a token is shown" no_token_part_shown
  done
}

# N3: a replaced file that cannot be copied back is left as it is, never emptied.
test_a_failed_copy_back_never_empties_a_file() {
  new_sandbox
  tunnel_install
  stub_cp
  printf '# previous working state\n' >>"$INST/docker-compose.yml"
  forget_starts
  STUB_FAIL_UP=tunnel STUB_FAIL_RESTORE_CP=1 install_sh "$TOK2
" install --new-token
  expect "the run fails" test "$RC" != 0
  expect "the stack file is not empty: it is the one this run wrote" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  expect "says which file could not be put back" has "$ERR" "could not put back"
  expect "the copy this run saved is still there" test "$(find "$INST" -maxdepth 1 -name 'docker-compose.yml.bak-*' | wc -l)" = 1
  expect "no temporary file is left" test "$(find "$R" -name '.restore.*' | wc -l)" = 0
  expect "the site is still started again on the old token" test "$(last_up_token) $(env_token)" = "$TOK $TOK"
}

# N4: a temporary .env left by a run that was killed outright is removed, unread.
test_a_leftover_temporary_env_file_is_removed() {
  new_sandbox
  tunnel_install
  printf 'TUNNEL_TOKEN=%s\n' "$TOK2" >"$INST/.env.new.Ab12Cd"; chmod 600 "$INST/.env.new.Ab12Cd"
  mkdir "$INST/.env.new.folder"
  local env_sum; env_sum="$(sha256sum <"$INST/.env")"
  install_sh "" install --dry-run
  expect "a dry run leaves it" test -f "$INST/.env.new.Ab12Cd"
  install_sh "" install
  expect "the run succeeds" test "$RC" = 0
  expect "the leftover file is gone" test ! -e "$INST/.env.new.Ab12Cd"
  expect "says so, by name only" has "$OUT" ".env.new.Ab12Cd"
  expect "a folder of that name is not touched" test -d "$INST/.env.new.folder"
  expect ".env is unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect "its content is not shown" no_token_part_shown
  expect "the token in it is in no file" test -z "$(grep -rlF -- "$TOK2" "$R")"
}

# N5: a signal where no new token is on trial starts nothing again.
test_a_signal_without_a_token_on_trial_starts_nothing_again() {
  # A first install, tunnel and direct.
  new_sandbox
  STUB_UP_SIGNAL=TERM install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "first tunnel install: exit code 143" test "$RC" = 143
  expect "first tunnel install: one start only" test "$(wc -l <"$STATE/up-tokens")" = 1
  expect "first tunnel install: no word of a previous token" test "$(cat "$OUT" "$ERR" | grep -c 'previous token')" = 0
  new_sandbox
  STUB_UP_SIGNAL=INT install_sh "$ANSWERS" install --yes
  expect "first direct install: exit code 130" test "$RC" = 130
  expect "first direct install: one start only" test "$(wc -l <"$STATE/up-tokens")" = 1
  expect "first direct install: no word of a previous token" test "$(cat "$OUT" "$ERR" | grep -c 'previous token')" = 0
  # A later run of a direct install, and of a tunnel install whose token is not changed.
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  forget_starts
  STUB_UP_SIGNAL=HUP install_sh "" install
  expect "direct rerun: exit code 129" test "$RC" = 129
  expect "direct rerun: one start only" test "$(wc -l <"$STATE/up-tokens")" = 1
  expect "direct rerun: no file changed" test "$(snapshot)" = "$before"
  new_sandbox
  tunnel_install
  before="$(snapshot)"
  forget_starts
  STUB_UP_SIGNAL=TERM install_sh "" install
  expect "tunnel rerun: exit code 143" test "$RC" = 143
  expect "tunnel rerun: one start only" test "$(wc -l <"$STATE/up-tokens")" = 1
  expect "tunnel rerun: no file changed" test "$(snapshot)" = "$before"
  expect "tunnel rerun: no word of a new token" test "$(cat "$OUT" "$ERR" | grep -c 'was not saved')" = 0
}

# ---------------------------------------------------------------- two addresses

test_app_domain_validation() {
  new_sandbox; load_functions
  parse_args; [ -z "$APP_DOMAIN_FLAG" ] || die "an app address without the option"
  parse_args install "--app-domain=$APP"; [ "$APP_DOMAIN_FLAG" = "$APP" ] || die "--app-domain=<name>"
  APP_DOMAIN_FLAG=""; parse_args "--app-domain=$APP" --yes; [ "$COMMAND $APP_DOMAIN_FLAG" = "install $APP" ] || die "the default command"
  local bad
  for bad in "--app-domain=" "--app-domain" "--app-domain=APP.example.com" "--app-domain=https://app.example.com" \
             "--app-domain=app.example.com/x" "--app-domain=localhost" "--app-domain=1.2.3.4" "--app-domain=app.example.com." \
             "--app-domain=*.example.com" "--app-domain=a_b.example.com" "--app-domain=$APP --app-domain=other.example.com" \
             "update --app-domain=$APP" "status --app-domain=$APP" "backup --app-domain=$APP" "uninstall --app-domain=$APP"; do
    # shellcheck disable=SC2086
    (set -f; APP_DOMAIN_FLAG=""; parse_args $bad) >/dev/null 2>&1; [ $? = 2 ] || die "accepted: $bad"
  done
  # The messages, and that a refused option changes nothing.
  install_sh "$ANSWERS" install --yes "--app-domain=https://app.example.com"
  expect "a name with a scheme is refused" test "$RC" = 2
  expect "says what the option takes" has "$ERR" "--app-domain must be a host name in lowercase, such as app.example.com, without https:// and without a path"
  expect "nothing written" test ! -e "$R/opt"
  expect "no command run" test ! -s "$LOG"
  install_sh "" update "--app-domain=$APP"
  expect "the option with update is refused" test "$RC" = 2
  expect "says where it goes" has "$ERR" "--app-domain goes only with install"
  install_sh "" --help
  expect "the usage text names the option" has "$OUT" "  --app-domain=<name>  With install: a second address, for the app. The domain asked for stays the address of the tours."
}

test_fresh_install_with_app_domain_writes_env_compose_and_two_address_caddyfile() {
  new_sandbox
  two_install
  local code; code="$(setup_code)"
  local want="# Written by install.sh. Root only: SETUP_CODE claims this install. Never share or commit.
DOMAIN=$DOMAIN
APP_DOMAIN=$APP
ACME_EMAIL=$EMAIL
DATA_DIR=/opt/demo-platform/data
APP_IMAGE=demo-platform:latest
SETUP_CODE=$code"
  expect ".env is the direct-mode file with the app address in it" test "$(cat "$INST/.env")" = "$want"
  expect ".env is 600 root" test "$(stat -c '%a %u:%g' "$INST/.env")" = "600 0:0"
  expect "compose file is the deploy copy" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
  # shellcheck disable=SC2016 # the literal compose placeholders
  expect "the app gets the tours address only when there is an app address" grep -qxF '      TOURS_HOST: ${APP_DOMAIN:+${DOMAIN}}' "$INST/docker-compose.yml"
  # shellcheck disable=SC2016
  expect "the app gets the app address" grep -qxF '      APP_HOST: ${APP_DOMAIN:-}' "$INST/docker-compose.yml"
  # shellcheck disable=SC2016
  expect "Caddy gets the app address" grep -qxF '      APP_DOMAIN: ${APP_DOMAIN:-}' "$INST/docker-compose.yml"
  expect "Caddyfile is the two-address copy" cmp -s "$INST/caddy/Caddyfile" /src/caddy/Caddyfile.two
  # shellcheck disable=SC2016 # the literal Caddyfile placeholders
  expect "one site block for both names" grep -qxF '{$DOMAIN}, {$APP_DOMAIN} {' "$INST/caddy/Caddyfile"
  expect "Caddyfile is 600 root" test "$(stat -c '%a %u:%g' "$INST/caddy/Caddyfile")" = "600 0:0"
  expect "the summary names the app address" has "$OUT" "app address: $APP"
  expect "the DNS record of the tours address is checked" has "$OUT" "$DOMAIN resolves to $HERE, an address of this server"
  expect "the DNS record of the app address is checked" has "$OUT" "$APP resolves to $HERE, an address of this server"
  expect "the stack is started before an address is asked" test "$(grep -nE ' up -d |/healthz$' "$LOG" | head -n 1 | grep -c ' up -d ')" = 1
  expect "the tours address is asked for its role, once" test "$(asked "$DOMAIN")" = 1
  expect "the app address is asked for its role, once" test "$(asked "$APP")" = 1
  expect "asked over HTTPS only, and without reading a curl settings file" test "$(grep -c '^curl -q --proto =https --tlsv1.2 ' "$LOG")" = 2
  expect "-q is the first argument of every question" test "$(grep -c 'healthz$' "$LOG")" = "$(grep -c '^curl -q .*healthz$' "$LOG")"
  expect "says both addresses and which one Mythicshot uses" has "$OUT" "Tours are at https://$DOMAIN; the app address is https://$APP. Mythicshot keeps using https://$DOMAIN."
  expect "the wizard is on the tours address" has "$OUT" "https://$DOMAIN/setup"
  expect "no wizard address on the app address" hasnt "$OUT" "https://$APP/setup"
  expect "code printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "code never on a stub's command line" hasnt "$LOG" "$code"
  expect "no temporary files left" test "$(find "$R" -name '.*.new.*' | wc -l)" = 0
  # Run again, with and without the option: nothing changes.
  local before; before="$(snapshot)"
  : >"$LOG"
  STUB_RESOLVE="$HERE" install_sh "" install
  expect "second run succeeds without input" test "$RC" = 0
  expect "every file, mode and owner unchanged" test "$(snapshot)" = "$before"
  expect "both addresses are asked again" test "$(asked "$DOMAIN") $(asked "$APP")" = "1 1"
  expect "the code is not printed again" hasnt "$OUT" "$code"
  STUB_RESOLVE="$HERE" install_sh "" install "--app-domain=$APP"
  expect "the recorded name given again is fine" test "$RC" = 0
  expect "still unchanged" test "$(snapshot)" = "$before"
  # status names both addresses and asks each for its role.
  : >"$LOG"
  STUB_RESOLVE="$HERE" install_sh "" status
  expect "status succeeds" test "$RC" = 0
  expect "status names the tours address" has "$OUT" "address: https://$DOMAIN"
  expect "status names the app address" has "$OUT" "app address: https://$APP"
  expect "status asks both addresses" test "$(asked "$DOMAIN") $(asked "$APP")" = "1 1"
  STUB_HEALTH_APP='{"ok":true,"address":"tours"}' STUB_RESOLVE="$HERE" install_sh "" status
  expect "status fails when an address reports the wrong role" test "$RC" = 1
  expect "status says which" has "$ERR" "$(wrong_role "$APP" app)"
}

test_each_address_must_report_its_own_role() {
  # The app address is seen as the tours address (something rewrites the Host header).
  new_sandbox
  STUB_HEALTH_APP='{"ok":true,"address":"tours"}' STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "the run fails" test "$RC" = 1
  expect "names the address and the role it should have" has "$ERR" "$(wrong_role "$APP" app)"
  expect "does not blame the address that is right" hasnt "$ERR" "https://$DOMAIN/healthz answered"
  expect "the install is not undone: .env" test -f "$INST/.env"
  expect "the install is not undone: stack file" test -f "$INST/docker-compose.yml"
  expect "the install is not undone: Caddyfile" cmp -s "$INST/caddy/Caddyfile" /src/caddy/Caddyfile.two
  expect "the install is not undone: data folder" test -d "$DATA"
  expect "nothing is taken down" hasnt "$LOG" " down"
  expect "says nothing was removed" hasnt "$ERR" "removed "
  expect "the setup code is still printed, once" test "$(grep -c -- "$(setup_code)" "$OUT")" = 1
  # The next run finds the same and fails the same way, changing nothing.
  local before; before="$(snapshot)"
  STUB_HEALTH_APP='{"ok":true,"address":"tours"}' STUB_RESOLVE="$HERE" install_sh "" install
  expect "the next run fails too" test "$RC" = 1
  expect "and changes nothing" test "$(snapshot)" = "$before"
  # Each address is seen in the other's role.
  new_sandbox
  STUB_HEALTH_TOURS='{"ok":true,"address":"app"}' STUB_HEALTH_APP='{"ok":true,"address":"tours"}' STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "both wrong: the run fails" test "$RC" = 1
  expect "both wrong: names the tours address" has "$ERR" "$(wrong_role "$DOMAIN" tours)"
  expect "both wrong: names the app address" has "$ERR" "$(wrong_role "$APP" app)"
  # A name that does not point at this server yet is not asked, and that is no failure.
  new_sandbox
  STUB_RESOLVE="$HERE" STUB_NO_RESOLVE="$APP" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "unresolved app address: the run succeeds" test "$RC" = 0
  expect "unresolved app address: the tours address is asked" test "$(asked "$DOMAIN")" = 1
  expect "unresolved app address: the app address is not" test "$(asked "$APP")" = 0
  expect "unresolved app address: says it was not asked" has "$ERR" "https://$APP/healthz was not asked"
  expect "unresolved app address: the DNS warning names its record" has "$ERR" "$APP.  A     $HERE"
  new_sandbox
  install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "neither resolves: the run succeeds" test "$RC" = 0
  expect "neither resolves: no address is asked" test "$(grep -c healthz "$LOG")" = 0
  # An address that does not answer is tried again, then reported; that is no failure.
  new_sandbox
  STUB_HEALTH_APP=fail STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "no answer: the run succeeds" test "$RC" = 0
  expect "no answer: tried more than once" test "$(asked "$APP")" -gt 1
  expect "no answer: says so" has "$ERR" "https://$APP/healthz did not answer"
  expect "no answer: does not call it a wrong role" hasnt "$ERR" "answered, but"
  # Interrupted while an address is asked: the stack runs, so the install stays.
  new_sandbox
  STUB_HEALTH_SIGNAL=TERM STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "interrupted: exit code 143" test "$RC" = 143
  expect "interrupted: .env stays" test -f "$INST/.env"
  expect "interrupted: the stack files stay" test -f "$INST/docker-compose.yml" -a -f "$INST/caddy/Caddyfile"
  expect "interrupted: the data folder stays" test -d "$DATA"
  expect "interrupted: nothing is removed or taken down" test "$(grep -c 'removed ' "$ERR") $(grep -c ' down' "$LOG")" = "0 0"
  expect "interrupted: the setup code was printed before, once" test "$(grep -c -- "$(setup_code)" "$OUT")" = 1
  # Without curl the addresses cannot be asked; the run says how to check by hand.
  new_sandbox
  two_install
  rm -f "$T/bin/curl"
  if ! command -v curl >/dev/null 2>&1; then
    STUB_RESOLVE="$HERE" install_sh "" install
    expect "no curl: the run succeeds" test "$RC" = 0
    expect "no curl: says how to check by hand" has "$ERR" "curl is not installed"
  fi
}

test_install_without_app_domain_writes_todays_files() {
  new_sandbox
  STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes
  expect "direct install succeeds" test "$RC" = 0
  expect "the Caddyfile is the one of 0.1.3, byte for byte" test "$(sum_of "$INST/caddy/Caddyfile")" = "$CADDYFILE_0_1_3"
  expect "the deploy copy is that file too" test "$(sum_of /src/caddy/Caddyfile)" = "$CADDYFILE_0_1_3"
  expect ".env has no app address" test "$(grep -c 'APP_DOMAIN' "$INST/.env")" = 0
  expect ".env has six lines, as before" test "$(wc -l <"$INST/.env")" = 6
  expect "no address is asked for its role" test "$(grep -c healthz "$LOG")" = 0
  expect "no curl is run at all" test "$(grep -c '^curl' "$LOG")" = 0
  expect "no word of a second address" test "$(cat "$OUT" "$ERR" | grep -ciE 'app address|APP_DOMAIN|Mythicshot keeps')" = 0
  expect "the closing line is the one from before" has "$OUT" "The platform is running at https://$DOMAIN"
  install_sh "" status
  expect "status has no word of a second address" test "$(cat "$OUT" "$ERR" | grep -ciE 'app address|healthz')" = 0
  new_sandbox
  tunnel_install
  expect "the tunnel Caddyfile is the one of 0.1.3, byte for byte" test "$(sum_of "$INST/caddy/Caddyfile")" = "$TUNNEL_CADDYFILE_0_1_3"
  expect "the tunnel deploy copy is that file too" test "$(sum_of /src/tunnel/caddy/Caddyfile)" = "$TUNNEL_CADDYFILE_0_1_3"
  expect "tunnel: .env has no app address" test "$(grep -c 'APP_DOMAIN' "$INST/.env")" = 0
  expect "tunnel: no address is asked for its role" test "$(grep -c '^curl' "$LOG")" = 0
  expect "tunnel: one published application, as before" has "$OUT" "the tunnel needs one published application (skip this if it is there already):"
  expect "tunnel: no word of a second address" test "$(cat "$OUT" "$ERR" | grep -ciE 'app address|APP_DOMAIN|Mythicshot keeps|each of')" = 0
}

test_app_domain_equal_to_domain_refused() {
  new_sandbox
  install_sh "$ANSWERS" install --yes "--app-domain=$DOMAIN"
  expect "a first install is refused" test "$RC" = 1
  expect "says the two names must differ" has "$ERR" "the app address must be a different name than the tours address"
  expect "nothing written" test ! -e "$R/opt"
  expect "nothing started" hasnt "$LOG" " up "
  expect "it stops at the domain, before the other questions" hasnt "$ERR" "Email for the certificate"
  # The domain is lowercased before it is compared.
  new_sandbox
  install_sh "
APP.Example.COM
$EMAIL

" install --yes "--app-domain=$APP"
  expect "the same name in capitals is refused too" test "$RC" = 1
  expect "nothing written" test ! -e "$R/opt"
  new_sandbox
  install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$DOMAIN"
  expect "tunnel: refused" test "$RC" = 1
  expect "tunnel: before the token is asked for" hasnt "$ERR" "Tunnel token from"
  expect "tunnel: nothing written" test ! -e "$R/opt"
  # On an existing install too.
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  : >"$LOG"
  install_sh "" install "--app-domain=$DOMAIN"
  expect "an existing install: refused" test "$RC" = 1
  expect "an existing install: says the two names must differ" has "$ERR" "the app address must be a different name than the tours address"
  expect "an existing install: nothing changed" test "$(snapshot)" = "$before"
  expect "an existing install: nothing started or stopped" test "$(grep -cE ' (up|down|pull) ' "$LOG")" = 0
}

test_app_domain_on_an_existing_install_is_refused_with_the_steps() {
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  : >"$LOG"
  install_sh "" install --yes "--app-domain=$APP"
  expect "refused" test "$RC" = 1
  expect "says what .env lacks and how to add it" has "$ERR" "this install's .env does not hold APP_DOMAIN=$APP, and install.sh does not change that file. To add the second address, add that line to /opt/demo-platform/.env as root, then run: sudo bash $SCRIPT install"
  expect "nothing changed" test "$(snapshot)" = "$before"
  expect "nothing started or stopped" test "$(grep -cE ' (up|down|pull) ' "$LOG")" = 0
  expect "no address asked" test "$(grep -c '^curl' "$LOG")" = 0
  # Another name than the recorded one is refused the same way.
  new_sandbox
  two_install
  before="$(snapshot)"
  : >"$LOG"
  install_sh "" install "--app-domain=other.example.com"
  expect "another name: refused" test "$RC" = 1
  expect "another name: names the one given" has "$ERR" "does not hold APP_DOMAIN=other.example.com"
  expect "another name: nothing changed" test "$(snapshot)" = "$before"
  expect "another name: nothing started or stopped" test "$(grep -cE ' (up|down|pull) ' "$LOG")" = 0
  # On a tunnel install: refused before the token is touched.
  new_sandbox
  tunnel_install
  before="$(snapshot)"
  forget_starts
  install_sh "$TOK2
" install --new-token "--app-domain=$APP"
  expect "tunnel: refused" test "$RC" = 1
  expect "tunnel: says how to add it" has "$ERR" "does not hold APP_DOMAIN=$APP"
  expect "tunnel: no token question" hasnt "$ERR" "Tunnel token from"
  expect "tunnel: nothing changed" test "$(snapshot)" = "$before"
  expect "tunnel: nothing started" test ! -e "$STATE/up-tokens"
  expect "tunnel: no part of a token is shown" no_token_part_shown
}

test_app_domain_added_by_hand_is_picked_up_and_old_files_backed_up() {
  new_sandbox
  fresh_install
  local code; code="$(setup_code)"
  echo marker >"$DATA/marker"
  # The stack file as a version before two addresses wrote it: without the new lines.
  sed -i '/APP_DOMAIN/d; /TOURS_HOST/d; /APP_HOST/d' "$INST/docker-compose.yml"
  local old_compose; old_compose="$(sum_of "$INST/docker-compose.yml")"
  printf 'APP_DOMAIN=%s\n' "$APP" >>"$INST/.env"
  local env_sum; env_sum="$(sum_of "$INST/.env")"
  : >"$LOG"
  STUB_RESOLVE="$HERE" install_sh "" install
  expect "the run succeeds without input" test "$RC" = 0
  expect ".env is not rewritten" test "$(sum_of "$INST/.env")" = "$env_sum"
  expect "the two-address Caddyfile is written" cmp -s "$INST/caddy/Caddyfile" /src/caddy/Caddyfile.two
  local bak; bak="$(find "$INST/caddy" -name 'Caddyfile.bak-*')"
  expect "one copy of the old Caddyfile" test "$(printf '%s\n' "$bak" | grep -c .)" = 1
  expect "the copy is the one-address Caddyfile" test "$(sum_of "$bak")" = "$CADDYFILE_0_1_3"
  expect "the stack file is the deploy copy" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
  bak="$(find "$INST" -maxdepth 1 -name 'docker-compose.yml.bak-*')"
  expect "one copy of the old stack file" test "$(printf '%s\n' "$bak" | grep -c .)" = 1
  expect "the copy holds the old bytes" test "$(sum_of "$bak")" = "$old_compose"
  expect "Caddy is restarted for the new Caddyfile" grep -q 'compose .* restart caddy$' "$LOG"
  expect "both DNS records are checked" has "$OUT" "$APP resolves to $HERE"
  expect "both addresses are asked for their role" test "$(asked "$DOMAIN") $(asked "$APP")" = "1 1"
  expect "says both addresses" has "$OUT" "Tours are at https://$DOMAIN; the app address is https://$APP. Mythicshot keeps using https://$DOMAIN."
  expect "the setup code is kept and not printed" test "$(setup_code) $(cat "$OUT" "$ERR" | grep -c -- "$code")" = "$code 0"
  expect "the data is kept" test "$(cat "$DATA/marker")" = marker
  # The way back: the line taken out again, and install run again.
  sed -i '/^APP_DOMAIN=/d' "$INST/.env"
  : >"$LOG"
  install_sh "" install
  expect "back to one address succeeds" test "$RC" = 0
  expect "the one-address Caddyfile is back" test "$(sum_of "$INST/caddy/Caddyfile")" = "$CADDYFILE_0_1_3"
  expect "the two-address one was saved first" test "$(find "$INST/caddy" -name 'Caddyfile.bak-*' -exec cmp -s {} /src/caddy/Caddyfile.two \; -print | wc -l)" = 1
  expect "no address is asked any more" test "$(grep -c '^curl' "$LOG")" = 0
  # An empty line is no second address.
  printf 'APP_DOMAIN=\n' >>"$INST/.env"
  install_sh "" install
  expect "an empty APP_DOMAIN is one address" test "$RC $(sum_of "$INST/caddy/Caddyfile")" = "0 $CADDYFILE_0_1_3"
}

# update starts the stack from the files on disk: it refuses to while .env and the
# Caddyfile do not agree on the second address, which only install puts right.
test_update_refuses_until_install_has_written_the_files_for_the_addresses() {
  new_sandbox
  fresh_install
  printf 'APP_DOMAIN=%s\n' "$APP" >>"$INST/.env"
  local before; before="$(snapshot)"
  : >"$LOG"
  install_sh "" update
  expect "update is refused" test "$RC" = 1
  expect "names the command that puts it right" has "$ERR" "Run: sudo bash $SCRIPT install"
  expect "nothing changed" test "$(snapshot)" = "$before"
  expect "nothing pulled, backed up or started" test "$(grep -cE ' (up|down|pull|exec) ' "$LOG")" = 0
  STUB_RESOLVE="$HERE" install_sh "" install
  expect "install puts it right" test "$RC" = 0
  : >"$LOG"
  STUB_RESOLVE="$HERE" install_sh "" update
  expect "update then succeeds" test "$RC" = 0
  expect "update asks both addresses for their role" test "$(asked "$DOMAIN") $(asked "$APP")" = "1 1"
  # The other way round: the line removed, the two-address Caddyfile still there.
  sed -i '/^APP_DOMAIN=/d' "$INST/.env"
  : >"$LOG"
  install_sh "" update
  expect "update is refused the other way round too" test "$RC" = 1
  expect "nothing pulled or started" test "$(grep -cE ' (up|down|pull|exec) ' "$LOG")" = 0
}

test_bad_app_domain_in_env_stops_before_any_change() {
  new_sandbox
  fresh_install
  cp -p "$INST/.env" "$T/env.good"
  local bad cmd before
  for bad in "$DOMAIN" "Not a host" "https://app.example.com" "localhost" "app.example.com/x" "APP.example.com"; do
    cp -p "$T/env.good" "$INST/.env"
    printf 'APP_DOMAIN=%s\n' "$bad" >>"$INST/.env"
    before="$(snapshot)"
    for cmd in install update backup status uninstall; do
      : >"$LOG"
      install_sh "" "$cmd" --yes
      expect "'$bad', $cmd: refused" test "$RC" = 1
      expect "'$bad', $cmd: says what is wrong and that nothing changed" has "$ERR" "$INST/.env has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN; fix it by hand, nothing was changed"
      expect "'$bad', $cmd: nothing changed" test "$(snapshot)" = "$before"
      expect "'$bad', $cmd: nothing started, stopped, pulled or validated" test "$(grep -cE ' (up|down|pull|exec|config|restart) ' "$LOG")" = 0
    done
  done
  cp -p "$T/env.good" "$INST/.env"
  install_sh "" install
  expect "the file put right installs again" test "$RC" = 0
}

test_tunnel_with_app_domain_names_both_published_applications() {
  new_sandbox
  tunnel_two_install
  local code; code="$(setup_code)"
  local want="# Written by install.sh. Root only: SETUP_CODE claims this install and TUNNEL_TOKEN runs its tunnel. Never share or commit.
DOMAIN=$DOMAIN
APP_DOMAIN=$APP
DEPLOY_MODE=tunnel
DATA_DIR=/opt/demo-platform/data
APP_IMAGE=demo-platform:latest
SETUP_CODE=$code
TUNNEL_TOKEN=$TOK"
  expect ".env is the tunnel file with the app address in it" test "$(cat "$INST/.env")" = "$want"
  expect "compose file is the tunnel copy" cmp -s "$INST/docker-compose.yml" /src/tunnel/docker-compose.yml
  expect "Caddyfile is the two-address tunnel copy" cmp -s "$INST/caddy/Caddyfile" /src/tunnel/caddy/Caddyfile.two
  # shellcheck disable=SC2016 # the literal placeholders
  expect "one site block for both names, plain HTTP" grep -qxF 'http://{$DOMAIN}, http://{$APP_DOMAIN} {' "$INST/caddy/Caddyfile"
  expect "no certificate is asked for" has "$INST/caddy/Caddyfile" "auto_https off"
  expect "no service publishes a port" test "$(grep -cE '^[[:space:]]*(ports|network_mode|expose):' "$INST/docker-compose.yml")" = 0
  expect "the app is not handed the whole .env" test "$(grep -cE '^[[:space:]]*env_file:' "$INST/docker-compose.yml")" = 0
  # shellcheck disable=SC2016
  expect "the app gets the tours address by name" grep -qxF '      TOURS_HOST: ${APP_DOMAIN:+${DOMAIN}}' "$INST/docker-compose.yml"
  # shellcheck disable=SC2016
  expect "the app gets the app address by name" grep -qxF '      APP_HOST: ${APP_DOMAIN:-}' "$INST/docker-compose.yml"
  # shellcheck disable=SC2016
  expect "Caddy gets the app address" grep -qxF '      APP_DOMAIN: ${APP_DOMAIN:-}' "$INST/docker-compose.yml"
  expect "says what to set up at Cloudflare for both names" has "$OUT" "give the tunnel a published application for each of $DOMAIN and $APP, both with the service URL http://caddy:80"
  expect "the closing message lists the tours address" has "$OUT" "Hostname:     $DOMAIN"
  expect "the closing message lists the app address" has "$OUT" "Hostname:     $APP"
  expect "with the service URL for each" test "$(grep -c 'Service URL:  http://caddy:80' "$OUT")" = 2
  expect "says both addresses and which one Mythicshot uses" has "$OUT" "Tours are at https://$DOMAIN; the app address is https://$APP. Mythicshot keeps using https://$DOMAIN."
  expect "no DNS check in tunnel mode" hasnt "$OUT" "points at this server"
  expect "each address is asked for its role, after the tunnel has connected" test "$(grep -E ' up -d |/healthz$' "$LOG" | sed 's/^docker.*/up/; s/^curl.*/ask/' | tr '\n' ' ')" = "up ask ask "
  expect "the marker of a tunnel that never connected is gone" test ! -e "$INST/.tunnel-pending"
  expect "code printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "no file but .env holds the token" test "$(grep -rlF -- "$TOK" "$R" | sed "s|^$R||")" = /opt/demo-platform/.env
  expect "the token is not shown" token_not_shown
  : >"$LOG"
  install_sh "" status
  expect "status succeeds" test "$RC" = 0
  expect "status names both published applications" has "$OUT" "published application for each of $DOMAIN and $APP"
  expect "status does not show the token" token_not_shown
  # The app address has no published application yet: it does not answer. No failure.
  new_sandbox
  STUB_HEALTH_APP=fail install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
  expect "no published application yet: the run succeeds" test "$RC" = 0
  expect "no published application yet: says the address did not answer" has "$ERR" "https://$APP/healthz did not answer"
  expect "no published application yet: points at the published application" has "$ERR" "published application"
  # The published application rewrites the Host header: the address reports the other role.
  new_sandbox
  STUB_HEALTH_APP='{"ok":true,"address":"tours"}' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
  expect "wrong role: the run fails" test "$RC" = 1
  expect "wrong role: says which address" has "$ERR" "$(wrong_role "$APP" app)"
  expect "wrong role: the install stays" test -f "$INST/.env"
  expect "wrong role: the tunnel did connect, so the marker is gone" test ! -e "$INST/.tunnel-pending"
  expect "wrong role: the setup code is still printed, once" test "$(grep -c -- "$(setup_code)" "$OUT")" = 1
  expect "wrong role: nothing is taken down" hasnt "$LOG" " down"
  expect "wrong role: the token is not shown" token_not_shown
  # A tunnel that does not connect fails as before, and no address is asked.
  new_sandbox
  STUB_FAIL_UP=tunnel install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
  expect "no connection: the run fails" test "$RC" != 0
  expect "no connection: no address is asked" test "$(grep -c '^curl' "$LOG")" = 0
  expect "no connection: .env keeps the app address for the next run" grep -qx "APP_DOMAIN=$APP" "$INST/.env"
  install_sh "
" install
  expect "the next run finishes the install with both addresses" test "$RC $(asked "$APP")" = "0 1"
}

test_dry_run_with_app_domain_writes_nothing() {
  new_sandbox
  local before; before="$(snapshot)"
  STUB_DOCKER_MISSING=1 STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --dry-run --yes "--app-domain=$APP"
  expect "dry run succeeds" test "$RC" = 0
  expect "the root is unchanged" test "$(snapshot)" = "$before"
  expect "prints the .env write with the app address" has "$OUT" "would write DOMAIN, APP_DOMAIN, ACME_EMAIL, DATA_DIR, APP_IMAGE and a new SETUP_CODE"
  expect "says it would ask both addresses" has "$OUT" "would ask https://$DOMAIN/healthz and https://$APP/healthz"
  expect "says what it would check in the rendered stack file" has "$OUT" "would check that Docker Compose fills in the new stack file with TOURS_HOST=$DOMAIN and APP_HOST=$APP for the app"
  expect "runs no apt-get, curl or compose up" test "$(grep -cE '^(apt-get|curl)| up | config ' "$LOG")" = 0
  expect "prints no setup code" test "$(cat "$OUT" "$ERR" | grep -cE '[0-9a-f]{32}')" = 0
  new_sandbox
  before="$(snapshot)"
  install_sh "$TUNNEL_ANSWERS" install --tunnel --dry-run --yes "--app-domain=$APP"
  expect "tunnel dry run succeeds" test "$RC" = 0
  expect "tunnel: the root is unchanged" test "$(snapshot)" = "$before"
  expect "tunnel: prints the .env write with the app address" has "$OUT" "would write DOMAIN, APP_DOMAIN, DEPLOY_MODE, DATA_DIR, APP_IMAGE, a new SETUP_CODE and the TUNNEL_TOKEN"
  expect "tunnel: says what it would check in the rendered stack file" has "$OUT" "would check that Docker Compose fills in the new stack file with TOURS_HOST=$DOMAIN and APP_HOST=$APP for the app"
  expect "tunnel: runs no curl or compose up" test "$(grep -cE '^curl| up | config ' "$LOG")" = 0
  expect "tunnel: the token is not shown" token_not_shown
  # On an existing two-address install, for every command.
  new_sandbox
  two_install
  before="$(snapshot)"
  : >"$LOG"
  local cmd
  for cmd in install update backup status uninstall; do
    STUB_RESOLVE="$HERE" install_sh "" "$cmd" --dry-run --yes
    expect "$cmd --dry-run succeeds" test "$RC" = 0
  done
  expect "nothing changed by any dry run" test "$(snapshot)" = "$before"
  expect "no dry run asks an address" test "$(grep -c '^curl' "$LOG")" = 0
  # A line added by hand: the dry run says what it would write and writes nothing.
  new_sandbox
  fresh_install
  printf 'APP_DOMAIN=%s\n' "$APP" >>"$INST/.env"
  before="$(snapshot)"
  install_sh "" install --dry-run
  expect "a dry run after the edit succeeds" test "$RC" = 0
  expect "and changes nothing" test "$(snapshot)" = "$before"
}

# ---------------------------------------------------------------- the rendered stack file

# The sentence a run stops with when Compose does not fill in the two settings as expected.
RENDER_SENTENCE='This version of Docker Compose does not read the two-address settings in the stack file the way this script expects, so nothing was changed. Update Docker Compose and run install again.'
# How often the run rendered the staged stack file, with the project folder whose .env
# the start uses.
rendered_staged() { grep -cE "^docker compose --project-name demo-platform --project-directory $INST -f $INST/[^ ]+ config\$" "$LOG" || true; }
# Neither the setup code nor a token is in what the run printed.
no_secret_shown() {
  local code; code="$(setup_code)"
  [ -n "$code" ] && ! grep -qF -- "$code" "$OUT" "$ERR" && ! grep -qF -e "$TOK" -e "$TOK2" "$OUT" "$ERR"
}

test_rendered_addresses_empty_with_one_address_proceeds() {
  new_sandbox
  fresh_install
  expect "direct: the staged stack file was rendered once, after it validated" test "$(rendered_staged) $(grep -n ' config' "$LOG" | head -n 1 | grep -c -- '--quiet')" = "1 1"
  expect "direct: the start follows" test "$(grep -c ' up ' "$LOG")" = 1
  expect "direct: nothing of the rendering reaches a file" test "$(grep -rlF -- "SETUP_CODE: $(setup_code)" "$R" "$T/out" "$T/err" | wc -l)" = 0
  expect "direct: nothing of the rendering is printed" test "$(cat "$OUT" "$ERR" | grep -cE 'TOURS_HOST: |SETUP_CODE: ')" = 0
  : >"$LOG"
  install_sh "" install
  expect "direct: a later run renders again and succeeds" test "$RC $(rendered_staged)" = "0 1"
  expect "direct: a later run shows no secret" no_secret_shown
  new_sandbox
  tunnel_install
  expect "tunnel: the staged stack file was rendered once" test "$(rendered_staged)" = 1
  expect "tunnel: the start follows" test "$(grep -c ' up ' "$LOG")" = 1
  expect "tunnel: the token is not shown" token_not_shown
  expect "tunnel: nothing of the rendering is printed" test "$(cat "$OUT" "$ERR" | grep -cE 'TOURS_HOST: |SETUP_CODE: |TUNNEL_TOKEN: ')" = 0
}

test_rendered_addresses_are_both_names_with_two_addresses_proceeds() {
  new_sandbox
  two_install
  expect "direct: the staged stack file was rendered once" test "$(rendered_staged)" = 1
  expect "direct: the start follows" test "$(grep -c ' up ' "$LOG")" = 1
  expect "direct: nothing of the rendering is printed" test "$(cat "$OUT" "$ERR" | grep -cE 'TOURS_HOST: |SETUP_CODE: ')" = 0
  new_sandbox
  tunnel_two_install
  expect "tunnel: the staged stack file was rendered once" test "$(rendered_staged)" = 1
  expect "tunnel: the start follows" test "$(grep -c ' up ' "$LOG")" = 1
  expect "tunnel: the token is not shown" token_not_shown
  # A new token on trial is in no file yet: the rendering gets it the way the start does.
  forget_starts
  install_sh "$TOK2
" install --new-token
  expect "new token: the run succeeds and rendered once" test "$RC $(rendered_staged)" = "0 1"
  expect "new token: no part of a token is shown" no_token_part_shown
}

test_wrong_rendering_stops_with_nothing_replaced() {
  local mode before
  for mode in direct tunnel; do
    # One address: an existing install, run again.
    new_sandbox
    if [ "$mode" = tunnel ]; then tunnel_install; else fresh_install; fi
    before="$(snapshot)"
    : >"$LOG"
    STUB_RENDER=wrong install_sh "" install
    expect "$mode, one address: the run stops" test "$RC" = 1
    expect "$mode, one address: with the sentence, once" test "$(grep -cF -- "ERROR: $RENDER_SENTENCE" "$ERR")" = 1
    expect "$mode, one address: nothing changed" test "$(snapshot)" = "$before"
    expect "$mode, one address: nothing started or stopped" test "$(grep -cE ' (up|down|restart) ' "$LOG")" = 0
    expect "$mode, one address: no secret shown" no_secret_shown
    # Two addresses: the line added by hand; the two-address Caddyfile is not written.
    printf 'APP_DOMAIN=%s\n' "$APP" >>"$INST/.env"
    before="$(snapshot)"
    : >"$LOG"
    STUB_RENDER=wrong STUB_RESOLVE="$HERE" install_sh "" install
    expect "$mode, two addresses: the run stops" test "$RC" = 1
    expect "$mode, two addresses: with the sentence, once" test "$(grep -cF -- "ERROR: $RENDER_SENTENCE" "$ERR")" = 1
    expect "$mode, two addresses: nothing changed" test "$(snapshot)" = "$before"
    expect "$mode, two addresses: nothing started or stopped" test "$(grep -cE ' (up|down|restart) ' "$LOG")" = 0
    expect "$mode, two addresses: no address is asked" test "$(grep -c healthz "$LOG")" = 0
    expect "$mode, two addresses: no secret shown" no_secret_shown
    expect "$mode, two addresses: nothing of the rendering is shown" test "$(cat "$OUT" "$ERR" | grep -cE 'TOURS_HOST: |SETUP_CODE: |TUNNEL_TOKEN: ')" = 0
    # The same file rendered as expected: the run goes through.
    STUB_RESOLVE="$HERE" install_sh "" install
    expect "$mode: with the right rendering the same run succeeds" test "$RC" = 0
  done
  # A first install: what the run created is removed again, the setup code is not printed.
  for mode in direct tunnel; do
    new_sandbox
    if [ "$mode" = tunnel ]; then
      STUB_RENDER=wrong install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
    else
      STUB_RENDER=wrong STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
    fi
    expect "$mode, first install: the run stops with the sentence" test "$RC $(grep -cF -- "ERROR: $RENDER_SENTENCE" "$ERR")" = "1 1"
    expect "$mode, first install: no .env, stack file or Caddyfile is left" test ! -e "$INST/.env" -a ! -e "$INST/docker-compose.yml" -a ! -e "$INST/caddy/Caddyfile"
    expect "$mode, first install: nothing started" test "$(grep -c ' up ' "$LOG")" = 0
    expect "$mode, first install: no setup code shown" test "$(cat "$OUT" "$ERR" | grep -cE '[0-9a-f]{32}')" = 0
    expect "$mode, first install: the token is not shown" token_not_shown
  done
}

# What install.sh takes out of a rendering: only the app's two settings, each exactly once.
test_rendered_app_hosts_reads_only_the_apps_two_settings() {
  new_sandbox
  load_functions
  local head=$'name: x\nservices:\n  app:\n    environment:\n      SETUP_CODE: secret\n'
  expect "both empty" test "$(printf '%s      APP_HOST: ""\n      TOURS_HOST: ""\n' "$head" | rendered_app_hosts)" = "|"
  expect "both names" test "$(printf '%s      APP_HOST: app.example.com\n      TOURS_HOST: tours.example.com\n    image: x\n' "$head" | rendered_app_hosts)" = "tours.example.com|app.example.com"
  expect "quoted names" test "$(printf '%s      APP_HOST: "app.example.com"\n      TOURS_HOST: %stours.example.com%s\n' "$head" "'" "'" | rendered_app_hosts)" = "tours.example.com|app.example.com"
  expect "a setting without a value is not an empty one" test "$(printf '%s      APP_HOST:\n      TOURS_HOST: ""\n' "$head" | rendered_app_hosts)" != "|"
  expect "one missing: nothing" test "$(printf '%s      APP_HOST: ""\n' "$head" | rendered_app_hosts)" = ""
  expect "another service's do not count" test "$(printf 'services:\n  caddy:\n    environment:\n      APP_HOST: ""\n      TOURS_HOST: ""\n' | rendered_app_hosts)" = ""
  expect "another section of the app does not count" test "$(printf 'services:\n  app:\n    labels:\n      APP_HOST: ""\n      TOURS_HOST: ""\n' | rendered_app_hosts)" = ""
  expect "nothing else is passed on" test "$(printf '%s      APP_HOST: ""\n      TOURS_HOST: ""\n' "$head" | rendered_app_hosts | grep -c secret)" = 0
}

# An app image from before two addresses answers /healthz without any role: the run
# says that, not that something changes the Host header.
test_an_app_older_than_two_addresses_is_named_as_such() {
  new_sandbox
  STUB_HEALTH_TOURS='{"ok":true}' STUB_HEALTH_APP='{"ok":true}' STUB_RESOLVE="$HERE" install_sh "$ANSWERS" install --yes "--app-domain=$APP"
  expect "the run fails" test "$RC" = 1
  expect "says the platform is older, for the tours address" has "$ERR" "$(old_platform "$DOMAIN")"
  expect "says the platform is older, for the app address" has "$ERR" "$(old_platform "$APP")"
  expect "does not use the sentence for a wrong role" hasnt "$ERR" "does not see it as its"
  expect "the install is not undone" test -f "$INST/.env" -a -f "$INST/docker-compose.yml"
  expect "nothing is taken down" hasnt "$LOG" " down"
  # A reply that names the other role keeps the sentence about the Host header.
  STUB_HEALTH_APP='{"ok":true,"address":"tours"}' STUB_RESOLVE="$HERE" install_sh "" install
  expect "another role: the run fails" test "$RC" = 1
  expect "another role: the sentence about the role" has "$ERR" "$(wrong_role "$APP" app)"
  expect "another role: not called an older platform" hasnt "$ERR" "older than two addresses"
  # status and the tunnel route say the same.
  STUB_HEALTH_APP='{"ok":true}' STUB_RESOLVE="$HERE" install_sh "" status
  expect "status: fails" test "$RC" = 1
  expect "status: says the platform is older" has "$ERR" "$(old_platform "$APP")"
  new_sandbox
  STUB_HEALTH_APP='{"ok":true}' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes "--app-domain=$APP"
  expect "tunnel: fails" test "$RC" = 1
  expect "tunnel: says the platform is older" has "$ERR" "$(old_platform "$APP")"
  expect "tunnel: the token is not shown" token_not_shown
}

# TOURS_HOST and APP_HOST are the app's own settings; in a Docker install's .env they do
# nothing, and the script says so instead of leaving the owner to wonder.
test_host_lines_written_by_hand_are_reported_as_having_no_effect() {
  new_sandbox
  fresh_install
  expect "an install without the lines says nothing about them" test "$(cat "$OUT" "$ERR" | grep -cE 'TOURS_HOST|APP_HOST')" = 0
  printf 'TOURS_HOST=%s\nAPP_HOST=%s\n' "$DOMAIN" "handwritten.example.net" >>"$INST/.env"
  local env_sum cmd key; env_sum="$(sum_of "$INST/.env")"
  for cmd in install status update backup; do
    install_sh "" "$cmd"
    expect "$cmd: still succeeds" test "$RC" = 0
    expect "$cmd: says the lines have no effect and names the setting to use" has "$ERR" "TOURS_HOST or APP_HOST line, which has no effect on an install made by this script: a second address is set with APP_DOMAIN"
    expect "$cmd: warns once" test "$(grep -c 'has no effect on an install made by this script' "$ERR")" = 1
    expect "$cmd: prints no value of the lines" test "$(cat "$OUT" "$ERR" | grep -c 'handwritten')" = 0
  done
  expect ".env is left as it is" test "$(sum_of "$INST/.env")" = "$env_sum"
  expect "the one-address Caddyfile stays" test "$(sum_of "$INST/caddy/Caddyfile")" = "$CADDYFILE_0_1_3"
  expect "no address is asked for a role" test "$(grep -c healthz "$LOG")" = 0
  for key in TOURS_HOST APP_HOST; do
    new_sandbox
    tunnel_install
    printf '%s=%s\n' "$key" "handwritten.example.net" >>"$INST/.env"
    install_sh "" install
    expect "tunnel, $key alone: succeeds with the warning" test "$RC $(grep -c 'has no effect on an install made by this script' "$ERR")" = "0 1"
    expect "tunnel, $key alone: the token is not shown" token_not_shown
  done
}

# Compose reads its own environment before .env, so a DOMAIN or APP_DOMAIN left in the
# caller's shell must not reach it.
test_names_in_the_environment_do_not_reach_the_stack() {
  new_sandbox
  DOMAIN=other.example.net APP_DOMAIN=other-app.example.net install_sh "$ANSWERS" install --yes
  expect "a first install succeeds" test "$RC" = 0
  expect "the domain is the one typed" grep -qx "DOMAIN=tours.example.com" "$INST/.env"
  expect "no app address is taken from the environment" test "$(grep -c APP_DOMAIN "$INST/.env")" = 0
  expect "the start was handed neither name by the environment" test "$(sort -u "$STATE/up-names")" = "unset unset"
  rm -f "$STATE/up-names"
  DOMAIN=other.example.net APP_DOMAIN=other-app.example.net install_sh "" install
  expect "a later run succeeds" test "$RC" = 0
  expect "a later run hands over neither name" test "$(sort -u "$STATE/up-names")" = "unset unset"
  expect "the names from the environment appear nowhere" test "$(cat "$OUT" "$ERR" "$LOG" | grep -c 'example\.net')" = 0
}

# ---------------------------------------------------------------- run

echo "== $OS_LINE"
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do run_test "$t"; done
rm -rf -- "$WORK"
echo
echo "$PASSES passed, $FAILS failed on $OS_LINE"
[ "$FAILS" = 0 ]

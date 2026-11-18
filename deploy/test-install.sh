#!/usr/bin/env bash
# Tests deploy/install.sh without a server. On the host it starts one disposable
# official Debian 13 container and one Debian 12 container (no network, the deploy
# folder mounted read-only, removed afterwards) and runs this same file inside each as
# root. Inside, install.sh runs against a temporary root (DP_ROOT) with docker, apt-get,
# curl, gpg, snap, dpkg, dpkg-query, ss, getent and ip replaced by stubs that record what
# would be run; the tests assert on that record and on the files written.
#
# Not covered here, only on a clean server: real package installation, real
# certificate issuance, real ports and a real Cloudflare Tunnel (the tunnel tests use a
# made-up token and the docker stub, so cloudflared never runs here).
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
  *" up "*)
    n=$(cat "$STUB_STATE/ups" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STUB_STATE/ups"
    if [ "${STUB_FAIL_UP:-0}" = 1 ] && [ "$n" = 1 ]; then echo "container app is unhealthy" >&2; exit 1; fi
    touch "$STUB_STATE/running" ;;
  *" down "*) rm -f "$STUB_STATE/running" ;;
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
out=""; prev=""
for a in "$@"; do [ "$prev" != "-o" ] || out="$a"; prev="$a"; done
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
for ip in $STUB_RESOLVE; do echo "$ip      STREAM $2"; done
EOF
  cat >"$b/ip" <<'EOF'
#!/bin/bash
for a in ${STUB_LOCAL_IPS:-203.0.113.10}; do
  echo "2: eth0    inet $a/24 brd 203.0.113.255 scope global eth0"
done
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
# The token appears nowhere in what the run printed or in any stub's command line.
token_not_shown() { ! grep -qF -- "$TOK" "$OUT" "$ERR" "$LOG"; }

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
  for bad in "--tunnel --direct" "update --tunnel" "status --direct" "backup --tunnel" "uninstall --tunnel"; do
    # shellcheck disable=SC2086
    (MODE_FLAG=""; parse_args $bad) >/dev/null 2>&1; [ $? = 2 ] || die "accepted: $bad"
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
  expect "stack started with a health wait" grep -q 'compose .* up -d --pull missing --wait --wait-timeout 120' "$LOG"
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
  expect "containers of the other mode are removed on start" grep -q 'compose .* up -d .*--remove-orphans' "$LOG"
  expect "the token is not shown" token_not_shown
  # And back: the lines taken out again, the email still there.
  install_sh "" uninstall --yes
  sed -i '/^DEPLOY_MODE=/d; /^TUNNEL_TOKEN=/d' "$INST/.env"
  install_sh "" install
  expect "back to direct succeeds" test "$RC" = 0
  expect "the direct stack was written" cmp -s "$INST/docker-compose.yml" /src/docker-compose.yml
  expect "the port check ran again" has "$OUT" "Checking that ports 80 and 443"
}

test_tunnel_failed_start_explains_the_token_and_rolls_back() {
  new_sandbox
  STUB_FAIL_UP=1 STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "fresh run fails" test "$RC" != 0
  expect "shows cloudflared's log" grep -q ' logs .*cloudflared' "$LOG"
  expect "shows the app's log too" grep -q ' logs .*app' "$LOG"
  expect "says the token could not be read" has "$ERR" "is not a complete tunnel token"
  expect "takes the half-started stack down" grep -q 'compose .* down' "$LOG"
  expect ".env removed, the token with it" test ! -e "$INST/.env"
  expect "compose file removed" test ! -e "$INST/docker-compose.yml"
  expect "no file holds the token" test -z "$(grep -rlF -- "$TOK" "$R")"
  expect "the token is not shown" token_not_shown
  new_sandbox
  STUB_FAIL_UP=1 STUB_CF_LOG='cloudflared-1  | ERR Register tunnel error from server side error="Unauthorized: stub"' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "a refused token fails" test "$RC" != 0
  expect "says Cloudflare refused it" has "$ERR" "Cloudflare refused"
  new_sandbox
  STUB_FAIL_UP=1 STUB_CF_LOG='cloudflared-1  | ERR edge discovery: error looking up Cloudflare edge IPs: the DNS query failed' install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "an unreachable Cloudflare fails" test "$RC" != 0
  expect "says it could not reach Cloudflare" has "$ERR" "could not reach Cloudflare"
  expect "names the outbound port" has "$ERR" "7844"
  # A log line that did hold the token would be masked before it is printed.
  new_sandbox
  STUB_FAIL_UP=1 STUB_CF_LOG="cloudflared-1  | token=$TOK" install_sh "$TUNNEL_ANSWERS" install --tunnel --yes
  expect "fails" test "$RC" != 0
  expect "the log line is shown" has "$OUT" "cloudflared-1  | token="
  expect "with the token masked" test "$(cat "$OUT" "$ERR" | grep -cF -- "$TOK")" = 0
  # On an existing install the previous setup is started again and .env stays.
  new_sandbox
  tunnel_install
  printf '# previous working state\n' >>"$INST/docker-compose.yml"
  local env_sum compose_sum; env_sum="$(sha256sum <"$INST/.env")"; compose_sum="$(sha256sum <"$INST/docker-compose.yml")"
  rm -f "$STATE/ups"; : >"$LOG"
  STUB_FAIL_UP=1 STUB_CF_LOG="cloudflared-1  | Provided Tunnel token is not valid." install_sh "" install
  expect "exit code non-zero" test "$RC" != 0
  expect ".env unchanged" test "$(sha256sum <"$INST/.env")" = "$env_sum"
  expect "previous compose file restored" test "$(sha256sum <"$INST/docker-compose.yml")" = "$compose_sum"
  expect "explains the token here too" has "$ERR" "is not a complete tunnel token"
  expect "not taken down" hasnt "$LOG" " down"
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

# ---------------------------------------------------------------- run

echo "== $OS_LINE"
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do run_test "$t"; done
rm -rf -- "$WORK"
echo
echo "$PASSES passed, $FAILS failed on $OS_LINE"
[ "$FAILS" = 0 ]

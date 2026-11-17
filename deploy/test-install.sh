#!/usr/bin/env bash
# Tests deploy/install.sh without a server. On the host it starts one disposable
# official Debian 13 container and one Debian 12 container (no network, the deploy
# folder mounted read-only, removed afterwards) and runs this same file inside each as
# root. Inside, install.sh runs against a temporary root (DP_ROOT) with docker, apt-get,
# curl, dpkg, dpkg-query, ss, getent and ip replaced by stubs that record what would be
# run; the tests assert on that record and on the files written.
#
# Not covered here, only on a clean server: real package installation, real
# certificate issuance and real ports.
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
    docker run --rm --network none --user 0 -v "$SRC:/src:ro" "$image" bash /src/test-install.sh --inside || status=1
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
ANSWERS="$DOMAIN
$EMAIL

"
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
}

write_stubs() {
  local b="$1"
  cat >"$b/docker" <<'EOF'
#!/bin/bash
printf 'docker %s\n' "$*" >>"$STUB_LOG"
args=" $* "
installed() { [ "${STUB_DOCKER_MISSING:-0}" != 1 ] || [ -e "$STUB_STATE/docker-installed" ]; }
if [[ "$args" == *" compose version "* ]]; then installed || exit 1; echo "Docker Compose version v5.0.0"; exit 0; fi
installed || { echo "docker: command not found" >&2; exit 127; }
case "$args" in
  *" up "*)
    n=$(cat "$STUB_STATE/ups" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STUB_STATE/ups"
    if [ "${STUB_FAIL_UP:-0}" = 1 ] && [ "$n" = 1 ]; then echo "container app is unhealthy" >&2; exit 1; fi
    touch "$STUB_STATE/running" ;;
  *" down "*) rm -f "$STUB_STATE/running" ;;
  *" ps -q "*) [ ! -e "$STUB_STATE/running" ] || echo 0123456789ab ;;
  *" exec -T app node dist/node/backup.js "*)
    target="${*: -1}"; printf 'SQLite format 3 (stub copy)\n' >"$STUB_DATA/${target#/data/}"; chown 1001:1001 "$STUB_DATA/${target#/data/}" ;;
  *" inspect "*) echo healthy ;;
esac
exit 0
EOF
  cat >"$b/apt-get" <<'EOF'
#!/bin/bash
printf 'apt-get %s\n' "$*" >>"$STUB_LOG"
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
  echo "2: eth0    inet $a/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever"
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
    STUB_DATA="$DATA" bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}

# Sources install.sh's functions only, against the sandbox root, in the current shell.
# shellcheck source=deploy/install.sh
load_functions() { DP_ROOT="$R" DP_SOURCE_ONLY=1 . "$SCRIPT"; set +e; }

# Every path under the root with its type, mode and owner, and every file's checksum.
snapshot() {
  (cd "$R" && find . -printf '%y %m %u:%g %p\n' | sort && find . -type f -exec sha256sum {} + | sort)
}

fresh_install() { install_sh "$ANSWERS" install --yes; [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "fresh install failed"; }; }
setup_code() { sed -n 's/^SETUP_CODE=//p' "$INST/.env"; }

die() { printf '      %s\n' "$*"; exit 1; }
expect() { local msg="$1"; shift; "$@" || die "$msg"; }
has() { grep -qF -- "$2" "$1"; }
hasnt() { ! grep -qF -- "$2" "$1"; }

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
  for p in /opt/demo-platform/data /srv/demo-platform /var/lib/demo-platform /mnt/disk1/dp /data; do
    valid_data_dir "$p" || die "refused good folder $p"
  done
  for p in "" / relative/x /etc /etc/dp /usr/local/dp /tmp/dp /proc/x /opt /srv /home /var /opt/demo-platform \
           /opt/demo-platform/backups /opt/demo-platform/caddy-data/x /a/../etc "/a b" "/a;b" /var/lib/docker/volumes/x; do
    ! valid_data_dir "$p" || die "accepted bad folder '$p'"
  done
}

test_path_guard() {
  new_sandbox; load_functions
  mkdir -p "$INST" "$R/etc"
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

test_conflicting_packages_refused() {
  new_sandbox
  STUB_DOCKER_MISSING=1 STUB_CONFLICT="docker.io podman-docker" install_sh "$ANSWERS" install --yes
  expect "exit code 1" test "$RC" = 1
  expect "names the packages" has "$ERR" "docker.io podman-docker"
  expect "no apt-get run" hasnt "$LOG" "apt-get"
}

test_invalid_answers_are_asked_again() {
  new_sandbox
  install_sh "not a domain
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
  install_sh "bad
worse
1.2.3.4
" install --yes
  expect "three bad answers stop" test "$RC" = 1
  expect "nothing written" test ! -e "$R/opt"
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
  expect "Docker present: no apt-get" hasnt "$LOG" "apt-get"
  expect "address printed" has "$OUT" "https://$DOMAIN/setup"
  expect "code printed exactly once" test "$(grep -c -- "$code" "$OUT")" = 1
  expect "code not on stderr" hasnt "$ERR" "$code"
  expect "code never on a stub's command line" hasnt "$LOG" "$code"
  expect "no temporary files left" test "$(find "$R" -name '.*.new.*' -o -name '.partial.*' | wc -l)" = 0
  expect "DNS warning names the record" has "$ERR" "$DOMAIN.  A     203.0.113.10"
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
}

test_docker_is_installed_only_when_missing() {
  new_sandbox
  STUB_DOCKER_MISSING=1 install_sh "$ANSWERS" install --yes
  expect "install succeeds" test "$RC" = 0
  local want got
  want="apt-get update
apt-get install -y ca-certificates curl
curl -fsSL https://download.docker.com/linux/debian/gpg -o
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  got="$(grep -E '^(apt-get|curl)' "$LOG" | sed 's/ -o .*/ -o/')"
  expect "the commands from Docker's page, in order" test "$got" = "$want"
  expect "key in place, readable" test "$(stat -c '%a' "$R/etc/apt/keyrings/docker.asc")" = 644
  expect "key is the download" has "$R/etc/apt/keyrings/docker.asc" "BEGIN PGP PUBLIC KEY BLOCK"
  expect "sources file names $CODENAME" grep -qx "Suites: $CODENAME" "$R/etc/apt/sources.list.d/docker.sources"
  expect "sources file arch" grep -qx "Architectures: amd64" "$R/etc/apt/sources.list.d/docker.sources"
  expect "sources file key" grep -qx "Signed-By: /etc/apt/keyrings/docker.asc" "$R/etc/apt/sources.list.d/docker.sources"
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

test_a_failed_compose_up_leaves_data_and_env() {
  new_sandbox
  STUB_FAIL_UP=1 install_sh "$ANSWERS" install --yes
  expect "fresh run fails" test "$RC" != 0
  expect "says nothing was changed" has "$ERR" "were not changed"
  expect ".env still there" test -f "$INST/.env"
  expect "data folder still there" test -d "$DATA"
  # A working install, a hand edit (the previous working state), then a failed start.
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
}

test_update_touches_no_files() {
  new_sandbox
  fresh_install
  local before; before="$(snapshot)"
  : >"$LOG"
  install_sh "" update
  expect "update succeeds" test "$RC" = 0
  expect "no file changed" test "$(snapshot)" = "$before"
  expect "pull, then up" test "$(grep -oE 'compose .* (pull|up -d)' "$LOG" | grep -oE '(pull|up -d)$' | tr '\n' ' ')" = "pull up -d "
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
  echo marker >"$DATA/marker"
  install_sh "" backup
  local answer
  for answer in "wrong.example.com" "" "yes" "TOURS.EXAMPLE.COM"; do
    install_sh "$answer
" uninstall --delete-data --yes
    expect "'$answer' is refused" test "$RC" = 1
    expect "'$answer' keeps the data" test "$(cat "$DATA/marker")" = marker
  done
  install_sh "$DOMAIN
" uninstall --delete-data --yes
  expect "the right name succeeds" test "$RC" = 0
  expect "data folder removed" test ! -e "$DATA"
  expect ".env kept" test -f "$INST/.env"
  expect "backup kept" test "$(find "$INST/backups" -name '*.tar.gz' | wc -l)" = 1
  expect "install folder kept" test -f "$INST/docker-compose.yml"
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

# ---------------------------------------------------------------- run

echo "== $OS_LINE"
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do run_test "$t"; done
rm -rf -- "$WORK"
echo
echo "$PASSES passed, $FAILS failed on $OS_LINE"
[ "$FAILS" = 0 ]

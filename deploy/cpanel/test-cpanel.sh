#!/usr/bin/env bash
# Tests deploy/cpanel/cpanel.sh without any hosting, the way deploy/test-install.sh
# tests install.sh. On the host it starts one disposable official Debian 13 container
# and one Debian 12 container (no network, this folder mounted read-only, an ordinary
# user, removed afterwards) and runs this same file inside each. Inside, each test gets
# a sandbox with its own home folder and a bin folder of stand-ins for
# cloudlinux-selector, npm, node, sqlite3, curl and touch, put in front of PATH. The
# stand-ins record what would be run; the tests assert on that record, on what the
# script printed and on the files it wrote.
#
# Not covered here, only on real hosting: the real cloudlinux-selector, the real Node.js
# environment and its npm, Passenger's restart, the real sqlite3 tool and the hosting's
# web server and certificate in front of /healthz and /api/v1/me. The Debian images have no Node.js, so
# the one test that copies a real database with a real Node.js is skipped there;
# test/node-cpanel-script.test.ts runs that test on the developer's computer.
#
# Usage: bash deploy/cpanel/test-cpanel.sh [test_name ...]    (env: DEBIAN_IMAGES="debian:13 debian:12")
#        bash deploy/cpanel/test-cpanel.sh --inside [test_name ...]   (here, without a container; env: JOBS)
set -euo pipefail

# ================================================================ host side

if [ "${1:-}" != "--inside" ]; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  cd "$(dirname "$0")"
  host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
  SRC="$(host_path "$PWD")"
  status=0
  for image in ${DEBIAN_IMAGES:-debian:13 debian:12}; do
    echo
    echo "######## $image"
    # --init: a real PID 1 that passes Ctrl-C on, so an interrupted run stops. The tests
    # run as an ordinary user, as on shared hosting.
    docker run --rm --init --network none --user 1000:1000 -v "$SRC:/src:ro" "$image" bash /src/test-cpanel.sh --inside "$@" || status=1
  done
  exit "$status"
fi
shift

# ================================================================ the tests

export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd -P)"
SCRIPT="$HERE/cpanel.sh"
APP_CJS="$HERE/app.cjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dp-cpanel-test.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
DOMAIN=tours.example.com
APP_DOMAIN=app.example.com
REAL_TOUCH="$(command -v touch)"
PASSES=0
FAILS=0
SKIPS=0

# Some file systems (a Windows folder under Git Bash) do not keep Unix file modes. The
# mode checks are skipped there, and the run says so.
MODES=1
: >"$WORK/probe"; chmod 600 "$WORK/probe"
[ "$(stat -c %a "$WORK/probe" 2>/dev/null || stat -f %Lp "$WORK/probe" 2>/dev/null)" = 600 ] || MODES=0
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
# Everything under a folder that its group or anyone else may read, write or enter.
open_to_others() { find "$1" \( -perm -g+r -o -perm -g+w -o -perm -g+x -o -perm -o+r -o -perm -o+w -o -perm -o+x \); }
# A path as a program that is not part of this shell's system sees it (Node on Windows).
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# ---------------------------------------------------------------- per-test sandbox

# Sets T (test folder), H (the home folder), LOG (stand-in record), STATE (stand-in
# state) and the paths of the default install.
new_sandbox() {
  T="$(mktemp -d "$WORK/t.XXXXXX")"
  H="$T/home"
  LOG="$T/log"
  STATE="$T/state"
  mkdir -p "$H" "$T/bin" "$STATE"
  : >"$LOG"
  write_stubs "$T/bin"
  APP="$H/apps/tours"
  DATA="$H/apps/tours-data"
  SETTINGS="$H/apps/tours-config.env"
  BACKUPS="$H/backups"
  ACTIVATE="$H/nodevenv/apps/tours/24/bin/activate"
  REL="$T/release"
  make_release "$REL" 0.1.1
}

# Sends a signal to the script under test from inside a stand-in it started: to the
# outermost process that was started as .../cpanel.sh, found by walking up from here.
# shellcheck disable=SC2016 # the text is a function for the stand-ins, expanded when they run
SIGNAL_THE_SCRIPT='
signal_the_script() {
  local p=$PPID target="" n=0 next
  while [ "$n" -lt 5 ] && [ -r "/proc/$p/cmdline" ]; do
    if tr "\0" " " <"/proc/$p/cmdline" | grep -q "/cpanel\.sh "; then target=$p; fi
    next="$(awk "/^PPid:/ {print \$2}" "/proc/$p/status" 2>/dev/null)"
    [ -n "$next" ] || next="$(cat "/proc/$p/ppid" 2>/dev/null)"
    [ -n "$next" ] && [ "$next" != 0 ] && [ "$next" != 1 ] || break
    p=$next; n=$((n + 1))
  done
  [ -z "$target" ] || kill -s "$1" "$target"
}'

write_stubs() {
  local b="$1"
  cat >"$b/cloudlinux-selector" <<'EOF'
#!/bin/bash
printf 'cloudlinux-selector %s\n' "$*" >>"$STUB_LOG"
case "${STUB_SELECTOR:-ok}" in
  fail) echo '{"result": "Application apps/tours already exists", "timestamp": 1.0}'; exit 1 ;;
  error-exit-0) echo '{"result": "Specified directory already used by apps/tours", "timestamp": 1.0}'; exit 0 ;;
esac
root=""; version=""; prev=""
for a in "$@"; do
  [ "$prev" != "--app-root" ] || root="$a"
  [ "$prev" != "--version" ] || version="$a"
  prev="$a"
done
# Like the real command: the app folder and the app's Node.js environment appear.
mkdir -p "$HOME/$root" "$HOME/nodevenv/$root/$version/bin"
printf 'export STUB_VENV=%s/%s\n' "$root" "$version" >"$HOME/nodevenv/$root/$version/bin/activate"
echo '{"result": "success", "timestamp": 1.0}'
EOF
  {
    printf '#!/bin/bash\n%s\n' "$SIGNAL_THE_SCRIPT"
    cat <<'EOF'
printf 'npm[venv=%s cwd=%s] %s\n' "${STUB_VENV:-none}" "$PWD" "$*" >>"$STUB_LOG"
[ "${STUB_NPM_FAIL:-0}" != 1 ] || { echo "npm error code ENOSPC" >&2; exit 1; }
# STUB_NPM_REPLACES_LINK=1: like an npm that removes a node_modules link and makes a folder.
if [ "${STUB_NPM_REPLACES_LINK:-0}" = 1 ]; then rm -rf node_modules; fi
mkdir -p node_modules
# STUB_NPM_SIGNAL=<signal>: the script is interrupted while the packages are installed.
[ -z "${STUB_NPM_SIGNAL:-}" ] || signal_the_script "$STUB_NPM_SIGNAL"
exit 0
EOF
  } >"$b/npm"
  {
    printf '#!/bin/bash\n%s\n' "$SIGNAL_THE_SCRIPT"
    cat <<'EOF'
# Called as: node app.cjs admin <arguments>, by cpanel.sh admin. It records where it ran
# and with what, prints each argument on a line of its own, so a test sees them exactly,
# and exits with STUB_ADMIN_EXIT.
if [ "${1:-}" != "-e" ]; then
  printf 'node[venv=%s umask=%s cwd=%s] %s\n' "${STUB_VENV:-none}" "$(umask)" "$PWD" "$*" >>"$STUB_LOG"
  printf 'stand-in admin command, %s arguments\n' "$#"
  printf 'name[%s]\n' "${DEMO_PLATFORM_ADMIN_NAME:-}"
  for a in "$@"; do printf 'arg[%s]\n' "$a"; done
  exit "${STUB_ADMIN_EXIT:-0}"
fi
# Called as: node -e <program> <database> <copy>. The program text is not recorded.
printf 'node[venv=%s umask=%s] %s <program> %s %s\n' "${STUB_VENV:-none}" "$(umask)" "$1" "$3" "$4" >>"$STUB_LOG"
[ "${STUB_NODE_FAIL:-0}" != 1 ] || { echo "Error: database is locked" >&2; exit 1; }
[ "${STUB_NODE_WRITES_NOTHING:-0}" = 1 ] || printf 'SQLite format 3\0(stand-in copy by node)\n' >"$4"
# STUB_NODE_SIGNAL=<signal>: the script is interrupted while the backup is made.
[ -z "${STUB_NODE_SIGNAL:-}" ] || signal_the_script "$STUB_NODE_SIGNAL"
exit 0
EOF
  } >"$b/node"
  cat >"$b/sqlite3" <<'EOF'
#!/bin/bash
printf 'sqlite3 %s\n' "$*" >>"$STUB_LOG"
[ "${STUB_SQLITE_FAIL:-0}" != 1 ] || { echo "Error: unable to open database file" >&2; exit 1; }
# STUB_SQLITE_VERSION: what --version answers (also when empty); a tool new enough for STRICT tables unless set.
[ "${1:-}" != --version ] || { echo "${STUB_SQLITE_VERSION-3.46.1 2024-08-13 09:16:08 (64-bit)}"; exit 0; }
case "$2" in
  "PRAGMA integrity_check;") echo "${STUB_INTEGRITY:-ok}" ;;
  .backup*) target="${2#.backup \'}"; target="${target%\'}"; printf 'SQLite format 3\0(stand-in copy by sqlite3)\n' >"$target" ;;
esac
EOF
  cat >"$b/curl" <<'EOF'
#!/bin/bash
printf 'curl %s\n' "$*" >>"$STUB_LOG"
url=""; for a in "$@"; do url="$a"; done
host="${url#https://}"; host="${host%%/*}"
# The request for the API without a token, of which the script reads the status code
# only. STUB_ME is the code every name answers with (401, as the platform does, unless
# set), STUB_ME_TOURS and STUB_ME_APP the code of one of the two names; "fail" is a
# request that gets no answer.
case "$url" in
  */api/v1/me)
    code="${STUB_ME:-401}"
    case "$host" in
      tours.example.com) code="${STUB_ME_TOURS:-$code}" ;;
      app.example.com) code="${STUB_ME_APP:-$code}" ;;
    esac
    [ "$code" != fail ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
    printf '%s' "$code"
    exit 0 ;;
esac
# Only the health requests are counted.
n=$(cat "$STUB_STATE/curls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STUB_STATE/curls"
mode="${STUB_HEALTH:-ok}"
# STUB_HEALTH=roles: an app in two-address mode. It answers by the host name it is asked
# on: its tours address reports "tours", its app address "app", any other name nothing.
# STUB_HEALTH_TOURS and STUB_HEALTH_APP change what one of the two addresses answers:
# tours, app, ok (no role, like an app whose settings lack the two lines), fail or parked.
if [ "$mode" = roles ]; then
  case "$host" in
    tours.example.com) mode="${STUB_HEALTH_TOURS:-tours}" ;;
    app.example.com) mode="${STUB_HEALTH_APP:-app}" ;;
    *) mode=ok ;;
  esac
fi
# STUB_HEALTH_AFTER=n: the first n-1 calls fail, like an app that is still starting.
if [ -n "${STUB_HEALTH_AFTER:-}" ] && [ "$n" -lt "$STUB_HEALTH_AFTER" ]; then mode=fail; fi
# STUB_HEALTH_UNTIL=n: every call after the first n fails, like an app that stops answering.
if [ -n "${STUB_HEALTH_UNTIL:-}" ] && [ "$n" -gt "$STUB_HEALTH_UNTIL" ]; then mode=fail; fi
case "$mode" in
  ok) echo '{"ok":true}' ;;
  tours) echo '{"ok":true,"address":"tours"}' ;;
  app) echo '{"ok":true,"address":"app"}' ;;
  fail) echo "curl: (22) The requested URL returned error: 503" >&2; exit 22 ;;
  parked) echo '<html><body>This domain is parked</body></html>' ;;
esac
EOF
  cat >"$b/touch" <<EOF
#!/bin/bash
printf 'touch %s\n' "\$*" >>"\$STUB_LOG"
[ "\${STUB_TOUCH_FAIL:-0}" != 1 ] || exit 1
exec "$REAL_TOUCH" "\$@"
EOF
  chmod +x "$b"/*
}

# An unpacked archive of the given version: make_release <folder> <version>.
make_release() {
  local d="$1" v="$2"
  mkdir -p "$d/dist/node" "$d/dist/player" "$d/migrations"
  printf '// build %s\n' "$v" >"$d/dist/node/entry.js"
  printf '// player %s\n' "$v" >"$d/dist/player/assets.js"
  printf -- '-- schema of %s\n' "$v" >"$d/migrations/0001_init.sql"
  printf '{\n  "name": "demo-platform",\n  "version": "%s",\n  "type": "module"\n}\n' "$v" >"$d/package.json"
  printf '{ "lockfileVersion": 3, "for": "%s" }\n' "$v" >"$d/package-lock.json"
  cp "$APP_CJS" "$d/app.cjs"
  cp "$SCRIPT" "$d/cpanel.sh"
  chmod +x "$d/cpanel.sh"
  printf '%s\n' "$v" >"$d/VERSION"
}

# Runs a command line in the sandbox: cpanel_raw <stdin text> <command...>; sets RC,
# OUT, ERR. The health check does not wait between tries.
cpanel_raw() {
  local input="$1"; shift
  OUT="$T/out"; ERR="$T/err"
  set +e
  printf '%s' "$input" | env HOME="$H" PATH="$T/bin:$PATH" STUB_LOG="$LOG" STUB_STATE="$STATE" \
    CPANEL_HEALTH_WAIT=0 "$@" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}
# A release's cpanel.sh: cpanel_in <release> <stdin text> <args...>.
cpanel_in() { local rel="$1" input="$2"; shift 2; cpanel_raw "$input" bash "$rel/cpanel.sh" "$@"; }
cpanel() { cpanel_in "$REL" "$@"; }

fresh_install() { cpanel "" install --domain "$DOMAIN" --yes; [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "fresh install failed"; }; }
# The app has run: it wrote its database (with a WAL beside it), a draft and a public
# file. app_has_run [data folder].
app_has_run() {
  local d="${1:-$DATA}"
  mkdir -p "$d/drafts/u1" "$d/public/t1"
  printf 'SQLite format 3\0(the live database)\n' >"$d/db.sqlite"
  printf 'not yet in the main file\n' >"$d/db.sqlite-wal"
  echo draft >"$d/drafts/u1/step-001.png"
  echo published >"$d/public/t1/step-001.png"
}
# What the steps done by hand leave: the files, the settings, the data and the Node.js
# environment, but no VERSION file, no cpanel.sh and no state file. Version 0.1.0.
hand_install() {
  make_release "$T/hand" 0.1.0
  mkdir -p "$APP" "$DATA" "$H/nodevenv/apps/tours/24/bin"
  cp -R "$T/hand/dist" "$T/hand/migrations" "$T/hand/package.json" "$T/hand/package-lock.json" "$T/hand/app.cjs" "$APP/"
  echo 'export STUB_VENV=apps/tours/24' >"$ACTIVATE"
  printf 'DATA_DIR=%s\nSETUP_CODE=a-code-made-by-hand-0123456789\n' "$DATA" >"$SETTINGS"
  app_has_run
}
setup_code() { sed -n 's/^SETUP_CODE=//p' "$SETTINGS"; }
# The setup code appears nowhere in what the run printed or in any stand-in's command line.
code_not_shown() { local c; c="$(setup_code)"; [ -n "$c" ] && ! grep -qF -- "$c" "$OUT" "$ERR" "$LOG"; }
backup_dirs() { find "$BACKUPS" -mindepth 1 -maxdepth 1 2>/dev/null | sort; }
only_backup() { [ "$(backup_dirs | wc -l | tr -d ' ')" = 1 ] || die "expected exactly one backup folder, got: $(backup_dirs | tr '\n' ' ')"; backup_dirs; }
# Every path under a folder with its type, and every file's checksum.
tree_of() { (cd "$1" && find . | sort && find . -type f -exec sha256sum {} + | sort); }
snapshot() { tree_of "$H"; }
# The stand-in calls, by program name, in the order they were made.
calls() { sed 's/[[ ].*//' "$LOG" | tr '\n' ' '; }
# The rollback commands a run printed, one per line, as a person would copy them.
rollback_lines() { sed -n "s/^    \\(cd '.*\\)\$/\\1/p" "$OUT"; }
# Pastes them into a shell on the hosting, one by one, whatever each one returns.
paste_rollback() {
  local line
  while IFS= read -r line; do
    env HOME="$H" PATH="$T/bin:$PATH" STUB_LOG="$LOG" STUB_STATE="$STATE" bash -c "$line" >/dev/null 2>&1 || true
  done <"$1"
}

die() { printf '      %s\n' "$*"; exit 1; }
skip() { printf '      SKIP: %s\n' "$*"; exit 77; }
expect() { local msg="$1"; shift; "$@" || die "$msg"; }
has() { grep -qF -- "$2" "$1"; }
hasnt() { ! grep -qF -- "$2" "$1"; }

# Runs one test in its own shell, leaving its output and exit code in files. The tests
# share nothing (each makes its own sandbox), so several run at a time. The subshell is
# not part of a condition, so `set -e` holds inside it: any command of a test that
# fails, with or without `expect`, fails the test.
start_test() {
  local name="$1" rc
  set +e
  ( set -e; "$name" ) >"$WORK/out.$name" 2>&1
  rc=$?
  set -e
  echo "$rc" >"$WORK/rc.$name"
}

report_test() {
  local name="$1" rc
  rc="$(cat "$WORK/rc.$name" 2>/dev/null || echo 1)"
  if [ "$rc" = 0 ]; then
    PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$name"
    # A skipped check inside a test that otherwise ran is shown too.
    grep 'SKIP:' "$WORK/out.$name" || true
  elif [ "$rc" = 77 ]; then
    SKIPS=$((SKIPS + 1)); printf 'SKIP  %s\n' "$name"; grep 'SKIP:' "$WORK/out.$name" || true
  else
    FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$name"; sed 's/^/      /' "$WORK/out.$name" | tail -n 25
  fi
}

# ---------------------------------------------------------------- arguments

test_arguments_are_checked() {
  new_sandbox
  local before; before="$(snapshot)"
  local bad
  for bad in "" "--nope" "install update" "remove" "install" "install --domain" "install --domain Tours.Example.com" \
             "install --domain https://tours.example.com" "install --domain tours.example.com/x" "install --domain localhost" \
             "install --domain 203.0.113.10" "install --domain tours.example.com --node latest" "install --domain tours.example.com --node 24.1" \
             "install --domain tours.example.com --app-root /abs/tours" "install --domain tours.example.com --app-root ../tours" \
             "install --domain tours.example.com --app-root apps/../x" "install --domain tours.example.com --app-root apps/.hidden" \
             "install --domain tours.example.com --app-root apps/tours/" \
             "status --allow-downgrade" "install --domain tours.example.com --allow-downgrade" "backup --app-root"; do
    # shellcheck disable=SC2086
    cpanel "" $bad
    [ "$RC" = 2 ] || die "accepted (exit $RC): $bad"
    has "$ERR" "ERROR:" || die "no error for: $bad"
  done
  cpanel "" install --domain "tours.example.com;id" --yes; [ "$RC" = 2 ] || die "accepted a domain with a semicolon"
  cpanel "" install --domain "$DOMAIN" --app-root 'apps/to urs' --yes; [ "$RC" = 2 ] || die "accepted an app root with a space"
  # shellcheck disable=SC2016 # the literal $(id) is the hostile input
  cpanel "" install --domain "$DOMAIN" --app-root 'apps/$(id)' --yes; [ "$RC" = 2 ] || die "accepted an app root with a command"
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was written" test "$(snapshot)" = "$before"
  cpanel "" --help
  expect "--help exits 0" test "$RC" = 0
  expect "--help lists the commands" has "$OUT" "install"
}

test_app_root_inside_a_web_folder_is_refused() {
  new_sandbox
  local before; before="$(snapshot)"
  local root
  # public_html and www, and the folders hosting names after a domain it serves.
  for root in public_html public_html/tours www www/tours tours.example.com tours.example.com/app example.com/apps/tours sub.domain.example.org; do
    cpanel "" install --domain "$DOMAIN" --app-root "$root" --yes
    [ "$RC" = 2 ] || die "accepted (exit $RC): $root"
    has "$ERR" "the app folder must be outside the folders the web server serves" || die "no reason given for: $root"
    cpanel "" status --app-root "$root"
    [ "$RC" = 2 ] || die "status accepted (exit $RC): $root"
  done
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was written" test "$(snapshot)" = "$before"
  # A dot further down the path is an ordinary folder name.
  cpanel "" install --domain "$DOMAIN" --app-root apps/tours.v2 --yes
  expect "a dot below the first folder is accepted (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "its settings file is beside it" test -f "$H/apps/tours.v2-config.env"
}

# ---------------------------------------------------------------- install

test_install_happy_path() {
  new_sandbox
  cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the Node.js app is created exactly as it was by hand" grep -qxF \
    "cloudlinux-selector create --json --interpreter nodejs --version 24 --app-root apps/tours --domain $DOMAIN --app-uri / --startup-file app.cjs --app-mode production" "$LOG"
  local f
  for f in dist/node/entry.js dist/player/assets.js migrations/0001_init.sql package.json package-lock.json app.cjs cpanel.sh VERSION; do
    expect "$f is in the app folder, unchanged" cmp -s "$REL/$f" "$APP/$f"
  done
  expect "the data folder exists" test -d "$DATA"
  expect "the settings file names the data folder" grep -qxF "DATA_DIR=$DATA" "$SETTINGS"
  expect "the settings file holds a setup code of 64 hex digits" grep -qE '^SETUP_CODE=[0-9a-f]{64}$' "$SETTINGS"
  expect "the settings file is beside the app folder, not in it" test ! -e "$APP/tours-config.env" -a ! -e "$APP/.env"
  expect "the packages are installed inside the app's Node.js environment, in the app folder" grep -qxF \
    "npm[venv=apps/tours/24 cwd=$APP] ci --omit=dev --ignore-scripts" "$LOG"
  expect "the restart file is touched" grep -qxF "touch $APP/tmp/restart.txt" "$LOG"
  expect "the restart file exists" test -f "$APP/tmp/restart.txt"
  expect "health is asked at the domain, not at 127.0.0.1" grep -qE "^curl .*https://$DOMAIN/healthz$" "$LOG"
  expect "no call names 127.0.0.1 or localhost" test "$(grep -cE '127\.0\.0\.1|localhost' "$LOG")" = 0
  expect "create, then packages, then restart, then health and the API's status code" test "$(calls)" = "cloudlinux-selector npm touch curl curl "
  expect "the domain and Node version are remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "the Node version is remembered" grep -qxF "NODE=24" "$APP/.cpanel-install"
  expect "the state file holds no setup code" hasnt "$APP/.cpanel-install" "$(setup_code)"
  expect "says where the settings file is" has "$OUT" "The settings file is $SETTINGS"
  expect "says the setup code is inside it" has "$OUT" "The setup code is inside it"
  expect "names the setup address" has "$OUT" "https://$DOMAIN/setup"
  expect "reports health as ok" has "$OUT" "health: ok"
  expect "no backup is made by install" test ! -e "$BACKUPS"
  expect "no staged copy and no update marker is left" test ! -e "$APP/dist.new" -a ! -e "$APP/migrations.new" -a ! -e "$APP/.cpanel-update"
}

test_install_never_shows_the_setup_code() {
  new_sandbox
  fresh_install
  expect "a setup code was written" test "$(setup_code | grep -cE '^[0-9a-f]{64}$')" = 1
  expect "not on stdout, stderr or any command line" code_not_shown
  local c; c="$(setup_code)"
  expect "in no file but the settings file" test "$(grep -rlF -- "$c" "$H" | tr '\n' ' ')" = "$SETTINGS "
  expect "not in a leftover temporary file" test ! -e "$SETTINGS.new"
  # Two installs do not get the same code.
  local first="$c"
  new_sandbox
  fresh_install
  expect "each install makes its own code" test "$(setup_code)" != "$first"
  # Every later command keeps it out of sight too.
  app_has_run
  local cmd
  for cmd in status backup; do
    cpanel "" "$cmd"
    expect "$cmd succeeds" test "$RC" = 0
    expect "$cmd does not show the setup code" code_not_shown
  done
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes
  expect "update succeeds" test "$RC" = 0
  expect "update does not show the setup code" code_not_shown
  cpanel "" install --domain "$DOMAIN" --yes
  expect "a refused install does not show it" code_not_shown
}

test_install_file_modes() {
  [ "$MODES" = 1 ] || skip "this file system does not keep Unix file modes"
  new_sandbox
  ( umask 022; fresh_install )
  expect "the settings file is mode 600" test "$(mode_of "$SETTINGS")" = 600
  expect "the data folder is mode 700" test "$(mode_of "$DATA")" = 700
  # The web server must be able to see the restart file, as after an install by hand.
  expect "the app folder is not closed to the web server" test "$(mode_of "$APP")" = 755
  expect "the build is not closed to the web server" test "$(mode_of "$APP/dist")" = 755
  expect "the restart folder is not closed to the web server" test "$(mode_of "$APP/tmp")" = 755
  expect "the script stays runnable" test -x "$APP/cpanel.sh"
  expect "the state file is an ordinary file" test "$(mode_of "$APP/.cpanel-install")" = 644
}

test_install_refuses_over_an_existing_install() {
  new_sandbox
  fresh_install
  app_has_run
  local before; before="$(snapshot)"
  : >"$LOG"
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says an install is there" has "$ERR" "already holds an install"
  expect "points to update" has "$ERR" "cpanel.sh update"
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
}

test_install_refuses_over_an_install_made_by_hand() {
  new_sandbox
  hand_install
  local before; before="$(snapshot)"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "points to update" has "$ERR" "update"
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
}

test_install_keeps_an_existing_settings_file_and_data_folder() {
  new_sandbox
  mkdir -p "$DATA/drafts" "$H/apps"
  echo keep >"$DATA/drafts/kept.png"
  printf 'DATA_DIR=%s\nSETUP_CODE=an-earlier-code-0123456789abcdef\n' "$DATA" >"$SETTINGS"
  local sum; sum="$(sha256sum <"$SETTINGS")"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "install succeeds" test "$RC" = 0
  expect "the settings file is unchanged" test "$(sha256sum <"$SETTINGS")" = "$sum"
  expect "says it was kept" has "$OUT" "is already there and is kept as it is"
  expect "the data is still there" test -f "$DATA/drafts/kept.png"
  expect "the earlier code is not shown" hasnt "$OUT" "an-earlier-code"
  [ "$MODES" = 0 ] || expect "the kept settings file is closed to others" test "$(mode_of "$SETTINGS")" = 600
}

test_install_stops_when_the_hosting_refuses_the_app() {
  local mode
  for mode in fail error-exit-0; do
    new_sandbox
    STUB_SELECTOR="$mode" cpanel "" install --domain "$DOMAIN" --yes
    expect "$mode: exit code non-zero" test "$RC" != 0
    expect "$mode: says the app was not created" has "$ERR" "did not create the Node.js app"
    expect "$mode: shows what the hosting answered" has "$OUT" "already"
    expect "$mode: no file was copied" test ! -e "$APP/dist" -a ! -e "$APP/dist.new"
    expect "$mode: no settings file was written" test ! -e "$SETTINGS"
    expect "$mode: nothing ran after the refusal" test "$(calls)" = "cloudlinux-selector "
  done
}

test_install_without_the_hosting_command() {
  new_sandbox
  rm "$T/bin/cloudlinux-selector"
  if command -v cloudlinux-selector >/dev/null 2>&1; then skip "this system has a real cloudlinux-selector"; fi
  cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "names the missing command" has "$ERR" "cloudlinux-selector command was not found"
  expect "nothing was created" test ! -e "$H/apps"
}

test_install_reports_a_failed_health_check() {
  new_sandbox
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=3 cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says the check failed" has "$OUT" "health: FAILED"
  expect "gives the reason curl gave" has "$OUT" "503"
  expect "does not claim it answers" hasnt "$OUT" "and it answers at"
  expect "does not report ok" hasnt "$OUT" "health: ok"
  expect "tried as often as asked" test "$(grep -c '^curl ' "$LOG")" = 3
  expect "still says where the settings file is" has "$OUT" "The settings file is $SETTINGS"
  expect "the setup code is not shown" code_not_shown
}

test_health_needs_the_platforms_own_reply() {
  new_sandbox
  STUB_HEALTH=parked CPANEL_HEALTH_TRIES=1 cpanel "" install --domain "$DOMAIN" --yes
  expect "another site answering is not success" test "$RC" != 0
  expect "says so" has "$OUT" "another site may be answering"
  expect "does not report ok" hasnt "$OUT" "health: ok"
}

test_health_waits_for_an_app_that_is_starting() {
  new_sandbox
  STUB_HEALTH_AFTER=3 cpanel "" install --domain "$DOMAIN" --yes
  expect "succeeds on the third try" test "$RC" = 0
  expect "asked three times" test "$(grep -c '^curl .*/healthz$' "$LOG")" = 3
  expect "reports ok" has "$OUT" "health: ok"
}

test_install_reports_failed_packages() {
  new_sandbox
  STUB_NPM_FAIL=1 cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says what failed" has "$ERR" "installing the packages failed"
  expect "says how to finish" has "$ERR" "update --yes"
  expect "the app was not restarted" test "$(calls)" = "cloudlinux-selector npm "
  expect "the setup code is not shown" code_not_shown
}

test_install_asks_first() {
  new_sandbox
  local before; before="$(snapshot)"
  cpanel "n
" install --domain "$DOMAIN"
  expect "no: exit code non-zero" test "$RC" != 0
  expect "no: asked" has "$ERR" "[y/N]"
  expect "no: nothing was called" test ! -s "$LOG"
  expect "no: nothing was changed" test "$(snapshot)" = "$before"
  cpanel "" install --domain "$DOMAIN"
  expect "no answer at all counts as no" test "$RC" != 0
  expect "no answer: nothing was changed" test "$(snapshot)" = "$before"
  cpanel "y
" install --domain "$DOMAIN"
  expect "yes: installs" test "$RC" = 0
  expect "yes: the app is there" test -f "$APP/dist/node/entry.js"
}

test_install_with_another_app_root_and_node_version() {
  new_sandbox
  cpanel "" install --domain demo.example.com --app-root sites/demo --node 22 --yes
  expect "install succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the app is created for that folder and version" grep -qxF \
    "cloudlinux-selector create --json --interpreter nodejs --version 22 --app-root sites/demo --domain demo.example.com --app-uri / --startup-file app.cjs --app-mode production" "$LOG"
  expect "the app is in that folder" test -f "$H/sites/demo/dist/node/entry.js"
  expect "the settings file is named after the folder" grep -qxF "DATA_DIR=$H/sites/demo-data" "$H/sites/demo-config.env"
  expect "the data folder is named after the folder" test -d "$H/sites/demo-data"
  expect "npm runs in that app's environment" grep -qF "npm[venv=sites/demo/22 cwd=$H/sites/demo]" "$LOG"
  expect "the default folder is untouched" test ! -e "$APP"
  # The other commands find it again, and the remembered Node version, by the app root.
  app_has_run "$H/sites/demo-data"
  : >"$LOG"
  cpanel "" backup --app-root sites/demo
  expect "backup succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the backup is named after the app" test "$(find "$BACKUPS" -maxdepth 1 -name "demo-*" | wc -l | tr -d " ")" = 1
  expect "node runs in the remembered environment" grep -qF "node[venv=sites/demo/22 " "$LOG"
  cpanel "" status
  expect "status of the default folder: nothing installed" has "$ERR" "nothing is installed"
}

test_hints_can_be_typed_as_they_are() {
  new_sandbox
  fresh_install
  app_has_run
  # Started as "bash cpanel.sh" in the archive's folder: the hint says the same.
  ( cd "$REL" && cpanel_raw "" bash cpanel.sh install --domain "$DOMAIN" --yes; has "$ERR" "use: bash cpanel.sh update --app-root apps/tours" ) || die "hint for: bash cpanel.sh"
  # Started as "./cpanel.sh": the hint says the same.
  ( cd "$REL" && cpanel_raw "" ./cpanel.sh install --domain "$DOMAIN" --yes; has "$ERR" "use: ./cpanel.sh update --app-root apps/tours" ) || die "hint for: ./cpanel.sh"
  # Started by its full path from somewhere else: the hint carries the path.
  ( cd "$T" && cpanel_raw "" "$REL/cpanel.sh" install --domain "$DOMAIN" --yes; has "$ERR" "use: $REL/cpanel.sh update --app-root apps/tours" ) || die "hint for a full path"
  # The installed copy runs from its own folder, as the guide has it.
  ( cd "$APP" && cpanel_raw "" ./cpanel.sh status; [ "$RC" = 0 ] ) || die "status from the installed copy"
  make_release "$T/new" 0.2.0
  ( cd "$T/new" && STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel_raw "" ./cpanel.sh update --yes; has "$OUT" "Check again at any time with: ./cpanel.sh status --app-root apps/tours" ) || die "status hint"
  if [ "$MODES" = 1 ]; then
    # A copy that is not marked runnable is named with bash in front.
    chmod -x "$REL/cpanel.sh"
    ( cd "$REL" && cpanel_raw "" bash ./cpanel.sh install --domain "$DOMAIN" --yes; has "$ERR" "use: bash ./cpanel.sh update --app-root apps/tours" ) || die "hint for a copy that is not runnable"
  fi
}

# ---------------------------------------------------------------- dry run

test_dry_run_changes_nothing() {
  new_sandbox
  local before; before="$(snapshot)"
  cpanel "" install --domain "$DOMAIN" --dry-run
  expect "install --dry-run exits 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "install: nothing was called" test ! -s "$LOG"
  expect "install: nothing was written" test "$(snapshot)" = "$before"
  expect "install: shows the create command" has "$OUT" "cloudlinux-selector create --json --interpreter nodejs --version 24 --app-root apps/tours --domain $DOMAIN"
  expect "install: shows the packages step" has "$OUT" "npm ci --omit=dev --ignore-scripts"
  expect "install: shows the settings step" has "$OUT" "would write the settings file $SETTINGS"
  expect "install: shows the restart step" has "$OUT" "touch $APP/tmp/restart.txt"
  expect "install: says it was a dry run" has "$OUT" "Dry run: nothing was changed"
  expect "install: does not claim health" hasnt "$OUT" "health: ok"

  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  before="$(snapshot)"
  : >"$LOG"
  local cmd
  for cmd in update backup status; do
    cpanel_in "$T/new" "" "$cmd" --dry-run
    expect "$cmd --dry-run exits 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
    expect "$cmd: nothing was called" test ! -s "$LOG"
    expect "$cmd: nothing was written" test "$(snapshot)" = "$before"
  done
  cpanel_in "$T/new" "" update --dry-run
  expect "update: shows the backup step" has "$OUT" "would copy the database"
  expect "update: shows the staging" has "$OUT" "would copy this archive's dist and migrations to $APP/dist.new"
  expect "update: shows the move" has "$OUT" "move dist to dist.old and migrations to migrations.old"
  expect "update: says it was a dry run" has "$OUT" "Dry run: nothing was changed"
  expect "update: the installed version is still the old one" test "$(cat "$APP/VERSION")" = 0.1.1
}

# ---------------------------------------------------------------- update

test_update_backs_up_then_replaces() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  local settings_sum data_sum
  settings_sum="$(sha256sum <"$SETTINGS")"
  data_sum="$(tree_of "$DATA")"
  : >"$LOG"
  cpanel_in "$T/new" "" update --yes
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "backup, then packages, then restart, then health and the API's status code" test "$(calls)" = "node npm touch curl curl "
  local b; b="$(only_backup)"
  expect "the backup holds the version from before the update" test "$(tar -xzOf "$b/app.tgz" VERSION)" = 0.1.1
  expect "the backup holds the build from before the update" test "$(tar -xzOf "$b/app.tgz" dist/node/entry.js)" = "// build 0.1.1"
  expect "the backup holds the database" test -s "$b/db.sqlite"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "the new migrations are in place" test "$(cat "$APP/migrations/0001_init.sql")" = "-- schema of 0.2.0"
  expect "the previous build is kept as dist.old" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "the previous migrations are kept as migrations.old" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.1.1"
  local f
  for f in package.json package-lock.json app.cjs cpanel.sh VERSION; do
    expect "$f is the new one" cmp -s "$T/new/$f" "$APP/$f"
  done
  expect "the installed version is the new one" test "$(cat "$APP/VERSION")" = 0.2.0
  expect "packages are installed in the app's environment" grep -qxF "npm[venv=apps/tours/24 cwd=$APP] ci --omit=dev --ignore-scripts" "$LOG"
  expect "health is asked at the remembered domain" grep -qE "^curl .*https://$DOMAIN/healthz$" "$LOG"
  expect "the settings file is untouched" test "$(sha256sum <"$SETTINGS")" = "$settings_sum"
  expect "the data folder is untouched" test "$(tree_of "$DATA")" = "$data_sum"
  expect "the domain is still remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "says it is updated" has "$OUT" "Updated to version 0.2.0"
  expect "no rollback steps after a good update" hasnt "$OUT" "To go back"
  expect "no staged copy and no update marker is left" test ! -e "$APP/dist.new" -a ! -e "$APP/migrations.new" -a ! -e "$APP/.cpanel-update"
}

test_update_replaces_older_old_copies() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/v2" 0.2.0
  make_release "$T/v3" 0.3.0
  cpanel_in "$T/v2" "" update --yes
  expect "first update succeeds" test "$RC" = 0
  echo "left behind" >"$APP/dist.old/stale-file"
  cpanel_in "$T/v3" "" update --yes
  expect "second update succeeds" test "$RC" = 0
  expect "dist is 0.3.0" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.3.0"
  expect "dist.old is 0.2.0, the one just replaced" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.2.0"
  expect "migrations.old is 0.2.0" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.2.0"
  expect "the older .old copy is gone, not merged" test ! -e "$APP/dist.old/stale-file"
  expect "no copy is nested in another" test ! -e "$APP/dist.old/dist" -a ! -e "$APP/dist/dist.old" -a ! -e "$APP/dist.old.old"
  expect "each update made its own backup" test "$(backup_dirs | wc -l | tr -d ' ')" = 2
}

test_update_stops_when_the_backup_fails() {
  local how
  for how in STUB_NODE_FAIL STUB_NODE_WRITES_NOTHING; do
    new_sandbox
    fresh_install
    app_has_run
    make_release "$T/new" 0.2.0
    local before; before="$(tree_of "$APP")"
    : >"$LOG"
    export "$how=1"
    cpanel_in "$T/new" "" update --yes
    unset "$how"
    expect "$how: exit code non-zero" test "$RC" != 0
    expect "$how: says the backup failed and nothing changed" has "$ERR" "the backup failed, so the update did not start; nothing was changed"
    expect "$how: the app folder is unchanged" test "$(tree_of "$APP")" = "$before"
    expect "$how: no dist.old was made" test ! -e "$APP/dist.old"
    expect "$how: nothing ran after the failed backup" test "$(calls)" = "node "
    expect "$how: no half-made backup folder is left" test -z "$(backup_dirs)"
  done
}

test_update_refuses_when_nothing_is_installed() {
  new_sandbox
  cpanel "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says nothing is installed" has "$ERR" "nothing is installed at $APP"
  expect "points to install" has "$ERR" "install --domain"
  expect "nothing was called" test ! -s "$LOG"
  expect "nothing was created" test ! -e "$H/apps" -a ! -e "$BACKUPS"
}

test_update_refuses_a_downgrade() {
  new_sandbox
  make_release "$REL" 0.10.0
  fresh_install
  app_has_run
  # 0.9.2 is older than 0.10.0: the parts are compared as numbers, not as text.
  make_release "$T/older" 0.9.2
  local before; before="$(snapshot)"
  : >"$LOG"
  cpanel_in "$T/older" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "names both versions" has "$ERR" "this archive is version 0.9.2, older than the installed 0.10.0"
  expect "names the way to force it" has "$ERR" "--allow-downgrade"
  expect "nothing was called, not even a backup" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
  cpanel_in "$T/older" "" update --yes --allow-downgrade
  expect "with --allow-downgrade it goes through" test "$RC" = 0
  expect "the older version is in place" test "$(cat "$APP/VERSION")" = 0.9.2
  expect "a backup was still made first" test -d "$(only_backup)"
  # The same version again is not a downgrade.
  cpanel_in "$T/older" "" update --yes
  expect "the same version can be put in place again" test "$RC" = 0
}

test_update_reports_a_failed_health_check_with_rollback_commands() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  : >"$LOG"
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=2 cpanel_in "$T/new" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says the check failed" has "$OUT" "health: FAILED"
  expect "says so in the summary" has "$OUT" "Version 0.2.0 is in place, but the health check did not pass"
  expect "does not claim success" hasnt "$OUT" "Updated to version"
  local b; b="$(only_backup)"
  rollback_lines >"$T/rollback"
  # Each command stands alone: it changes into the app folder itself, quoted, and is
  # guarded so that a second paste does nothing.
  local want="cd '$APP' && [ -d dist.old ] && rm -rf dist && mv dist.old dist
cd '$APP' && [ -d migrations.old ] && rm -rf migrations && mv migrations.old migrations
cd '$APP' && tar -xzf '$b/app.tgz' package.json package-lock.json app.cjs cpanel.sh VERSION
cd '$APP' && source '$ACTIVATE' && npm ci --omit=dev --ignore-scripts
cd '$APP' && rm -f .cpanel-update && touch tmp/restart.txt"
  expect "prints exactly these rollback commands (got: $(cat "$T/rollback"))" test "$(cat "$T/rollback")" = "$want"
  expect "says nothing was rolled back" has "$OUT" "Nothing was rolled back for you"
  expect "it did not roll back by itself: the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "it did not roll back by itself: dist.old is still there" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "the setup code is not shown" code_not_shown

  # The printed commands, pasted as printed, bring the previous version back.
  : >"$LOG"
  paste_rollback "$T/rollback"
  local after; after="$(tree_of "$APP")"
  expect "after the commands: the previous build" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "after the commands: the previous migrations" test "$(cat "$APP/migrations/0001_init.sql")" = "-- schema of 0.1.1"
  expect "after the commands: the previous version" test "$(cat "$APP/VERSION")" = 0.1.1
  expect "after the commands: the previous package.json" cmp -s "$REL/package.json" "$APP/package.json"
  expect "after the commands: no .old copy is left" test ! -e "$APP/dist.old" -a ! -e "$APP/migrations.old"
  expect "after the commands: packages installed and the app restarted" test "$(calls)" = "npm touch "
  # Pasted a second time, they destroy nothing: the build that is running stays.
  paste_rollback "$T/rollback"
  expect "pasted twice: the app folder is as after the first time" test "$(tree_of "$APP")" = "$after"
  expect "pasted twice: the build is still there" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  # And the install is an ordinary one again: the next update works.
  cpanel_in "$T/new" "" update --yes
  expect "an update after the rollback succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
}

test_update_reports_failed_packages_with_rollback_commands() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  : >"$LOG"
  STUB_NPM_FAIL=1 cpanel_in "$T/new" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says what failed" has "$ERR" "installing the packages failed"
  expect "prints the rollback commands" has "$OUT" "[ -d dist.old ] && rm -rf dist && mv dist.old dist"
  expect "the app was not restarted" test "$(calls)" = "node npm "
  expect "the update is still marked as under way" test -f "$APP/.cpanel-update"
}

test_update_must_run_from_a_new_archive() {
  new_sandbox
  fresh_install
  app_has_run
  local before; before="$(snapshot)"
  : >"$LOG"
  cpanel_in "$APP" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "explains" has "$ERR" "this is the installed copy of the script"
  expect "nothing was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
  rm -rf "$T/new"; make_release "$T/new" 0.2.0; rm "$T/new/package-lock.json"
  cpanel_in "$T/new" "" update --yes
  expect "an archive that is not whole is refused" test "$RC" != 0
  expect "names the missing file" has "$ERR" "package-lock.json is missing"
  expect "still nothing was changed" test "$(snapshot)" = "$before"
}

test_update_asks_first() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  local before; before="$(snapshot)"
  : >"$LOG"
  cpanel_in "$T/new" "n
" update
  expect "exit code non-zero" test "$RC" != 0
  expect "asked" has "$ERR" "[y/N]"
  expect "nothing was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
}

test_update_takes_over_an_install_made_by_hand() {
  new_sandbox
  hand_install
  local before; before="$(snapshot)"
  # An older archive is still refused: the version is read from package.json.
  make_release "$T/older" 0.0.9
  cpanel_in "$T/older" "" update --yes --domain "$DOMAIN"
  expect "a downgrade of a hand-made install is refused" has "$ERR" "older than the installed 0.1.0"
  # Without a domain the result could not be checked, so nothing is started.
  cpanel "" update --yes
  expect "no domain: exit code non-zero" test "$RC" != 0
  expect "no domain: says to pass it" has "$ERR" "update --domain <name>"
  expect "no domain: says nothing was changed" has "$ERR" "nothing was changed"
  expect "no domain: nothing was called, not even a backup" test ! -s "$LOG"
  expect "no domain: nothing was changed" test "$(snapshot)" = "$before"
  # With the domain given once, it goes through and the domain is remembered.
  cpanel "" update --yes --domain "$DOMAIN"
  expect "with --domain: succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "with --domain: the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "with --domain: the hand-made build is kept" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.0"
  expect "with --domain: remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes
  expect "the next update needs no --domain (stderr: $(cat "$ERR"))" test "$RC" = 0
  cpanel "" status
  expect "status uses the remembered domain" has "$OUT" "health: ok"
  expect "the hand-made settings file is untouched" grep -qxF "SETUP_CODE=a-code-made-by-hand-0123456789" "$SETTINGS"
  expect "the hand-made code is never shown" hasnt "$OUT" "a-code-made-by-hand"
}

test_rollback_of_a_hand_made_install_removes_what_it_never_had() {
  new_sandbox
  hand_install
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel "" update --yes --domain "$DOMAIN"
  expect "exit code non-zero" test "$RC" != 0
  local b; b="$(only_backup)"
  expect "removes the files that were not there before" grep -qxF "    cd '$APP' && rm -f cpanel.sh VERSION" "$OUT"
  expect "restores the files that were" grep -qxF "    cd '$APP' && tar -xzf '$b/app.tgz' package.json package-lock.json app.cjs" "$OUT"
  rollback_lines >"$T/rollback"
  paste_rollback "$T/rollback"
  paste_rollback "$T/rollback"
  expect "the hand-made build is back" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.0"
  expect "the hand-made package.json is back" cmp -s "$T/hand/package.json" "$APP/package.json"
  expect "the files it never had are gone" test ! -e "$APP/VERSION" -a ! -e "$APP/cpanel.sh"
}

# ---------------------------------------------------------------- an interrupted update

# What an update that was cut off after its first rename leaves, on an install that had
# no state file before: the script's own marker and state file, the old build as
# dist.old, and no dist.
test_interrupted_first_update_of_a_hand_made_install_is_still_an_install() {
  new_sandbox
  hand_install
  STUB_NPM_FAIL=1 cpanel "" update --yes --domain "$DOMAIN"
  expect "the cut-off update exits non-zero" test "$RC" != 0
  local first; first="$(only_backup)"
  expect "the state file was written before anything was moved" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "the update is marked as under way" test -f "$APP/.cpanel-update"
  rm -rf "$APP/dist"
  expect "the old build is dist.old" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.0"

  cpanel "" status
  expect "status: found (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "status: does not say nothing is installed" hasnt "$ERR" "nothing is installed"
  expect "status: says an update was cut off" has "$OUT" "an update was cut off before it finished"
  cpanel "" backup
  expect "backup: works (stderr: $(cat "$ERR"))" test "$RC" = 0
  : >"$LOG"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "install: refuses" test "$RC" != 0
  expect "install: points to update, not to a second create" has "$ERR" "already holds an install"
  expect "install: the hosting was not asked to create the app again" test ! -s "$LOG"

  # Even with neither of the script's files, the build that was moved aside counts.
  mv "$APP/.cpanel-update" "$T/kept-marker"; mv "$APP/.cpanel-install" "$T/kept-state"
  cpanel "" status
  expect "dist.old alone is still an install" test "$RC" = 0
  mv "$T/kept-marker" "$APP/.cpanel-update"; mv "$T/kept-state" "$APP/.cpanel-install"

  # Running the update again finishes it, with the old build still the way back.
  cpanel "" update --yes
  expect "the second run succeeds without --domain (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "says it resumes" has "$OUT" "An earlier update was cut off"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "dist.old is still the hand-made build" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.0"
  expect "migrations.old is still the hand-made one" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.1.0"
  expect "the marker is cleared" test ! -e "$APP/.cpanel-update"
  expect "the first backup is still there" test -f "$first/app.tgz"
}

# The same on an install that has a state file, cut off while the new dist was only half
# there: running update again must not delete dist.old, and must not move the half-made
# dist into its place.
test_rerun_after_an_interrupted_update_keeps_the_last_good_build() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  STUB_NPM_FAIL=1 cpanel_in "$T/new" "" update --yes
  expect "the cut-off update exits non-zero" test "$RC" != 0
  local first; first="$(only_backup)"
  # Half a build: the entry file never arrived.
  rm "$APP/dist/node/entry.js"
  echo "half-made" >"$APP/dist/node/partial.js"

  # A second run that fails again still names the first backup as the way back: it
  # holds the files of the version that ran, the later one holds the half-made state.
  STUB_NPM_FAIL=1 cpanel_in "$T/new" "" update --yes
  expect "the second cut-off run exits non-zero" test "$RC" != 0
  expect "dist.old is still the last good build" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "migrations.old is still the last good one" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.1.1"
  expect "the half-made build was not kept anywhere" test -z "$(find "$APP" -name partial.js)"
  expect "the rollback names the backup from before the first run" grep -qxF "    cd '$APP' && tar -xzf '$first/app.tgz' package.json package-lock.json app.cjs cpanel.sh VERSION" "$OUT"
  expect "that backup holds the version that ran" test "$(tar -xzOf "$first/app.tgz" VERSION)" = 0.1.1

  cpanel_in "$T/new" "" update --yes
  expect "the third run succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the new build is whole" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "dist.old is still the last good build" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "the marker is cleared" test ! -e "$APP/.cpanel-update"
  expect "no staged copy is left" test ! -e "$APP/dist.new" -a ! -e "$APP/migrations.new"

  # A marker with nothing moved yet (cut off right after it was written) loses nothing either.
  make_release "$T/v3" 0.3.0
  printf 'BACKUP=%s\nRESTORE=package.json package-lock.json app.cjs cpanel.sh VERSION\nREMOVE=\n' "$first" >"$APP/.cpanel-update"
  rm -rf "$APP/dist.old" "$APP/migrations.old"
  cpanel_in "$T/v3" "" update --yes
  expect "resuming with nothing moved succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the build that ran became dist.old" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.2.0"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.3.0"
}

test_a_signal_in_the_middle_of_an_update_prints_the_way_back() {
  new_sandbox
  [ -r "/proc/$$/cmdline" ] || skip "this system has no /proc to find the script's process with"
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  local sig
  # Not INT: these tests run in the background, where a shell starts with INT ignored,
  # and a signal that is ignored at the start cannot be caught. The script handles INT
  # with the same line as the two tried here.
  for sig in TERM HUP; do
    : >"$LOG"
    STUB_NPM_SIGNAL="$sig" cpanel_in "$T/new" "" update --yes
    expect "$sig: exit code 130 (got $RC; stderr: $(cat "$ERR"))" test "$RC" = 130
    expect "$sig: says it was interrupted" has "$ERR" "interrupted"
    expect "$sig: says the files were being replaced" has "$OUT" "cut off after it began to replace the app files"
    expect "$sig: says how to finish" has "$OUT" "run the update again: it resumes"
    expect "$sig: prints the way back" has "$OUT" "cd '$APP' && [ -d dist.old ] && rm -rf dist && mv dist.old dist"
    expect "$sig: the app was not restarted" test "$(calls)" = "node npm "
    expect "$sig: the update is still marked as under way" test -f "$APP/.cpanel-update"
    expect "$sig: dist.old is the last good build" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
    expect "$sig: no half-made backup folder is left" test -z "$(find "$BACKUPS" -name '*.partial')"
  done
  expect "the script handles INT like TERM and HUP" has "$REL/cpanel.sh" "trap on_signal INT TERM HUP"
  # The way back, as printed after the last signal, works.
  rollback_lines >"$T/rollback"
  paste_rollback "$T/rollback"
  expect "after the commands: the previous build" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "after the commands: the previous version" test "$(cat "$APP/VERSION")" = 0.1.1
  expect "after the commands: the marker is gone" test ! -e "$APP/.cpanel-update"
  # And so does going forward instead.
  cpanel_in "$T/new" "" update --yes
  expect "the update then goes through (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
}

test_a_signal_before_anything_was_moved_leaves_the_app_alone() {
  new_sandbox
  [ -r "/proc/$$/cmdline" ] || skip "this system has no /proc to find the script's process with"
  fresh_install
  app_has_run
  local before; before="$(tree_of "$APP")"
  make_release "$T/new" 0.2.0
  # The script is interrupted while the backup's database copy is made.
  STUB_NODE_SIGNAL=TERM cpanel_in "$T/new" "" update --yes
  expect "exit code 130 (got $RC; stderr: $(cat "$ERR"))" test "$RC" = 130
  expect "says it was interrupted" has "$ERR" "interrupted"
  expect "says the app files were not touched" has "$OUT" "The app files were not touched"
  expect "prints no rollback" hasnt "$OUT" "To go back"
  expect "the app folder is unchanged" test "$(tree_of "$APP")" = "$before"
  expect "no half-made backup folder is left" test -z "$(find "$BACKUPS" -name '*.partial')"
}

test_a_cut_between_the_packages_and_the_restart_keeps_the_last_good_build() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  # The files and the packages are in place, and then the restart does not happen.
  STUB_TOUCH_FAIL=1 cpanel_in "$T/new" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says the app was not restarted" has "$ERR" "the app was not restarted"
  expect "prints the way back" has "$OUT" "cd '$APP' && [ -d dist.old ] && rm -rf dist && mv dist.old dist"
  expect "the update is still marked as under way" test -f "$APP/.cpanel-update"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  # Running it again must not take the new, unproven build for the last good one.
  : >"$LOG"
  cpanel_in "$T/new" "" update --yes
  expect "the second run succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "says it resumes" has "$OUT" "An earlier update was cut off"
  expect "dist.old is still the version that ran before" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "migrations.old is still the one from before" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.1.1"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "the marker is cleared once the restart was asked for" test ! -e "$APP/.cpanel-update"
  expect "the app was restarted this time" test "$(grep -c '^touch' "$LOG")" = 1
}

# A build that exists only as dist.old, with no marker: what work by hand, or an earlier
# version of this script, can leave. It is the app's only build and must survive.
test_a_build_that_exists_only_as_dist_old_is_kept_and_backed_up() {
  new_sandbox
  fresh_install
  app_has_run
  mv "$APP/dist" "$APP/dist.old"
  mv "$APP/migrations" "$APP/migrations.old"
  expect "there is no marker" test ! -e "$APP/.cpanel-update"
  cpanel "" backup
  expect "backup works (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the backup's app archive holds the build that was moved aside" test "$(tar -xzOf "$b/app.tgz" dist.old/node/entry.js)" = "// build 0.1.1"
  expect "and its migrations" test "$(tar -xzOf "$b/app.tgz" migrations.old/0001_init.sql)" = "-- schema of 0.1.1"
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes
  expect "update succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "it is treated as an update to finish" has "$OUT" "An earlier update was cut off"
  expect "dist.old is still that build, not deleted" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "migrations.old is still there" test "$(cat "$APP/migrations.old/0001_init.sql")" = "-- schema of 0.1.1"
  expect "the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "the update's own backup holds that build too" test "$(find "$BACKUPS" -name app.tgz | while IFS= read -r a; do tar -tzf "$a" | grep -cx 'dist.old/node/entry.js' || true; done | tr '\n' ' ')" = "1 1 "
  expect "the marker is cleared" test ! -e "$APP/.cpanel-update"
  # A half-made dist beside it is not taken for a build either.
  rm -rf "$APP/dist"; mkdir -p "$APP/dist/node"; echo "half-made" >"$APP/dist/node/partial.js"
  make_release "$T/v3" 0.3.0
  cpanel_in "$T/v3" "" update --yes
  expect "with a half-made dist: succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "with a half-made dist: dist.old is still the last whole build" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "with a half-made dist: the half-made one is gone" test -z "$(find "$APP" -name partial.js)"
}

# ---------------------------------------------------------------- an install that never finished

test_a_failed_first_install_is_finished_by_update() {
  new_sandbox
  STUB_NPM_FAIL=1 cpanel "" install --domain "$DOMAIN" --yes
  expect "the install fails" test "$RC" != 0
  expect "says how to finish" has "$ERR" "finish with:"
  expect "names update" has "$ERR" "cpanel.sh update --yes --app-root apps/tours"
  expect "does not ask for something that cannot be done yet" hasnt "$ERR" "open the app's address"
  expect "the install is recorded as not finished" grep -qxF "FINISHED=no" "$APP/.cpanel-install"
  expect "the data folder is there, without a database" test -d "$DATA" -a ! -e "$DATA/db.sqlite"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "install itself is not run twice" has "$ERR" "already holds an install"
  # The same archive's update finishes the install, although there is nothing to back up.
  : >"$LOG"
  cpanel "" update --yes
  expect "update succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "says there was no database to back up yet" has "$OUT" "there is no database to back up yet"
  expect "no database tool was called; packages, restart and health were" test "$(calls)" = "npm touch curl curl "
  local b; b="$(only_backup)"
  expect "the backup holds the files and the settings, and no database" test -f "$b/app.tgz" -a -f "$b/tours-config.env" -a ! -e "$b/db.sqlite"
  expect "the build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "the install is now recorded as finished" grep -qxF "FINISHED=yes" "$APP/.cpanel-install"
  expect "it is recorded once" test "$(grep -c '^FINISHED=' "$APP/.cpanel-install")" = 1
  expect "the domain is still recorded" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "the setup code is not shown" code_not_shown

  # From now on a missing database is a fault again.
  make_release "$T/new" 0.2.0
  local before; before="$(snapshot)"
  : >"$LOG"
  cpanel_in "$T/new" "" update --yes
  expect "a finished install without a database: update stops" test "$RC" != 0
  expect "says why" has "$ERR" "there is no database at $DATA/db.sqlite"
  expect "says the install has run before" has "$ERR" "This install has run before"
  cpanel "" backup
  expect "a finished install without a database: backup stops" test "$RC" != 0
  expect "nothing was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
}

test_an_install_is_finished_only_when_its_health_check_passed() {
  new_sandbox
  fresh_install
  expect "a healthy install is recorded as finished" grep -qxF "FINISHED=yes" "$APP/.cpanel-install"
  new_sandbox
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel "" install --domain "$DOMAIN" --yes
  expect "the install reports the failed check" test "$RC" != 0
  expect "an install whose check failed is not recorded as finished" grep -qxF "FINISHED=no" "$APP/.cpanel-install"
  # The certificate was not ready, nobody reached the app, no database was written.
  make_release "$T/new" 0.2.0
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes
  expect "an update whose check fails too" test "$RC" != 0
  expect "still does not record it as finished" grep -qxF "FINISHED=no" "$APP/.cpanel-install"
  make_release "$T/v3" 0.3.0
  cpanel_in "$T/v3" "" update --yes
  expect "an update that passes (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "records it as finished" grep -qxF "FINISHED=yes" "$APP/.cpanel-install"
  # A database that is there is backed up, finished or not.
  new_sandbox
  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel "" install --domain "$DOMAIN" --yes
  app_has_run
  : >"$LOG"
  cpanel "" backup
  expect "backup of an unfinished install with a database succeeds" test "$RC" = 0
  expect "and copies the database" test "$(calls)" = "node "
}

test_an_install_with_no_record_needs_its_database_unless_the_data_folder_is_empty() {
  new_sandbox
  hand_install
  expect "a hand-made install has no record" test ! -e "$APP/.cpanel-install"
  # The database is gone but other data is there: this install has run.
  rm "$DATA/db.sqlite" "$DATA/db.sqlite-wal"
  local before; before="$(snapshot)"
  cpanel "" update --yes --domain "$DOMAIN"
  expect "update stops" test "$RC" != 0
  expect "says why" has "$ERR" "there is no database at $DATA/db.sqlite"
  cpanel "" backup
  expect "backup stops" test "$RC" != 0
  expect "nothing was called" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"
  # A data folder with nothing in it at all: the app never started.
  rm -rf "$DATA"; mkdir "$DATA"
  cpanel "" update --yes --domain "$DOMAIN"
  expect "with an empty data folder the update goes through (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "and says there was no database to back up yet" has "$OUT" "there is no database to back up yet"
  expect "and records the install as finished" grep -qxF "FINISHED=yes" "$APP/.cpanel-install"
  # An install made by the script before it kept that record is treated the same way.
  new_sandbox
  fresh_install
  app_has_run
  grep -v '^FINISHED=' "$APP/.cpanel-install" >"$T/old-state"; cp "$T/old-state" "$APP/.cpanel-install"
  rm "$DATA/db.sqlite"
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes
  expect "no record, data but no database: update stops" test "$RC" != 0
  expect "no record: says why" has "$ERR" "there is no database at $DATA/db.sqlite"
}

# ---------------------------------------------------------------- the data folder

test_the_data_folder_is_the_one_the_settings_file_names() {
  new_sandbox
  # The settings file of this install points somewhere else than <app-root>-data.
  local elsewhere="$H/storage/tours"
  mkdir -p "$H/apps"
  printf '# moved to the big disk\nSETUP_CODE=a-code-that-must-stay-private-0123\n  DATA_DIR="%s"\r\nDATA_DIR=/a/second/line/is/ignored\n' "$elsewhere" >"$SETTINGS"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "install succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "install made the folder the settings file names" test -d "$elsewhere"
  expect "install did not make the default folder" test ! -e "$DATA"
  app_has_run "$elsewhere"
  echo "only-here" >"$elsewhere/drafts/u1/marker.png"
  : >"$LOG"
  cpanel "" backup
  expect "backup succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the database copied is the one in that folder" grep -qF " $elsewhere/db.sqlite $b.partial/db.sqlite" "$LOG"
  expect "the drafts copied are the ones in that folder" test -f "$b/drafts/u1/marker.png"
  expect "the backup holds a database" test -s "$b/db.sqlite"
  expect "no other line of the settings file is shown" hasnt "$OUT" "a-code-that-must-stay-private"
  expect "nor on stderr or a command line" test "$(cat "$ERR" "$LOG" | grep -c 'a-code-that-must-stay-private')" = 0
  cpanel "" status
  expect "status names that folder" has "$OUT" "data folder:    $elsewhere, "
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes
  expect "update succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "update says which data folder it leaves alone" has "$OUT" "data folder:    $elsewhere (not touched)"
  expect "the update's backup holds the drafts of that folder" test "$(find "$BACKUPS" -name marker.png | wc -l | tr -d ' ')" = 2
}

test_update_and_backup_stop_when_the_data_cannot_be_found() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  cp "$SETTINGS" "$T/settings"
  local what before
  for what in "no settings file" "no DATA_DIR line" "a relative DATA_DIR" "a DATA_DIR that does not exist" "no database"; do
    cp "$T/settings" "$SETTINGS"; app_has_run
    case "$what" in
      "no settings file") rm "$SETTINGS" ;;
      "no DATA_DIR line") grep -v '^DATA_DIR=' "$T/settings" >"$SETTINGS" ;;
      "a relative DATA_DIR") sed 's|^DATA_DIR=.*|DATA_DIR=apps/tours-data|' "$T/settings" >"$SETTINGS" ;;
      "a DATA_DIR that does not exist") sed "s|^DATA_DIR=.*|DATA_DIR=$H/apps/moved-away|" "$T/settings" >"$SETTINGS" ;;
      "no database") rm "$DATA/db.sqlite" "$DATA/db.sqlite-wal" ;;
    esac
    before="$(snapshot)"
    : >"$LOG"
    cpanel_in "$T/new" "" update --yes
    expect "$what: update exits non-zero" test "$RC" != 0
    expect "$what: update says nothing was changed" has "$ERR" "nothing was changed"
    expect "$what: update does not report success" hasnt "$OUT" "Updated to version"
    [ ! -f "$SETTINGS" ] || expect "$what: update does not show the setup code" code_not_shown
    cpanel "" backup
    expect "$what: backup exits non-zero" test "$RC" != 0
    expect "$what: backup does not report a backup" hasnt "$OUT" "Backup written"
    [ ! -f "$SETTINGS" ] || expect "$what: backup does not show the setup code" code_not_shown
    expect "$what: nothing was called" test ! -s "$LOG"
    expect "$what: nothing was changed, and no backup folder was written" test "$(snapshot)" = "$before"
  done
  cp "$T/settings" "$SETTINGS"; app_has_run
  rm "$SETTINGS"; cpanel "" backup
  expect "names the missing settings file" has "$ERR" "the settings file $SETTINGS is missing"
  cp "$T/settings" "$SETTINGS"; rm "$DATA/db.sqlite"; cpanel "" backup
  expect "names the missing database and where the folder came from" has "$ERR" "there is no database at $DATA/db.sqlite (DATA_DIR is read from $SETTINGS)"
  cpanel "" status
  expect "status still works" test "$RC" = 0
  expect "and says there is no database" has "$OUT" "none at $DATA/db.sqlite yet"
}

# ---------------------------------------------------------------- backup

test_backup_contents() {
  new_sandbox
  fresh_install
  app_has_run
  : >"$LOG"
  cpanel "" backup
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the folder is named <app>-<date>-<time>" test "$(basename "$b" | grep -cE '^tours-[0-9]{8}-[0-9]{6}$')" = 1
  expect "prints the folder" has "$OUT" "Backup written: $b"
  expect "the database is copied by the app's Node.js, inside its environment, closed to others" grep -qxF \
    "node[venv=apps/tours/24 umask=0077] -e <program> $DATA/db.sqlite $b.partial/db.sqlite" "$LOG"
  expect "the sqlite3 tool is not used while Node.js is there" test "$(grep -c '^sqlite3' "$LOG")" = 0
  expect "the copy is what node wrote, not a file copy of the live database" grep -qa "stand-in copy by node" "$b/db.sqlite"
  expect "the live WAL file is not copied beside it" test ! -e "$b/db.sqlite-wal"
  # The program handed to node is SQLite's own consistent copy, then a check of the copy.
  expect "the program uses node:sqlite" has "$REL/cpanel.sh" 'require("node:sqlite")'
  expect "the program uses VACUUM INTO" has "$REL/cpanel.sh" 'VACUUM INTO ?'
  expect "the program checks the copy" has "$REL/cpanel.sh" 'copy.prepare("PRAGMA integrity_check")'
  expect "the script never copies the database file with cp" test "$(grep -cE '^[^#]*\bcp\b[^#]*db\.sqlite' "$REL/cpanel.sh")" = 0
  expect "drafts are copied" cmp -s "$DATA/drafts/u1/step-001.png" "$b/drafts/u1/step-001.png"
  expect "public files are copied" cmp -s "$DATA/public/t1/step-001.png" "$b/public/t1/step-001.png"
  expect "the app files are archived" test "$(tar -tzf "$b/app.tgz" | grep -cxE 'dist/node/entry.js|migrations/0001_init.sql|package.json|package-lock.json|app.cjs|cpanel.sh|VERSION|.cpanel-install')" = 8
  expect "node_modules is not archived" test "$(tar -tzf "$b/app.tgz" | grep -c node_modules)" = 0
  expect "the app archive holds no settings" test "$(tar -xzOf "$b/app.tgz" | grep -cF -- "$(setup_code)")" = 0
  expect "the settings file is in the backup" cmp -s "$SETTINGS" "$b/tours-config.env"
  expect "the setup code is not shown" code_not_shown
  expect "only the database tool was called" test "$(calls)" = "node "
  expect "the live data is untouched" grep -qa "the live database" "$DATA/db.sqlite"
  if [ "$MODES" = 1 ]; then
    expect "the backup folder is mode 700" test "$(mode_of "$b")" = 700
    expect "the settings copy is mode 600" test "$(mode_of "$b/tours-config.env")" = 600
    expect "nothing in the backup is open to others" test -z "$(open_to_others "$b")"
  else
    echo "      SKIP: mode checks (this file system does not keep Unix file modes)"
  fi
  : >"$LOG"
  STUB_NODE_FAIL=1 cpanel "" backup
  expect "a failing copy fails the backup" test "$RC" != 0
  expect "says so" has "$ERR" "the backup failed; no backup folder was written"
  expect "the sqlite3 tool is not tried behind a Node.js that failed" test "$(calls)" = "node "
  expect "no second folder and no half-made one" test "$(backup_dirs)" = "$b"
}

test_backup_modes_with_an_open_umask() {
  [ "$MODES" = 1 ] || skip "this file system does not keep Unix file modes"
  new_sandbox
  ( umask 022; fresh_install )
  app_has_run
  chmod -R a+rX "$DATA"
  ( umask 000; cpanel "" backup; [ "$RC" = 0 ] )
  local b; b="$(only_backup)"
  expect "the backups folder is closed to others" test "$(mode_of "$BACKUPS")" = 700
  expect "the backup folder is mode 700" test "$(mode_of "$b")" = 700
  expect "the settings copy is mode 600" test "$(mode_of "$b/tours-config.env")" = 600
  expect "nothing in the backup is open to others" test -z "$(open_to_others "$b")"
}

test_backup_falls_back_to_sqlite3_only_without_node() {
  new_sandbox
  fresh_install
  app_has_run
  rm "$T/bin/node"
  if command -v node >/dev/null 2>&1; then skip "this system has a real node, so the app's Node.js cannot be made to look missing"; fi
  : >"$LOG"
  cpanel "" backup
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the copy is made by sqlite3's own backup" grep -qxF "sqlite3 $DATA/db.sqlite .backup '$b.partial/db.sqlite'" "$LOG"
  expect "the copy is then checked" grep -qxF "sqlite3 $b.partial/db.sqlite PRAGMA integrity_check;" "$LOG"
  expect "the tool's version is asked first" test "$(head -n 1 "$LOG")" = "sqlite3 --version"
  expect "version, then copy, then check, nothing else" test "$(calls)" = "sqlite3 sqlite3 sqlite3 "
  expect "the copy is what sqlite3 wrote" grep -qa "stand-in copy by sqlite3" "$b/db.sqlite"
  expect "says why sqlite3 is used" has "$OUT" "the app's Node.js was not found"
  local how
  for how in "STUB_INTEGRITY=*** in database main ***" "STUB_SQLITE_FAIL=1"; do
    : >"$LOG"
    # shellcheck disable=SC2163 # the variable holds NAME=value
    export "$how"
    cpanel "" backup
    unset "${how%%=*}"
    expect "$how: the backup fails" test "$RC" != 0
    expect "$how: says so" has "$ERR" "the backup failed; no backup folder was written"
    expect "$how: no second folder and no half-made one" test "$(backup_dirs)" = "$b"
  done
  STUB_INTEGRITY="*** in database main ***" cpanel "" backup
  expect "a copy that fails the check is named as such" has "$ERR" "the copy did not pass the integrity check"
  # With neither tool there is no safe way to copy, and the script says so.
  rm "$T/bin/sqlite3"
  if command -v sqlite3 >/dev/null 2>&1; then return 0; fi
  cpanel "" backup
  expect "neither tool: the backup fails" test "$RC" != 0
  expect "neither tool: says why" has "$ERR" "neither the app's Node.js"
  expect "neither tool: no file copy was made instead" test "$(backup_dirs)" = "$b"
}

test_backup_with_real_node_copies_a_live_wal_database() {
  new_sandbox
  rm "$T/bin/node"
  command -v node >/dev/null 2>&1 || skip "no real node on this system"
  node -e 'require("node:sqlite")' >/dev/null 2>&1 || skip "this node has no node:sqlite"
  fresh_install
  # A database in WAL mode with a row that is only in the WAL, held open by another
  # process while the backup runs: what a plain file copy of db.sqlite would miss.
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const [dbPath, ready, stop] = process.argv.slice(1);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\x27only in the WAL\x27)");
    fs.writeFileSync(ready, "");
    const started = Date.now();
    const timer = setInterval(() => {
      if (!fs.existsSync(stop) && Date.now() - started < 60000) return;
      clearInterval(timer);
      db.close();
    }, 50);
  ' "$(native "$DATA/db.sqlite")" "$(native "$T/ready")" "$(native "$T/stop")" &
  local holder=$! i=0
  while [ ! -e "$T/ready" ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
  [ -e "$T/ready" ] || { : >"$T/stop"; die "the process holding the database did not start"; }
  expect "the row is still only in the WAL" test -s "$DATA/db.sqlite-wal"
  cpanel "" backup
  : >"$T/stop"; wait "$holder" || true
  expect "the backup succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the copy is one file, without a WAL of its own" test -f "$b/db.sqlite" -a ! -e "$b/db.sqlite-wal"
  expect "the copy holds the row that was only in the WAL" test \
    "$(node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT v FROM t").get().v); db.close();' "$(native "$b/db.sqlite")")" = "only in the WAL"
  [ "$MODES" = 0 ] || expect "the copy is mode 600" test "$(mode_of "$b/db.sqlite")" = 600
  # A file that is not a whole database is not passed off as a backup.
  rm -f "$DATA/db.sqlite-wal" "$DATA/db.sqlite-shm"
  printf 'SQLite format 3\0 but nothing else of a database' >"$DATA/db.sqlite"
  cpanel "" backup
  expect "a damaged database fails the backup" test "$RC" != 0
  expect "no folder is written for it" test "$(backup_dirs)" = "$b"
}

test_backups_never_overwrite_each_other() {
  new_sandbox
  fresh_install
  app_has_run
  local i
  for i in 1 2 3; do cpanel "" backup; [ "$RC" = 0 ] || die "backup $i failed"; done
  expect "three backups, three folders" test "$(backup_dirs | wc -l | tr -d ' ')" = 3
  expect "each is whole" test "$(find "$BACKUPS" -name app.tgz | wc -l | tr -d ' ')" = 3
  cpanel "" backup --app-root apps/none
  expect "backup of nothing is refused" test "$RC" != 0
  expect "says nothing is installed" has "$ERR" "nothing is installed"
}

# ---------------------------------------------------------------- packages

test_a_node_modules_link_that_npm_replaces_is_reported() {
  new_sandbox
  fresh_install
  app_has_run
  # Some hosting keeps node_modules as a link into the app's Node.js environment.
  local target="$H/nodevenv/apps/tours/24/lib/node_modules"
  mkdir -p "$target"
  rm -rf "$APP/node_modules"; ln -s "$target" "$APP/node_modules"
  [ -L "$APP/node_modules" ] || skip "this system cannot make a symbolic link"
  make_release "$T/v2" 0.2.0
  cpanel_in "$T/v2" "" update --yes
  expect "update succeeds" test "$RC" = 0
  expect "a link that npm kept is left alone" test -L "$APP/node_modules"
  expect "and nothing is said about it" hasnt "$ERR" "was a link"
  make_release "$T/v3" 0.3.0
  STUB_NPM_REPLACES_LINK=1 cpanel_in "$T/v3" "" update --yes
  expect "update still succeeds" test "$RC" = 0
  expect "a link that npm replaced is reported" has "$ERR" "node_modules was a link into the Node.js environment before npm ci and is a plain folder now"
  expect "the script did not put it back by guessing" test ! -L "$APP/node_modules"
}

# ---------------------------------------------------------------- status

test_status() {
  new_sandbox
  fresh_install
  app_has_run
  : >"$LOG"
  cpanel "" status
  expect "exit code 0" test "$RC" = 0
  expect "the installed version" grep -qE '^    version: +0\.1\.1$' "$OUT"
  expect "the app folder and app root" grep -qE "^    app folder: +$APP \(app root apps/tours, Node\.js 24\)$" "$OUT"
  expect "the data folder with a size" grep -qE "^    data folder: +$DATA, [0-9.,]+[A-Za-z]*$" "$OUT"
  expect "no backup yet" grep -qE '^    last backup: +none yet$' "$OUT"
  expect "health ok" has "$OUT" "health: ok"
  expect "health asked at the domain" grep -qE "^curl .*https://$DOMAIN/healthz$" "$LOG"
  expect "status changes nothing but asks health and the API's status code" test "$(calls)" = "curl curl "
  expect "the setup code is not shown" code_not_shown

  cpanel "" backup; local first; first="$(only_backup)"
  # A later backup, and a half-made folder that must not be named.
  mkdir -p "$BACKUPS/tours-20991231-235959" "$BACKUPS/tours-20991231-235960.partial" "$BACKUPS/other-20991231-235959"
  cpanel "" status
  expect "the newest whole backup of this app" grep -qE "^    last backup: +$BACKUPS/tours-20991231-235959$" "$OUT"
  expect "the earlier one exists too" test -d "$first"

  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "a failed check is reported as failed" has "$OUT" "health: FAILED"
  expect "and not as ok" hasnt "$OUT" "health: ok"

  rm "$SETTINGS"
  cpanel "" status
  expect "a missing settings file is named" has "$OUT" "$SETTINGS is MISSING"
  expect "and the data folder is reported as not known" has "$OUT" "data folder:    NOT KNOWN"
}

test_status_when_nothing_is_installed() {
  new_sandbox
  cpanel "" status
  expect "exit code non-zero" test "$RC" != 0
  expect "says so" has "$ERR" "nothing is installed at $APP"
  expect "nothing was called" test ! -s "$LOG"
}

test_status_without_curl_is_honest() {
  new_sandbox
  fresh_install
  rm "$T/bin/curl"
  if command -v curl >/dev/null 2>&1; then skip "this system has a real curl, which the test must not call"; fi
  cpanel "" status
  expect "reports the check as not made" has "$OUT" "health: NOT CHECKED"
  expect "and not as ok" hasnt "$OUT" "health: ok"
}

# ---------------------------------------------------------------- a second address, for the app

# The two lines a settings file needs for two addresses, and the sentence the script
# prints when an address does not report its own role: wrong_role <host> <role>.
HOST_LINES="TOURS_HOST=$DOMAIN
APP_HOST=$APP_DOMAIN"
wrong_role() {
  printf '%s' "https://$1/healthz answered, but the platform does not see it as its $2 address. The settings file $SETTINGS must hold TOURS_HOST=$DOMAIN and APP_HOST=$APP_DOMAIN, and the app must be restarted after a change."
}
# The sentence an address gets that passes its health check and refuses everything else.
refuses() {
  printf '%s' "https://$1 answers its health check but refuses every other request: the settings file names other addresses in TOURS_HOST and APP_HOST than the one this install uses."
}
# What a person does by hand: the two lines, added to the settings file.
add_host_lines() { printf '%s\n' "$HOST_LINES" >>"$SETTINGS"; }
# An install with one address that was then given its second one, the way the guide has
# it: the two lines by hand, then an update that is told the app address, on an app that
# reports the role of each.
two_address_setup() {
  fresh_install
  app_has_run
  add_host_lines
  STUB_HEALTH=roles cpanel "" update --yes --app-domain "$APP_DOMAIN"
  [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "the update that adds the second address failed"; }
  grep -qxF "APP_DOMAIN=$APP_DOMAIN" "$APP/.cpanel-install" || die "the app address was not recorded"
  : >"$LOG"
}
# The health addresses that were asked, in order, one per line.
asked() { sed -n 's/^curl .*https:\/\/\([^/]*\)\/healthz$/\1/p' "$LOG"; }
# The sentence about the settings file and, right under it, the two lines; printed once.
kept_lines_printed() {
  [ "$(grep -xF -A 2 -- "    the settings file $SETTINGS is kept as it is. For two addresses it must hold these two lines; add them by hand if they are not there, then restart the app:" "$OUT")" = "    the settings file $SETTINGS is kept as it is. For two addresses it must hold these two lines; add them by hand if they are not there, then restart the app:
    TOURS_HOST=$DOMAIN
    APP_HOST=$APP_DOMAIN" ]
}

test_app_domain_is_checked() {
  new_sandbox
  local before; before="$(snapshot)"
  local bad
  for bad in "App.Example.com" "https://app.example.com" "app.example.com/x" "localhost" "203.0.113.10" "app_1.example.com" "app.example.com:8443" "*.example.com" "app.example.com;id"; do
    cpanel "" update --domain "$DOMAIN" --app-domain "$bad" --yes
    [ "$RC" = 2 ] || die "accepted (exit $RC): $bad"
    has "$ERR" "ERROR: --app-domain must be a host name in lowercase, such as app.example.com, without https:// and without a path" || die "no reason given for: $bad"
    cpanel "" status "--app-domain=$bad"
    [ "$RC" = 2 ] || die "accepted with = (exit $RC): $bad"
  done
  cpanel "" update --domain "$DOMAIN" --app-domain "$DOMAIN" --yes
  expect "the same name twice is refused" test "$RC" = 2
  expect "and says why" has "$ERR" "ERROR: --app-domain must be a different name than --domain"
  cpanel "" status "--domain=$DOMAIN" "--app-domain=$DOMAIN"
  expect "the same name twice is refused, written with =" test "$RC" = 2
  cpanel "" update --yes --app-domain
  expect "the option needs a value" test "$RC" = 2
  expect "and says so" has "$ERR" "--app-domain needs a value"
  cpanel "" backup --app-domain "$APP_DOMAIN"
  expect "it does not go with backup" test "$RC" = 2
  expect "and says where it goes" has "$ERR" "ERROR: --app-domain goes only with update and status"
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was written" test "$(snapshot)" = "$before"
  cpanel "" --help
  expect "the usage text names the option as the plan has it" grep -qxF \
    "  --app-domain <name> A second address, for the app, such as app.example.com. With it, --domain is the address of the tours. Remembered after the first time." "$OUT"
  expect "and says which commands take it" grep -qxF "                      With update and status. An install starts with one address." "$OUT"

  # On an install, the name is also checked against the address that is remembered. The
  # message does not name --domain, which was not given.
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  before="$(snapshot)"
  : >"$LOG"
  local cmd
  for cmd in update status; do
    cpanel_in "$T/new" "" "$cmd" --yes --app-domain "$DOMAIN"
    expect "$cmd: the remembered tours address is refused as the app address" test "$RC" != 0
    expect "$cmd: says why" has "$ERR" "ERROR: --app-domain must be a different name than the address of the tours, and $DOMAIN is the address of the tours of this install (recorded in $APP/.cpanel-install). Nothing was changed"
    expect "$cmd: does not name an option that was not given" hasnt "$ERR" "--domain"
  done
  expect "nothing was called, not even a backup" test ! -s "$LOG"
  expect "nothing was changed" test "$(snapshot)" = "$before"

  # A record someone changed by hand so that both names are the same: the commands that
  # check the addresses say so without blaming an option, and a backup, which checks
  # none, is still made.
  printf 'APP_DOMAIN=%s\n' "$DOMAIN" >>"$APP/.cpanel-install"
  cpanel "" status
  expect "the same name recorded twice: status refuses" test "$RC" != 0
  expect "the same name recorded twice: says what to do" has "$ERR" "ERROR: the app address recorded in $APP/.cpanel-install is the same as the tours address; remove the APP_DOMAIN line. Nothing was changed"
  expect "the same name recorded twice: blames no option" hasnt "$ERR" "--"
  expect "the same name recorded twice: no address was asked" test ! -s "$LOG"
  cpanel "" backup
  expect "the same name recorded twice: a backup is still made (stderr: $(cat "$ERR"))" test "$RC" = 0
  # A record that is not a host name is not used, and the script says so. A backup is
  # not told to give an option it refuses.
  sed -i 's/^APP_DOMAIN=.*/APP_DOMAIN=https:\/\/app.example.com\/x/' "$APP/.cpanel-install"
  : >"$LOG"
  cpanel "" status
  expect "a record that is no host name: status goes on" test "$RC" = 0
  expect "a record that is no host name: says it is not used" has "$ERR" "WARNING: the APP_DOMAIN line in $APP/.cpanel-install does not hold a host name and is not used. Remove that line; an update that is given --app-domain <name> writes it again"
  expect "a record that is no host name: only the tours address is asked" test "$(asked | tr '\n' ' ')" = "$DOMAIN "
  cpanel "" backup
  expect "a record that is no host name: a backup is still made" test "$RC" = 0
  expect "a record that is no host name: the backup is not told to give the option itself" hasnt "$ERR" "give "

  # An app address without an address of the tours beside it. An install made by hand
  # has no record: status that is given the option says what is missing.
  new_sandbox
  hand_install
  before="$(snapshot)"
  cpanel "" status --app-domain "$APP_DOMAIN"
  expect "no tours address, option given: status refuses" test "$RC" != 0
  expect "no tours address, option given: says what to add" has "$ERR" "ERROR: --app-domain needs the address of the tours beside it, and none is recorded for this install; add --domain <name>. Nothing was changed"
  cpanel "" update --yes --app-domain "$APP_DOMAIN"
  expect "no tours address, option given: update refuses too" test "$RC" != 0
  expect "no tours address, option given: update says to give the address" has "$ERR" "update --domain <name>"
  # And a record that holds an app address only: no option is blamed.
  printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN" >"$APP/.cpanel-install"
  before="$(snapshot)"
  cpanel "" status
  expect "no tours address, app address recorded: status refuses" test "$RC" != 0
  expect "no tours address, app address recorded: says what to do" has "$ERR" "ERROR: an app address is recorded in $APP/.cpanel-install but no address of the tours; add --domain <name>, or remove the APP_DOMAIN line. Nothing was changed"
  expect "no tours address, app address recorded: blames no option that was given" hasnt "$ERR" "--app-domain"
  cpanel "" status --domain "$DOMAIN"
  expect "with the tours address given, status goes on" test "$RC" = 0
  expect "nothing was called before that, and nothing was changed" test "$(snapshot)" = "$before"
}

test_install_with_app_domain_is_refused() {
  new_sandbox
  local before; before="$(snapshot)"
  local why="ERROR: --app-domain does not go with install: install with one address first, then add the second with update, as the guide's section \"A second address for the app\" describes"
  cpanel "" install --domain "$DOMAIN" --app-domain "$APP_DOMAIN" --yes
  expect "refused" test "$RC" = 2
  expect "says to install with one address first" has "$ERR" "$why"
  cpanel "" install "--domain=$DOMAIN" "--app-domain=$APP_DOMAIN" --yes
  expect "refused, written with =" test "$RC" = 2
  cpanel "" install --domain "$DOMAIN" --app-domain "$APP_DOMAIN" --dry-run
  expect "refused as a dry run too" test "$RC" = 2
  expect "the dry run says the same" has "$ERR" "$why"
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was written" test "$(snapshot)" = "$before"
  # The script holds no code that would write a host line: the two lines are a person's.
  expect "the script never writes TOURS_HOST or APP_HOST" test "$(grep -cE "printf[^#]*(TOURS_HOST|APP_HOST)=" "$SCRIPT")" = 0
}

test_install_without_app_domain_writes_todays_settings() {
  new_sandbox
  cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  # Byte for byte what the version before this option wrote.
  printf '# Settings of the tour platform in %s. Keep this file private.\nDATA_DIR=%s\nSETUP_CODE=%s\n' "$APP" "$DATA" "$(setup_code)" >"$T/want-settings"
  expect "the settings file is byte for byte today's" cmp -s "$T/want-settings" "$SETTINGS"
  printf '# Written by cpanel.sh. Nothing secret: the settings are in %s.\nDOMAIN=%s\nNODE=24\nFINISHED=yes\n' "$SETTINGS" "$DOMAIN" >"$T/want-state"
  expect "the state file is byte for byte today's" cmp -s "$T/want-state" "$APP/.cpanel-install"
  expect "no host line anywhere in the home folder" test "$(grep -rlE 'TOURS_HOST|APP_HOST|APP_DOMAIN' "$H" --exclude=cpanel.sh --exclude=app.cjs | wc -l | tr -d ' ')" = 0
  expect "health is asked once, at the one address" test "$(asked | tr '\n' ' ')" = "$DOMAIN "
  expect "reports health as before" grep -qxF "    health: ok" "$OUT"
  expect "ends as before" grep -qxF "==> Installed version 0.1.1, and it answers at https://$DOMAIN" "$OUT"
  expect "says nothing about a second address" test "$(cat "$OUT" "$ERR" | grep -ciE 'app address|TOURS_HOST|APP_HOST|creates no domain')" = 0
  # An app in two-address mode that this install does not know about still passes, as
  # any reply with "ok":true did before.
  app_has_run
  : >"$LOG"
  STUB_HEALTH=roles cpanel "" status
  expect "one recorded address: a reply that names a role is still ok" grep -qxF "    health: ok" "$OUT"
  expect "one recorded address: asked once" test "$(asked | tr '\n' ' ')" = "$DOMAIN "
}

# The app answers on both names, but with no role: its settings file lacks the two
# lines, or the installed version does not know them. An update that is told the app
# address must find that out before it changes anything.
test_existing_settings_file_is_kept_and_the_two_lines_are_printed() {
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  local sum; sum="$(sha256sum <"$SETTINGS")"
  local before; before="$(snapshot)"
  : >"$LOG"
  CPANEL_HEALTH_TRIES=3 cpanel_in "$T/new" "" update --yes --app-domain "$APP_DOMAIN"
  expect "no roles: exit code non-zero" test "$RC" != 0
  expect "no roles: each address was asked once, and nothing else was called: no backup, no packages, no restart" test "$(calls)" = "curl curl "
  expect "no roles: the tours address first, then the app address" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "
  expect "no roles: nothing at all was changed" test "$(snapshot)" = "$before"
  expect "no roles: no app address was recorded" test "$(grep -c APP_DOMAIN "$APP/.cpanel-install")" = 0
  expect "no roles: no backup folder was made" test ! -e "$BACKUPS"
  expect "no roles: the installed version is still the old one" test "$(cat "$APP/VERSION")" = 0.1.1
  expect "no roles: names the tours address" has "$OUT" "    health of the tours address: FAILED. $(wrong_role "$DOMAIN" tours)"
  expect "no roles: names the app address" has "$OUT" "    health of the app address: FAILED. $(wrong_role "$APP_DOMAIN" app)"
  expect "no roles: prints the sentence and the two lines, as the plan has them" kept_lines_printed
  expect "no roles: says what to do about an update that was cut off" has "$OUT" "If an earlier update was cut off, finish it first by running update without --app-domain."
  expect "no roles: says nothing was changed" has "$ERR" "ERROR: the two addresses do not both report their own role yet, so the update did not start and the app address was not recorded. Nothing was changed"
  expect "no roles: no commands to go back, there is nothing to go back from" hasnt "$OUT" "To go back"
  expect "no roles: does not claim success" hasnt "$OUT" "Updated to version"
  expect "no roles: the setup code is not shown" code_not_shown
  # The check comes before the question, so nobody is asked to agree to an update that
  # will not start.
  cpanel_in "$T/new" "" update --app-domain "$APP_DOMAIN"
  expect "no roles, without --yes: stops the same way" has "$ERR" "Nothing was changed"
  expect "no roles, without --yes: was not asked first" hasnt "$ERR" "[y/N]"
  expect "no roles, without --yes: nothing was changed" test "$(snapshot)" = "$before"

  # The person adds the two lines by hand and restarts; the app then reports both roles.
  add_host_lines
  sum="$(sha256sum <"$SETTINGS")"
  : >"$LOG"
  STUB_HEALTH=roles cpanel_in "$T/new" "" update --yes --app-domain "$APP_DOMAIN"
  expect "roles: the update goes through (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "roles: both addresses are checked before the backup, and again after the restart" test "$(calls)" = "curl curl curl curl node npm touch curl curl curl curl "
  expect "roles: the settings file is not changed by the script" test "$(sha256sum <"$SETTINGS")" = "$sum"
  expect "roles: the app address is remembered" grep -qxF "APP_DOMAIN=$APP_DOMAIN" "$APP/.cpanel-install"
  expect "roles: the lines are not printed when they are plainly there" hasnt "$OUT" "TOURS_HOST=$DOMAIN"
  expect "roles: ends with both addresses" has "$OUT" "==> Updated to version 0.2.0, and it answers at https://$DOMAIN and https://$APP_DOMAIN"
  expect "roles: the setup code is not shown" code_not_shown
  # Once it is remembered, there is no check before the next update, only the one after.
  make_release "$T/v3" 0.3.0
  : >"$LOG"
  STUB_HEALTH=roles cpanel_in "$T/v3" "" update --yes
  expect "next update: succeeds" test "$RC" = 0
  expect "next update: starts with the backup" test "$(calls)" = "node npm touch curl curl curl curl "
}

test_a_failed_update_does_not_record_a_new_app_address() {
  # A good app address is recorded; an update is given a name with a typo in it.
  new_sandbox
  two_address_setup
  make_release "$T/new" 0.2.0
  local before; before="$(snapshot)"
  STUB_HEALTH=roles cpanel_in "$T/new" "" update --yes --app-domain appp.example.com
  expect "typo: exit code non-zero" test "$RC" != 0
  expect "typo: says nothing was changed" has "$ERR" "Nothing was changed"
  expect "typo: nothing was changed" test "$(snapshot)" = "$before"
  expect "typo: the good address is still the recorded one" test "$(grep '^APP_DOMAIN=' "$APP/.cpanel-install")" = "APP_DOMAIN=$APP_DOMAIN"
  : >"$LOG"
  STUB_HEALTH=roles cpanel "" status
  expect "typo: status still checks the good address" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "

  # Both addresses report their roles before the update, and the app stops answering
  # after it: the app address that was given is not recorded by an update that failed.
  new_sandbox
  fresh_install
  app_has_run
  add_host_lines
  make_release "$T/new" 0.2.0
  rm -f "$STATE/curls"
  STUB_HEALTH=roles STUB_HEALTH_UNTIL=2 CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes --app-domain "$APP_DOMAIN"
  expect "stops answering: exit code non-zero" test "$RC" != 0
  expect "stops answering: the new version is in place" test "$(cat "$APP/VERSION")" = 0.2.0
  expect "stops answering: the commands to go back are shown, this is a real failure" has "$OUT" "To go back to the version that ran before"
  expect "stops answering: no app address was recorded" test "$(grep -c APP_DOMAIN "$APP/.cpanel-install")" = 0
  expect "stops answering: the tours address is still recorded" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  # Run again when the app answers: now it is recorded.
  STUB_HEALTH=roles cpanel_in "$T/new" "" update --yes --app-domain "$APP_DOMAIN"
  expect "run again: succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "run again: the app address is recorded" grep -qxF "APP_DOMAIN=$APP_DOMAIN" "$APP/.cpanel-install"
}

test_app_domain_is_remembered_by_update_and_status() {
  new_sandbox
  two_address_setup
  expect "both addresses are in the state file, the app address after the tours address" test "$(cat "$APP/.cpanel-install")" = "# Written by cpanel.sh. Nothing secret: the settings are in $SETTINGS.
DOMAIN=$DOMAIN
APP_DOMAIN=$APP_DOMAIN
NODE=24
FINISHED=yes"
  STUB_HEALTH=roles cpanel "" status
  expect "status: exit code 0" test "$RC" = 0
  expect "status: asks both addresses without being told" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "
  expect "status: shows both addresses" grep -qE "^    addresses: +https://$DOMAIN \(tours\) and https://$APP_DOMAIN \(app\)$" "$OUT"
  expect "status: each reports its role" test "$(grep -cE '^    health of the (tours|app) address: ok$' "$OUT")" = 2
  expect "status: changes nothing but asks health and the API's status code, per address" test "$(calls)" = "curl curl curl curl "
  make_release "$T/new" 0.2.0
  : >"$LOG"
  STUB_HEALTH=roles cpanel_in "$T/new" "" update --yes
  expect "update: exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "update: asks both addresses without being told" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "
  expect "update: shows the app address before it starts" grep -qE "^    app address: +https://$APP_DOMAIN$" "$OUT"
  expect "update: ends with both addresses" has "$OUT" "==> Updated to version 0.2.0, and it answers at https://$DOMAIN and https://$APP_DOMAIN"
  expect "update: both are still remembered" test "$(grep -E '^(APP_)?DOMAIN=' "$APP/.cpanel-install" | tr '\n' ' ')" = "DOMAIN=$DOMAIN APP_DOMAIN=$APP_DOMAIN "
  expect "update: the state file still says it finished" grep -qxF "FINISHED=yes" "$APP/.cpanel-install"
  # A backup has no use for the addresses and still works.
  cpanel "" backup
  expect "backup: still works" test "$RC" = 0
  expect "backup: the state file in it holds the app address" test "$(tar -xzOf "$(backup_dirs | tail -n 1)/app.tgz" .cpanel-install | grep -c "^APP_DOMAIN=$APP_DOMAIN\$")" = 1
  # The tours address cannot be given the name that is recorded as the app address.
  cpanel "" status --domain "$APP_DOMAIN"
  expect "--domain equal to the recorded app address: refused" test "$RC" != 0
  expect "--domain equal to the recorded app address: says why" has "$ERR" "ERROR: --domain must be a different name than the app address, and $APP_DOMAIN is the app address recorded in $APP/.cpanel-install. Nothing was changed"

  # status with the option on an install with one address checks both and records nothing.
  new_sandbox
  fresh_install
  app_has_run
  add_host_lines
  local before; before="$(snapshot)"
  : >"$LOG"
  STUB_HEALTH=roles cpanel "" status --app-domain "$APP_DOMAIN"
  expect "status --app-domain: exit code 0" test "$RC" = 0
  expect "status --app-domain: asks both addresses" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "
  expect "status --app-domain: each reports its role" test "$(grep -cE '^    health of the (tours|app) address: ok$' "$OUT")" = 2
  expect "status --app-domain: writes nothing" test "$(snapshot)" = "$before"
  : >"$LOG"
  cpanel "" status
  expect "afterwards status asks the one recorded address" test "$(asked | tr '\n' ' ')" = "$DOMAIN "
}

test_health_needs_each_address_to_report_its_own_role() {
  new_sandbox
  two_address_setup
  # Both names answer with the platform's reply, but without a role: the two lines are
  # gone from the settings file, or the app was not restarted.
  CPANEL_HEALTH_TRIES=2 cpanel "" status
  expect "no role: not reported as ok" test "$(grep -cE 'health.*: ok' "$OUT")" = 0
  expect "no role: the tours address is named" has "$OUT" "    health of the tours address: FAILED. $(wrong_role "$DOMAIN" tours)"
  expect "no role: the app address is named" has "$OUT" "    health of the app address: FAILED. $(wrong_role "$APP_DOMAIN" app)"
  expect "no role: each address was tried as often as asked" test "$(asked | tr '\n' ' ')" = "$DOMAIN $DOMAIN $APP_DOMAIN $APP_DOMAIN "
  expect "no role: the setup code is not shown" code_not_shown
  # The same app, once it reports the roles.
  : >"$LOG"
  STUB_HEALTH=roles cpanel "" status
  expect "roles: each address is ok" test "$(grep -cE '^    health of the (tours|app) address: ok$' "$OUT")" = 2
  expect "roles: one try each is enough" test "$(asked | tr '\n' ' ')" = "$DOMAIN $APP_DOMAIN "
  # An app that is still starting is waited for, per address.
  : >"$LOG"; rm -f "$STATE/curls"
  STUB_HEALTH=roles STUB_HEALTH_AFTER=3 cpanel "" status
  expect "starting: the first address is asked until it answers, then the second" test "$(asked | tr '\n' ' ')" = "$DOMAIN $DOMAIN $DOMAIN $APP_DOMAIN "
  expect "starting: both end up ok" test "$(grep -cE '^    health of the (tours|app) address: ok$' "$OUT")" = 2
  # Another site answering for the second name is not the platform.
  STUB_HEALTH=roles STUB_HEALTH_APP=parked CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "parked: the tours address is ok" has "$OUT" "    health of the tours address: ok"
  expect "parked: the app address is not" has "$OUT" "    health of the app address: FAILED. https://$APP_DOMAIN/healthz answered, but not with the platform's reply; another site may be answering for this name"
  # A second name without a certificate, or one that is no longer attached.
  STUB_HEALTH=roles STUB_HEALTH_APP=fail CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "no answer: the tours address is ok" has "$OUT" "    health of the tours address: ok"
  expect "no answer: the app address is named with curl's reason" has "$OUT" "    health of the app address: FAILED. https://$APP_DOMAIN/healthz did not answer (curl: (22) The requested URL returned error: 503)"
  # After an update, an address that does not answer at all is a real failure: the
  # hints and the commands to go back are shown, as for one address.
  make_release "$T/new" 0.2.0
  STUB_HEALTH=roles STUB_HEALTH_APP=fail CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes
  expect "update, no answer: exit code non-zero" test "$RC" != 0
  expect "update, no answer: says the check did not pass" has "$OUT" "Version 0.2.0 is in place, but the health check did not pass"
  expect "update, no answer: the hints name the second address" has "$OUT" "$APP_DOMAIN must be attached to the same Node.js app"
  expect "update, no answer: the commands to go back are shown" has "$OUT" "To go back to the version that ran before"
  expect "update, no answer: the app address stays remembered" grep -qxF "APP_DOMAIN=$APP_DOMAIN" "$APP/.cpanel-install"
}

test_health_names_the_address_that_reports_the_wrong_role() {
  new_sandbox
  two_address_setup
  make_release "$T/new" 0.2.0
  # Everything this test makes the script print, to look at in the end.
  : >"$T/all"
  keep() { cat "$OUT" "$ERR" >>"$T/all"; }
  # The app sees every request as its tours address: something in front of it changes
  # the host name, or the second name is not the one in the settings file.
  STUB_HEALTH=roles STUB_HEALTH_APP=tours CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes; keep
  expect "update: exit code non-zero" test "$RC" != 0
  expect "update: the tours address is ok" grep -qxF "    health of the tours address: ok" "$OUT"
  expect "update: the app address is named, with the sentence as the plan has it" grep -qxF "    health of the app address: FAILED. $(wrong_role "$APP_DOMAIN" app)" "$OUT"
  expect "update: the tours address is not blamed" hasnt "$OUT" "$(wrong_role "$DOMAIN" tours)"
  expect "update: does not claim success" hasnt "$OUT" "Updated to version"
  # The new version answers on both names, so it is not at fault and nothing sends the
  # person back to the previous one.
  expect "update: says the version is in place and answers" grep -qxF "==> Version 0.2.0 is in place and answers, but the addresses do not report their roles" "$OUT"
  expect "update: prints the two lines" kept_lines_printed
  expect "update: no commands to go back" hasnt "$OUT" "To go back"
  expect "update: no rollback line at all" test "$(rollback_lines | wc -l | tr -d ' ')" = 0
  expect "update: says why there are none" has "$OUT" "The new version itself answers, so no commands to go back are shown"
  expect "update: says how to check again" has "$OUT" "Check again at any time with:"
  expect "update: the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "update: no update is left marked as under way" test ! -e "$APP/.cpanel-update"
  expect "update: the app address stays remembered" grep -qxF "APP_DOMAIN=$APP_DOMAIN" "$APP/.cpanel-install"
  expect "update: the setup code is not shown" code_not_shown
  # The two swapped: each is named with the role it should have had.
  STUB_HEALTH=roles STUB_HEALTH_TOURS=app STUB_HEALTH_APP=tours CPANEL_HEALTH_TRIES=1 cpanel "" status; keep
  expect "swapped: status itself still exits 0, as for any failed check" test "$RC" = 0
  expect "swapped: the tours address is named" grep -qxF "    health of the tours address: FAILED. $(wrong_role "$DOMAIN" tours)" "$OUT"
  expect "swapped: the app address is named" grep -qxF "    health of the app address: FAILED. $(wrong_role "$APP_DOMAIN" app)" "$OUT"
  expect "swapped: nothing is reported as ok" test "$(grep -cE 'health.*: ok' "$OUT")" = 0
  # Only the tours address is wrong: the app address is still reported, as ok.
  STUB_HEALTH=roles STUB_HEALTH_TOURS=ok CPANEL_HEALTH_TRIES=1 cpanel "" status; keep
  expect "tours wrong: named" grep -qxF "    health of the tours address: FAILED. $(wrong_role "$DOMAIN" tours)" "$OUT"
  expect "tours wrong: the app address is ok" grep -qxF "    health of the app address: ok" "$OUT"
  # A wrong role beside an address that does not answer is a real failure after an update.
  make_release "$T/v3" 0.3.0
  STUB_HEALTH=roles STUB_HEALTH_TOURS=fail STUB_HEALTH_APP=tours CPANEL_HEALTH_TRIES=1 cpanel_in "$T/v3" "" update --yes; keep
  expect "one wrong, one silent: the commands to go back are shown" has "$OUT" "To go back to the version that ran before"
  # A reply is never printed, whatever answered and whichever command asked.
  STUB_HEALTH=roles cpanel "" status; keep
  STUB_HEALTH=parked CPANEL_HEALTH_TRIES=1 cpanel "" status; keep
  expect "something was printed by every command" test "$(grep -c 'health of the tours address' "$T/all")" = 6
  expect "no reply is echoed anywhere in what was printed" test "$(grep -cE '"address"|"ok"|parked' "$T/all")" = 0
}

test_dry_run_with_app_domain_changes_nothing() {
  # On an install with one address, a dry run with the option asks nothing, records
  # nothing, and says what would be checked first.
  new_sandbox
  fresh_install
  app_has_run
  make_release "$T/new" 0.2.0
  local before; before="$(snapshot)"
  : >"$LOG"
  local cmd
  for cmd in update status; do
    cpanel_in "$T/new" "" "$cmd" --app-domain "$APP_DOMAIN" --dry-run
    expect "$cmd --dry-run exits 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
    expect "$cmd: nothing was called" test ! -s "$LOG"
    expect "$cmd: nothing was written, the app address included" test "$(snapshot)" = "$before"
    expect "$cmd: names both health addresses" has "$OUT" "Checking https://$DOMAIN/healthz and https://$APP_DOMAIN/healthz"
    expect "$cmd: does not claim health" test "$(grep -cE 'health.*: ok' "$OUT")" = 0
  done
  cpanel_in "$T/new" "" update --app-domain "$APP_DOMAIN" --dry-run
  expect "update: prints the two lines it expects in the settings file" kept_lines_printed
  expect "update: says what it would check before anything else" has "$OUT" "would first ask https://$DOMAIN/healthz and https://$APP_DOMAIN/healthz for their roles, and stop with nothing changed unless each reports its own"
  expect "update: says it was a dry run" has "$OUT" "Dry run: nothing was changed"
  expect "the state file still holds one address" test "$(grep -c APP_DOMAIN "$APP/.cpanel-install")" = 0
}

# A settings file whose TOURS_HOST and APP_HOST name other addresses than the one in use:
# /healthz answers on any name, so the health check alone would call that healthy while
# every tour link and the app's own API are refused with 421.
test_health_notices_an_address_that_refuses_every_other_request() {
  new_sandbox
  fresh_install
  app_has_run
  : >"$LOG"
  cpanel "" status
  expect "401: health is ok" grep -qxF "    health: ok" "$OUT"
  expect "health first, then the API" test "$(sed -n 's/^curl .*https:\/\/[^/]*\(\/.*\)$/\1/p' "$LOG" | tr '\n' ' ')" = "/healthz /api/v1/me "
  expect "the API is asked at the same address, the body thrown away, only the status code kept" grep -qxF "curl -sS -o /dev/null -w %{http_code} --max-time 20 https://$DOMAIN/api/v1/me" "$LOG"
  expect "no token and no header is sent" test "$(grep -ciE 'authorization|bearer|-H |--header|dp_' "$LOG")" = 0
  : >"$LOG"; rm -f "$STATE/curls"
  STUB_ME=421 CPANEL_HEALTH_TRIES=3 cpanel "" status
  expect "421: reported as failed, with the sentence" grep -qxF "    health: FAILED. $(refuses "$DOMAIN")" "$OUT"
  expect "421: not reported as ok" hasnt "$OUT" "health: ok"
  expect "421: asked once, it would not get better by waiting" test "$(asked | tr '\n' ' ')" = "$DOMAIN "
  # Any other answer is not judged: only 421 says the host name is refused.
  local code
  for code in 401 403 404 500 502 000 fail; do
    STUB_ME="$code" cpanel "" status
    expect "status code $code: health stays ok" grep -qxF "    health: ok" "$OUT"
  done
  # After an update it is a failed check like any other.
  make_release "$T/new" 0.2.0
  STUB_ME=421 cpanel_in "$T/new" "" update --yes
  expect "update, 421: exit code non-zero" test "$RC" != 0
  expect "update, 421: names the reason" has "$OUT" "health: FAILED. $(refuses "$DOMAIN")"
  expect "update, 421: does not claim success" hasnt "$OUT" "Updated to version"
  expect "update, 421: says the check did not pass" has "$OUT" "Version 0.2.0 is in place, but the health check did not pass"
  expect "update, 421: the setup code is not shown" code_not_shown
  # And an install is not called finished.
  new_sandbox
  STUB_ME=421 cpanel "" install --domain "$DOMAIN" --yes
  expect "install, 421: exit code non-zero" test "$RC" != 0
  expect "install, 421: does not claim it answers" hasnt "$OUT" "and it answers at"
  expect "install, 421: recorded as not finished" grep -qxF "FINISHED=no" "$APP/.cpanel-install"

  # With two recorded addresses each one is asked, and the one that refuses is named.
  new_sandbox
  two_address_setup
  STUB_HEALTH=roles cpanel "" status
  expect "two addresses: health, then the API, per address" test "$(sed -n 's/^curl .*https:\/\/\(.*\)$/\1/p' "$LOG" | tr '\n' ' ')" = "$DOMAIN/healthz $DOMAIN/api/v1/me $APP_DOMAIN/healthz $APP_DOMAIN/api/v1/me "
  STUB_HEALTH=roles STUB_ME_APP=421 cpanel "" status
  expect "two addresses: the tours address is ok" grep -qxF "    health of the tours address: ok" "$OUT"
  expect "two addresses: the app address is named" grep -qxF "    health of the app address: FAILED. $(refuses "$APP_DOMAIN")" "$OUT"
  STUB_HEALTH=roles STUB_ME_TOURS=421 cpanel "" status
  expect "two addresses: the tours address is named" grep -qxF "    health of the tours address: FAILED. $(refuses "$DOMAIN")" "$OUT"
  expect "two addresses: the app address is ok" grep -qxF "    health of the app address: ok" "$OUT"
  # After an update that is a failed check, not a matter of roles: the way back is shown.
  make_release "$T/new" 0.2.0
  STUB_HEALTH=roles STUB_ME_TOURS=421 cpanel_in "$T/new" "" update --yes
  expect "two addresses, update: exit code non-zero" test "$RC" != 0
  expect "two addresses, update: says the check did not pass" has "$OUT" "Version 0.2.0 is in place, but the health check did not pass"
  expect "two addresses, update: the commands to go back are shown" has "$OUT" "To go back to the version that ran before"
}

# The two lines are in the settings file the wrong way round, and the script knows of one
# address only: /healthz answers and the API answers 401, so nothing else would notice
# that the platform takes the tours address for its app address and sends every tour
# link away.
test_one_recorded_address_that_reports_the_app_role_fails() {
  new_sandbox
  fresh_install
  app_has_run
  local swapped="https://$DOMAIN/healthz answered, but the platform does not see it as its tours address: it reports it as its app address. In the settings file $SETTINGS the lines TOURS_HOST and APP_HOST are probably the wrong way round: TOURS_HOST must name $DOMAIN. Restart the app after a change."
  : >"$LOG"
  STUB_HEALTH=app CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "status: reported as failed, with the reason" grep -qxF "    health: FAILED. $swapped" "$OUT"
  expect "status: not reported as ok" hasnt "$OUT" "health: ok"
  expect "status: the API is not asked for an address that already failed" test "$(grep -c 'api/v1/me' "$LOG")" = 0
  # The role it should have, or no role at all, is fine as before.
  STUB_HEALTH=tours cpanel "" status
  expect "status: the tours role is ok" grep -qxF "    health: ok" "$OUT"
  STUB_HEALTH=ok cpanel "" status
  expect "status: no role is ok" grep -qxF "    health: ok" "$OUT"
  make_release "$T/new" 0.2.0
  STUB_HEALTH=app CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes
  expect "update: exit code non-zero" test "$RC" != 0
  expect "update: names the reason" has "$OUT" "health: FAILED. $swapped"
  expect "update: does not claim success" hasnt "$OUT" "Updated to version"
  expect "update: says the check did not pass" has "$OUT" "Version 0.2.0 is in place, but the health check did not pass"
  expect "update: the reply is not echoed" test "$(cat "$OUT" "$ERR" | grep -c '"address"')" = 0
  expect "update: the setup code is not shown" code_not_shown
  # With both addresses recorded, the same reply on the tours address is the wrong role, as before.
  new_sandbox
  two_address_setup
  STUB_HEALTH=roles STUB_HEALTH_TOURS=app CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "two addresses: the usual sentence" grep -qxF "    health of the tours address: FAILED. $(wrong_role "$DOMAIN" tours)" "$OUT"
}

test_app_domain_never_shows_the_setup_code() {
  new_sandbox
  two_address_setup
  local c; c="$(setup_code)"
  # Besides the settings file, only the copy of it in the backup the update made holds the code.
  expect "the code is in no file but the settings file and its backup copy" test "$(grep -rlF -- "$c" "$H" | grep -vxF "$SETTINGS" | grep -cv "^$BACKUPS/tours-[0-9-]*/tours-config.env\$")" = 0
  local mode
  for mode in roles ok fail parked; do
    STUB_HEALTH="$mode" CPANEL_HEALTH_TRIES=1 cpanel "" status
    expect "status, health $mode: does not show the setup code" code_not_shown
  done
  STUB_HEALTH=roles STUB_ME=421 cpanel "" status
  expect "status, refused by the API: does not show it" code_not_shown
  make_release "$T/new" 0.2.0
  STUB_HEALTH=roles STUB_HEALTH_APP=tours CPANEL_HEALTH_TRIES=1 cpanel_in "$T/new" "" update --yes
  expect "an update whose roles are wrong does not show it" code_not_shown
  STUB_HEALTH=roles cpanel_in "$T/new" "" update --yes --app-domain other.example.com
  expect "an update that stops at its first check does not show it" code_not_shown
  cpanel_in "$T/new" "" update --app-domain other.example.com --dry-run
  expect "a dry run does not show it" code_not_shown
  expect "and the settings file still holds the code it was given" test "$(setup_code)" = "$c"
}

# ---------------------------------------------------------------- the admin command

# An install whose version has the admin command, that has run, with a mail password in
# its settings file (a secret besides the setup code that must never be shown).
admin_install() {
  fresh_install
  app_has_run
  printf '// the admin command\n' >"$APP/dist/node/admin.js"
  printf 'SMTP_PASSWORD=a-made-up-mail-password-42\n' >>"$SETTINGS"
  : >"$LOG"
}
# Neither the setup code nor the mail password is in what the run printed or in any command line.
secrets_not_shown() { code_not_shown && ! grep -qF -- "a-made-up-mail-password-42" "$OUT" "$ERR" "$LOG"; }
# Nor is the data folder, a value of the settings file too.
no_setting_shown() { secrets_not_shown && ! grep -qF -- "$DATA" "$OUT" "$ERR"; }

test_admin_runs_the_command_in_the_apps_node_with_the_data_folder() {
  new_sandbox
  admin_install
  local before; before="$(snapshot)"
  cpanel "" admin first-admin --email owner@example.com --username owner
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "the command runs in the app folder, inside the app's Node.js environment, through the startup file that reads the settings" grep -qxF \
    "node[venv=apps/tours/24 umask=0077 cwd=$APP] app.cjs admin first-admin --email owner@example.com --username owner" "$LOG"
  expect "nothing else is run" test "$(calls)" = "node "
  expect "what the command says is shown, after one empty line, and nothing before it" test "$(head -n 2 "$OUT")" = "$(printf '\nstand-in admin command, 7 arguments')"
  expect "the command is told how it was run, for its usage text" grep -qxF "name[$REL/cpanel.sh admin]" "$OUT"
  expect "nothing on stderr" test ! -s "$ERR"
  expect "no secret and no value of the settings file is shown" no_setting_shown
  expect "nothing in the home folder changed" test "$(snapshot)" = "$before"
  # The command's exit code is the script's, and the script adds no words of its own.
  STUB_ADMIN_EXIT=1 cpanel "" admin signin-link --email stranger@example.com
  expect "a refusal of the command is exit 1" test "$RC" = 1
  expect "with no ERROR line from the script" test ! -s "$ERR"
  # The installed copy of the script runs it the same way.
  : >"$LOG"
  cpanel_raw "" bash "$APP/cpanel.sh" admin audit
  expect "the installed copy runs it too (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "from the app folder" grep -qxF "node[venv=apps/tours/24 umask=0077 cwd=$APP] app.cjs admin audit" "$LOG"
}

test_admin_passes_its_arguments_unchanged() {
  new_sandbox
  admin_install
  # The script's own options go before the command's first argument; from there on every
  # argument is the command's, also one that looks like the script's own.
  cpanel "" --app-root apps/tours admin --node 24 --email you@example.com --username alex
  expect "the approved form runs (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "as typed" grep -qxF "node[venv=apps/tours/24 umask=0077 cwd=$APP] app.cjs admin --email you@example.com --username alex" "$LOG"
  # shellcheck disable=SC2016 # the literal $(id) and * are the input
  cpanel "" admin first-admin --email=' you@example.com' --username 'a b' '' '$(id)' '*' --dry-run --app-root x install
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "every argument arrives as one, unchanged" test "$(sed -n 's/^arg\[\(.*\)\]$/\1/p' "$OUT" | tr '\n' '|')" = \
    'app.cjs|admin|first-admin|--email= you@example.com|--username|a b||$(id)|*|--dry-run|--app-root|x|install|'
  expect "an option after the first argument is not taken as a dry run" grep -q "^stand-in admin command" "$OUT"
}

test_admin_needs_an_install() {
  new_sandbox
  local before; before="$(snapshot)"
  cpanel "" admin first-admin --email you@example.com --username alex
  expect "nothing installed: refused" test "$RC" = 1
  expect "nothing installed: says so" has "$ERR" "nothing is installed at $APP"
  cpanel "" admin
  expect "admin without arguments: a usage error" test "$RC" = 2
  expect "and says what to give" has "$ERR" "admin first-admin --email you@example.com --username yourname"
  cpanel "" --app-domain "$APP_DOMAIN" admin audit
  expect "the address options do not go with admin" test "$RC" = 2
  cpanel "" --allow-downgrade admin audit
  expect "nor --allow-downgrade" test "$RC" = 2
  expect "no stand-in was called" test ! -s "$LOG"
  expect "nothing was written" test "$(snapshot)" = "$before"
  # An install of a version before the command.
  fresh_install
  app_has_run
  : >"$LOG"
  cpanel "" admin audit
  expect "a version without the command: refused" test "$RC" = 1
  expect "and told to update" has "$ERR" "has no admin command yet"
  # Without its settings file, its data folder or its Node.js environment.
  printf '// the admin command\n' >"$APP/dist/node/admin.js"
  mv "$SETTINGS" "$T/settings.away"
  cpanel "" admin audit
  expect "no settings file: refused" test "$RC" = 1
  expect "no settings file: says which" has "$ERR" "the settings file $SETTINGS is missing"
  mv "$T/settings.away" "$SETTINGS"
  mv "$DATA" "$T/data.away"
  cpanel "" admin audit
  expect "no data folder: refused" test "$RC" = 1
  expect "no data folder: says which, without naming it" has "$ERR" "the data folder that DATA_DIR in $SETTINGS names does not exist"
  expect "no data folder: no value of the settings file is shown" no_setting_shown
  mv "$T/data.away" "$DATA"
  mv "$ACTIVATE" "$T/activate.away"
  cpanel "" admin audit
  expect "no Node.js environment: refused" test "$RC" = 1
  expect "no Node.js environment: says where it was looked for" has "$ERR" "$ACTIVATE"
  mv "$T/activate.away" "$ACTIVATE"
  expect "the command was never run" test ! -s "$LOG"
  expect "no secret is shown" code_not_shown
}

test_admin_dry_run_runs_nothing() {
  new_sandbox
  admin_install
  local before; before="$(snapshot)"
  cpanel "" admin --dry-run first-admin --email owner@example.com --username owner
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "no stand-in was called" test ! -s "$LOG"
  expect "prints the command" has "$OUT" "&& node app.cjs admin first-admin --email owner@example.com --username owner"
  expect "in the app's Node.js environment and the app folder" has "$OUT" "source $ACTIVATE && cd $APP &&"
  expect "says nothing was changed" has "$OUT" "Dry run: nothing was changed"
  expect "nothing was written" test "$(snapshot)" = "$before"
  expect "no secret and no value of the settings file is shown" no_setting_shown
}

test_an_old_sqlite3_tool_is_not_used_for_the_copy() {
  new_sandbox
  fresh_install
  app_has_run
  # No Node.js environment, so the copy would fall to the sqlite3 tool.
  rm "$ACTIVATE"
  local v
  for v in "3.31.1 2020-01-27 19:55:54 3bfa9cc97da10598521b342961df8f5f68c7388fa117345eeb516eaa837balt1" "3.36.0 2021-06-18" "2.8.17" "something else" ""; do
    : >"$LOG"
    STUB_SQLITE_VERSION="$v" cpanel "" backup
    expect "$v: the backup fails" test "$RC" != 0
    expect "$v: says why, in one sentence" has "$ERR" "the sqlite3 tool here is older than 3.37 and cannot read this database, so it is not used for the copy; the app's Node.js is needed for a backup"
    expect "$v: the tool is asked its version and nothing else" test "$(cat "$LOG")" = "sqlite3 --version"
    expect "$v: no backup folder" test -z "$(backup_dirs)"
  done
  for v in "3.37.0 2021-11-27" "3.46.1 2024-08-13" "4.0.0"; do
    : >"$LOG"
    STUB_SQLITE_VERSION="$v" cpanel "" backup
    expect "$v: the tool is used (stderr: $(cat "$ERR"))" test "$RC" = 0
    expect "$v: for the copy" grep -q "^sqlite3 .* \.backup " "$LOG"
  done
}

test_admin_with_real_node_hands_the_command_the_settings() {
  new_sandbox
  rm "$T/bin/node"
  command -v node >/dev/null 2>&1 || skip "no real node on this system"
  admin_install
  # A stand-in command, with the real one's exports, behind the real startup file: it says what it was given.
  cat >"$APP/dist/node/admin.js" <<'EOF'
export const ADMIN_SETTINGS = ["DATA_DIR", "SETUP_CODE", "SMTP_PASSWORD", "APP_HOST", "RECOVERY_LINKS"];
export function isRecoveryOn(v) { return typeof v === "string" && v.trim().toLowerCase() === "on"; }
export async function main(argv, opts) {
  console.log("argv=" + JSON.stringify(argv));
  console.log("DATA_DIR=" + process.env.DATA_DIR);
  console.log("SETUP_CODE is " + (process.env.SETUP_CODE ? "set" : "not set"));
  console.log("SMTP_PASSWORD is " + (process.env.SMTP_PASSWORD ? "set" : "not set"));
  console.log("APP_HOST is " + (process.env.APP_HOST ? "set" : "not set"));
  console.log("gate=" + (opts && opts.recoveryLinks === true ? "on" : "off"));
  process.exitCode = 3;
}
EOF
  # A setting exported in the shell reaches the command neither as a setting nor as the gate.
  APP_HOST=other.example.com RECOVERY_LINKS=on cpanel "" admin first-admin --email 'you@example.com' --username 'a b'
  expect "the command's exit code comes back (stderr: $(cat "$ERR"))" test "$RC" = 3
  expect "the arguments arrive unchanged" has "$OUT" 'argv=["first-admin","--email","you@example.com","--username","a b"]'
  expect "with the data folder from the settings file" grep -qxF "DATA_DIR=$DATA" "$OUT"
  expect "and every other setting, as the app gets them" has "$OUT" "SMTP_PASSWORD is set"
  expect "the setup code too" has "$OUT" "SETUP_CODE is set"
  expect "but not a host exported in the shell" has "$OUT" "APP_HOST is not set"
  expect "and the gate stays closed without the line in the file" has "$OUT" "gate=off"
  expect "no secret is shown" secrets_not_shown
  printf 'RECOVERY_LINKS=on\n' >>"$SETTINGS"
  cpanel "" admin --email 'you@example.com'
  expect "the file's line opens the gate" has "$OUT" "gate=on"
}

# ---------------------------------------------------------------- run

[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }
OS_NAME="$(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release 2>/dev/null || true)"
echo "== cpanel.sh on ${OS_NAME:-$(uname -s)} with bash ${BASH_VERSION%%(*}"
[ "$MODES" = 1 ] || echo "   file modes are not kept on this file system: mode checks are skipped"
if [ "$#" -gt 0 ]; then TESTS="$*"; else TESTS="$(declare -F | awk '{print $3}' | grep '^test_')"; fi
# JOBS tests at a time (default: one per processor). Starting a program is slow under
# Git Bash on Windows, so there the whole file takes minutes rather than seconds.
JOBS="${JOBS:-$( (nproc || getconf _NPROCESSORS_ONLN || echo 2) 2>/dev/null | head -n 1)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || JOBS=2
n=0
for t in $TESTS; do
  start_test "$t" &
  n=$((n + 1))
  if [ "$n" -ge "$JOBS" ]; then
    # Wait for one to finish; a Bash too old for that waits for all of them.
    if wait -n 2>/dev/null; then n=$((n - 1)); else wait; n=0; fi
  fi
done
wait
for t in $TESTS; do report_test "$t"; done
echo
echo "$PASSES passed, $FAILS failed, $SKIPS skipped"
[ "$FAILS" = 0 ]

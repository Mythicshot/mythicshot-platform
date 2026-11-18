#!/usr/bin/env bash
# Tests deploy/cpanel/cpanel.sh without any hosting, the way deploy/test-install.sh
# tests install.sh: each test gets a sandbox with its own home folder and a bin folder
# of stand-ins for cloudlinux-selector, npm, node, sqlite3, curl and touch, put in front
# of PATH. The stand-ins record what would be run; the tests assert on that record, on
# what the script printed and on the files it wrote. Nothing here opens a network
# connection, and no root and no container is needed.
#
# Not covered here, only on real hosting: the real cloudlinux-selector, the real Node.js
# environment and its npm, Passenger's restart, the real sqlite3 tool and the hosting's
# web server and certificate in front of /healthz.
#
# Usage: bash deploy/cpanel/test-cpanel.sh [test_name ...]   (env: JOBS=<tests at a time>)
# `npm run test:node` runs it through test/node-cpanel-script.test.ts.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd -P)"
SCRIPT="$HERE/cpanel.sh"
APP_CJS="$HERE/app.cjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dp-cpanel-test.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
DOMAIN=tours.example.com
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
  REL="$T/release"
  make_release "$REL" 0.1.1
}

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
  cat >"$b/npm" <<'EOF'
#!/bin/bash
printf 'npm[venv=%s cwd=%s] %s\n' "${STUB_VENV:-none}" "$PWD" "$*" >>"$STUB_LOG"
[ "${STUB_NPM_FAIL:-0}" != 1 ] || { echo "npm error code ENOSPC" >&2; exit 1; }
mkdir -p node_modules
EOF
  cat >"$b/node" <<'EOF'
#!/bin/bash
# Called as: node -e <program> <database> <copy>. The program text is not recorded.
printf 'node[venv=%s] %s <program> %s %s\n' "${STUB_VENV:-none}" "$1" "$3" "$4" >>"$STUB_LOG"
[ "${STUB_NODE_FAIL:-0}" != 1 ] || { echo "Error: database is locked" >&2; exit 1; }
printf 'SQLite format 3\0(stand-in copy by node)\n' >"$4"
EOF
  cat >"$b/sqlite3" <<'EOF'
#!/bin/bash
printf 'sqlite3 %s\n' "$*" >>"$STUB_LOG"
[ "${STUB_SQLITE_FAIL:-0}" != 1 ] || { echo "Error: unable to open database file" >&2; exit 1; }
target="${2#.backup \'}"; target="${target%\'}"
[ "${STUB_SQLITE_WRITES_NOTHING:-0}" = 1 ] || printf 'SQLite format 3\0(stand-in copy by sqlite3)\n' >"$target"
EOF
  cat >"$b/curl" <<'EOF'
#!/bin/bash
printf 'curl %s\n' "$*" >>"$STUB_LOG"
n=$(cat "$STUB_STATE/curls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STUB_STATE/curls"
mode="${STUB_HEALTH:-ok}"
# STUB_HEALTH_AFTER=n: the first n-1 calls fail, like an app that is still starting.
if [ -n "${STUB_HEALTH_AFTER:-}" ] && [ "$n" -lt "$STUB_HEALTH_AFTER" ]; then mode=fail; fi
case "$mode" in
  ok) echo '{"ok":true}' ;;
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

# Runs a release's cpanel.sh in the sandbox: cpanel_in <release> <stdin text> <args...>;
# sets RC, OUT, ERR. The health check does not wait between tries.
cpanel_in() {
  local rel="$1" input="$2"; shift 2
  OUT="$T/out"; ERR="$T/err"
  set +e
  printf '%s' "$input" | env HOME="$H" PATH="$T/bin:$PATH" STUB_LOG="$LOG" STUB_STATE="$STATE" \
    CPANEL_HEALTH_WAIT=0 bash "$rel/cpanel.sh" "$@" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}
cpanel() { cpanel_in "$REL" "$@"; }

fresh_install() { cpanel "" install --domain "$DOMAIN" --yes; [ "$RC" = 0 ] || { cat "$OUT" "$ERR"; die "fresh install failed"; }; }
# The app has run: it wrote its database (with a WAL beside it), a draft and a public file.
app_has_run() {
  mkdir -p "$DATA/drafts/u1" "$DATA/public/t1"
  printf 'SQLite format 3\0(the live database)\n' >"$DATA/db.sqlite"
  printf 'not yet in the main file\n' >"$DATA/db.sqlite-wal"
  echo draft >"$DATA/drafts/u1/step-001.png"
  echo published >"$DATA/public/t1/step-001.png"
}
setup_code() { sed -n 's/^SETUP_CODE=//p' "$SETTINGS"; }
# The setup code appears nowhere in what the run printed or in any stand-in's command line.
code_not_shown() { local c; c="$(setup_code)"; [ -n "$c" ] && ! grep -qF -- "$c" "$OUT" "$ERR" "$LOG"; }
backup_dirs() { find "$BACKUPS" -mindepth 1 -maxdepth 1 2>/dev/null | sort; }
only_backup() { [ "$(backup_dirs | wc -l | tr -d ' ')" = 1 ] || die "expected exactly one backup folder, got: $(backup_dirs | tr '\n' ' ')"; backup_dirs; }
# Every path under the home folder with its type, and every file's checksum.
snapshot() { (cd "$H" && find . | sort && find . -type f -exec sha256sum {} + | sort); }
# The stand-in calls, by program name, in the order they were made.
calls() { sed 's/[[ ].*//' "$LOG" | tr '\n' ' '; }

die() { printf '      %s\n' "$*"; exit 1; }
skip() { printf '      SKIP: %s\n' "$*"; exit 77; }
expect() { local msg="$1"; shift; "$@" || die "$msg"; }
has() { grep -qF -- "$2" "$1"; }
hasnt() { ! grep -qF -- "$2" "$1"; }

# Runs one test in its own shell, leaving its output and exit code in files. The tests
# share nothing (each makes its own sandbox), so several run at a time.
start_test() {
  local name="$1" rc=0
  ( set -e; "$name" ) >"$WORK/out.$name" 2>&1 || rc=$?
  echo "$rc" >"$WORK/rc.$name"
}

report_test() {
  local name="$1" rc
  rc="$(cat "$WORK/rc.$name" 2>/dev/null || echo 1)"
  if [ "$rc" = 0 ]; then
    PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$name"
  elif [ "$rc" = 77 ]; then
    SKIPS=$((SKIPS + 1)); printf 'SKIP  %s\n' "$name"; grep 'SKIP:' "$WORK/out.$name" || true
  else
    FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$name"; sed 's/^/      /' "$WORK/out.$name" | tail -n 25
  fi
  # A skipped check inside a test that otherwise ran is shown too.
  if [ "$rc" = 0 ]; then grep 'SKIP:' "$WORK/out.$name" || true; fi
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
             "install --domain tours.example.com --app-root public_html/tours" "install --domain tours.example.com --app-root public_html" \
             "install --domain tours.example.com --app-root www/tours" "install --domain tours.example.com --app-root apps/tours/" \
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
  expect "create, then packages, then restart, then health" test "$(calls)" = "cloudlinux-selector npm touch curl "
  expect "the domain and Node version are remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "the Node version is remembered" grep -qxF "NODE=24" "$APP/.cpanel-install"
  expect "the state file holds no setup code" hasnt "$APP/.cpanel-install" "$(setup_code)"
  expect "says where the settings file is" has "$OUT" "The settings file is $SETTINGS"
  expect "says the setup code is inside it" has "$OUT" "The setup code is inside it"
  expect "names the setup address" has "$OUT" "https://$DOMAIN/setup"
  expect "reports health as ok" has "$OUT" "health: ok"
  expect "no backup is made by install" test ! -e "$BACKUPS"
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
  # What the steps done by hand leave: no VERSION and no state file.
  mkdir -p "$APP/dist/node"; echo "// by hand" >"$APP/dist/node/entry.js"
  cpanel "" install --domain "$DOMAIN" --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "points to update" has "$ERR" "update"
  expect "no stand-in was called" test ! -s "$LOG"
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
    expect "$mode: no file was copied" test ! -e "$APP/dist"
    expect "$mode: no settings file was written" test ! -e "$SETTINGS"
    expect "$mode: nothing ran after the refusal" test "$(calls)" = "cloudlinux-selector "
  done
}

test_install_without_the_hosting_command() {
  new_sandbox
  rm "$T/bin/cloudlinux-selector"
  command -v cloudlinux-selector >/dev/null 2>&1 && skip "this system has a real cloudlinux-selector"
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
  expect "asked three times" test "$(grep -c '^curl ' "$LOG")" = 3
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
  mkdir -p "$H/sites/demo-data"; printf 'SQLite format 3\0\n' >"$H/sites/demo-data/db.sqlite"
  : >"$LOG"
  CPANEL_TEST_NO_SQLITE3=1 cpanel "" backup --app-root sites/demo
  expect "backup succeeds" test "$RC" = 0
  expect "the backup is named after the app" test "$(find "$BACKUPS" -maxdepth 1 -name "demo-*" | wc -l | tr -d " ")" = 1
  expect "node runs in the remembered environment" grep -qF "node[venv=sites/demo/22]" "$LOG"
  cpanel "" status
  expect "status of the default folder: nothing installed" has "$ERR" "nothing is installed"
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
  expect "update: shows the move" has "$OUT" "would move dist to dist.old and migrations to migrations.old"
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
  data_sum="$(cd "$DATA" && find . -type f -exec sha256sum {} + | sort | sha256sum)"
  : >"$LOG"
  cpanel_in "$T/new" "" update --yes
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "backup, then packages, then restart, then health" test "$(calls)" = "sqlite3 npm touch curl "
  local b; b="$(only_backup)"
  expect "the backup holds the version from before the update" test "$(tar -xzOf "$b/app.tgz" VERSION)" = 0.1.1
  expect "the backup holds the build from before the update" test "$(tar -xzOf "$b/app.tgz" dist/node/entry.js)" = "// build 0.1.1"
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
  expect "the data folder is untouched" test "$(cd "$DATA" && find . -type f -exec sha256sum {} + | sort | sha256sum)" = "$data_sum"
  expect "the domain is still remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  expect "says it is updated" has "$OUT" "Updated to version 0.2.0"
  expect "no rollback steps after a good update" hasnt "$OUT" "To go back"
}

test_update_replaces_older_old_copies() {
  new_sandbox
  fresh_install
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
  for how in STUB_SQLITE_FAIL STUB_SQLITE_WRITES_NOTHING; do
    new_sandbox
    fresh_install
    app_has_run
    make_release "$T/new" 0.2.0
    local before; before="$(cd "$APP" && find . | sort && find . -type f -exec sha256sum {} + | sort)"
    : >"$LOG"
    export "$how=1"
    cpanel_in "$T/new" "" update --yes
    unset "$how"
    expect "$how: exit code non-zero" test "$RC" != 0
    expect "$how: says the backup failed and nothing changed" has "$ERR" "the backup failed, so the update did not start; nothing was changed"
    expect "$how: the app folder is unchanged" test "$(cd "$APP" && find . | sort && find . -type f -exec sha256sum {} + | sort)" = "$before"
    expect "$how: no dist.old was made" test ! -e "$APP/dist.old"
    expect "$how: nothing ran after the failed backup" test "$(calls)" = "sqlite3 "
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
  local line
  for line in "cd $APP" "rm -rf dist && mv dist.old dist" "rm -rf migrations && mv migrations.old migrations" \
              "tar -xzf $b/app.tgz package.json package-lock.json app.cjs cpanel.sh VERSION" \
              "source $H/nodevenv/apps/tours/24/bin/activate && npm ci --omit=dev --ignore-scripts" \
              "touch $APP/tmp/restart.txt"; do
    expect "prints the rollback command: $line" grep -qxF "    $line" "$OUT"
  done
  expect "says nothing was rolled back" has "$OUT" "Nothing was rolled back for you"
  expect "it did not roll back by itself: the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.2.0"
  expect "it did not roll back by itself: dist.old is still there" test "$(cat "$APP/dist.old/node/entry.js")" = "// build 0.1.1"
  expect "the setup code is not shown" code_not_shown

  # The printed commands, run as printed, bring the previous version back.
  ( cd "$APP" && rm -rf dist && mv dist.old dist && rm -rf migrations && mv migrations.old migrations \
      && tar -xzf "$b/app.tgz" package.json package-lock.json app.cjs cpanel.sh VERSION )
  expect "after the commands: the previous build" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  expect "after the commands: the previous migrations" test "$(cat "$APP/migrations/0001_init.sql")" = "-- schema of 0.1.1"
  expect "after the commands: the previous version" test "$(cat "$APP/VERSION")" = 0.1.1
  expect "after the commands: the previous package.json" cmp -s "$REL/package.json" "$APP/package.json"
  expect "after the commands: no .old copy is left" test ! -e "$APP/dist.old" -a ! -e "$APP/migrations.old"
}

test_update_reports_failed_packages_with_rollback_commands() {
  new_sandbox
  fresh_install
  make_release "$T/new" 0.2.0
  : >"$LOG"
  STUB_NPM_FAIL=1 cpanel_in "$T/new" "" update --yes
  expect "exit code non-zero" test "$RC" != 0
  expect "says what failed" has "$ERR" "installing the packages failed"
  expect "prints the rollback commands" has "$OUT" "rm -rf dist && mv dist.old dist"
  expect "the app was not restarted" test "$(calls)" = "npm "
}

test_update_must_run_from_a_new_archive() {
  new_sandbox
  fresh_install
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
  # What the steps done by hand leave: the files, the settings and the Node.js
  # environment, but no VERSION file and no state file.
  make_release "$T/hand" 0.1.0
  mkdir -p "$APP" "$DATA" "$H/nodevenv/apps/tours/24/bin"
  cp -R "$T/hand/dist" "$T/hand/migrations" "$T/hand/package.json" "$T/hand/package-lock.json" "$T/hand/app.cjs" "$APP/"
  echo 'export STUB_VENV=apps/tours/24' >"$H/nodevenv/apps/tours/24/bin/activate"
  printf 'DATA_DIR=%s\nSETUP_CODE=a-code-made-by-hand-0123456789\n' "$DATA" >"$SETTINGS"
  app_has_run
  # An older archive is still refused: the version is read from package.json.
  make_release "$T/older" 0.0.9
  cpanel_in "$T/older" "" update --yes --domain "$DOMAIN"
  expect "a downgrade of a hand-made install is refused" has "$ERR" "older than the installed 0.1.0"
  # Without a domain the update goes through but cannot vouch for the result.
  cpanel "" update --yes
  expect "no domain: exit code non-zero" test "$RC" != 0
  expect "no domain: the check is reported as not made" has "$OUT" "health: NOT CHECKED"
  expect "no domain: says how to give it" has "$OUT" "--domain <name>"
  expect "no domain: does not claim success" hasnt "$OUT" "Updated to version"
  expect "no domain: curl was never called" test "$(grep -c '^curl ' "$LOG")" = 0
  expect "no domain: the new build is in place" test "$(cat "$APP/dist/node/entry.js")" = "// build 0.1.1"
  # The rollback commands remove what the hand-made install never had.
  expect "rollback removes the files that were not there before" grep -qxF "    rm -f cpanel.sh VERSION" "$OUT"
  expect "rollback restores the files that were" grep -qE "^    tar -xzf .*/app.tgz package.json package-lock.json app.cjs$" "$OUT"
  # With the domain given once, it is remembered.
  make_release "$T/new" 0.2.0
  cpanel_in "$T/new" "" update --yes --domain "$DOMAIN"
  expect "with --domain: succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  expect "with --domain: remembered" grep -qxF "DOMAIN=$DOMAIN" "$APP/.cpanel-install"
  cpanel "" status
  expect "status uses the remembered domain" has "$OUT" "health: ok"
  expect "the hand-made settings file is untouched" grep -qxF "SETUP_CODE=a-code-made-by-hand-0123456789" "$SETTINGS"
  expect "the hand-made code is never shown" hasnt "$OUT" "a-code-made-by-hand"
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
  expect "the database is copied by sqlite3's own backup" grep -qxF "sqlite3 $DATA/db.sqlite .backup '$b.partial/db.sqlite'" "$LOG"
  expect "the copy is what sqlite3 wrote, not a file copy of the live database" grep -qa "stand-in copy by sqlite3" "$b/db.sqlite"
  expect "the live WAL file is not copied beside it" test ! -e "$b/db.sqlite-wal"
  expect "drafts are copied" cmp -s "$DATA/drafts/u1/step-001.png" "$b/drafts/u1/step-001.png"
  expect "public files are copied" cmp -s "$DATA/public/t1/step-001.png" "$b/public/t1/step-001.png"
  expect "the app files are archived" test "$(tar -tzf "$b/app.tgz" | grep -cxE 'dist/node/entry.js|migrations/0001_init.sql|package.json|package-lock.json|app.cjs|cpanel.sh|VERSION|.cpanel-install')" = 8
  expect "node_modules is not archived" test "$(tar -tzf "$b/app.tgz" | grep -c node_modules)" = 0
  expect "the app archive holds no settings" test "$(tar -xzOf "$b/app.tgz" | grep -cF -- "$(setup_code)")" = 0
  expect "the settings file is in the backup" cmp -s "$SETTINGS" "$b/tours-config.env"
  expect "the setup code is not shown" code_not_shown
  expect "only the database tool was called" test "$(calls)" = "sqlite3 "
  expect "the live data is untouched" grep -qa "the live database" "$DATA/db.sqlite"
  if [ "$MODES" = 1 ]; then
    expect "the backup folder is mode 700" test "$(mode_of "$b")" = 700
    expect "the settings copy is mode 600" test "$(mode_of "$b/tours-config.env")" = 600
    expect "nothing in the backup is open to others" test -z "$(open_to_others "$b")"
  else
    echo "      SKIP: mode checks (this file system does not keep Unix file modes)"
  fi
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

test_backup_uses_the_apps_node_when_sqlite3_is_missing() {
  new_sandbox
  fresh_install
  app_has_run
  rm "$T/bin/sqlite3"
  : >"$LOG"
  CPANEL_TEST_NO_SQLITE3=1 cpanel "" backup
  expect "exit code 0 (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "node is run inside the app's Node.js environment, with the database and the copy" grep -qxF \
    "node[venv=apps/tours/24] -e <program> $DATA/db.sqlite $b.partial/db.sqlite" "$LOG"
  expect "the copy is what node wrote, not a file copy of the live database" grep -qa "stand-in copy by node" "$b/db.sqlite"
  expect "says why node is used" has "$OUT" "sqlite3 tool is not installed"
  # The program handed to node is SQLite's own consistent copy.
  expect "the program uses node:sqlite" has "$REL/cpanel.sh" 'require("node:sqlite")'
  expect "the program uses VACUUM INTO" has "$REL/cpanel.sh" 'VACUUM INTO ?'
  expect "the script never copies the database file with cp" test "$(grep -cE '^[^#]*\bcp\b[^#]*db\.sqlite' "$REL/cpanel.sh")" = 0
  : >"$LOG"
  STUB_NODE_FAIL=1 CPANEL_TEST_NO_SQLITE3=1 cpanel "" backup
  expect "a failing copy fails the backup" test "$RC" != 0
  expect "says so" has "$ERR" "the backup failed; no backup folder was written"
  expect "no second folder and no half-made one" test "$(backup_dirs)" = "$b"
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
  CPANEL_TEST_NO_SQLITE3=1 cpanel "" backup
  : >"$T/stop"; wait "$holder" || true
  expect "the backup succeeds (stderr: $(cat "$ERR"))" test "$RC" = 0
  local b; b="$(only_backup)"
  expect "the copy is one file, without a WAL of its own" test -f "$b/db.sqlite" -a ! -e "$b/db.sqlite-wal"
  expect "the copy holds the row that was only in the WAL" test \
    "$(node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT v FROM t").get().v); db.close();' "$(native "$b/db.sqlite")")" = "only in the WAL"
  [ "$MODES" = 0 ] || expect "the copy is mode 600" test "$(mode_of "$b/db.sqlite")" = 600
}

test_backup_before_the_app_ever_started() {
  new_sandbox
  fresh_install
  : >"$LOG"
  cpanel "" backup
  expect "exit code 0" test "$RC" = 0
  expect "says there is no database yet" has "$OUT" "no database at $DATA/db.sqlite yet"
  expect "no database tool was called" test ! -s "$LOG"
  local b; b="$(only_backup)"
  expect "the app files and settings are still backed up" test -f "$b/app.tgz" -a -f "$b/tours-config.env"
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
  expect "status changes nothing but asks health" test "$(calls)" = "curl "
  expect "the setup code is not shown" code_not_shown

  cpanel "" backup; local first; first="$(only_backup)"
  # A later backup, and a half-made folder that must not be named.
  mkdir -p "$BACKUPS/tours-20991231-235959" "$BACKUPS/tours-20991231-235960.partial" "$BACKUPS/other-20991231-235959"
  cpanel "" status
  expect "the newest whole backup of this app" grep -qE "^    last backup: +$BACKUPS/tours-20991231-235959$" "$OUT"

  STUB_HEALTH=fail CPANEL_HEALTH_TRIES=1 cpanel "" status
  expect "a failed check is reported as failed" has "$OUT" "health: FAILED"
  expect "and not as ok" hasnt "$OUT" "health: ok"

  rm "$SETTINGS"
  cpanel "" status
  expect "a missing settings file is named" has "$OUT" "$SETTINGS is MISSING"
  [ -n "$first" ]
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
  command -v curl >/dev/null 2>&1 && skip "this system has a real curl, which the test must not call"
  cpanel "" status
  expect "reports the check as not made" has "$OUT" "health: NOT CHECKED"
  expect "and not as ok" hasnt "$OUT" "health: ok"
}

# ---------------------------------------------------------------- run

[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }
echo "== cpanel.sh on $(uname -s) with bash ${BASH_VERSION%%(*}"
[ "$MODES" = 1 ] || echo "   file modes are not kept on this file system: mode checks are skipped"
if [ "$#" -gt 0 ]; then TESTS="$*"; else TESTS="$(declare -F | awk '{print $3}' | grep '^test_')"; fi
# JOBS tests at a time (default: one per processor). Starting a program is slow under
# Git Bash on Windows, so there the file takes minutes rather than seconds.
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

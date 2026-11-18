#!/usr/bin/env bash
# Installs and looks after the tour platform on shared cPanel hosting that has "Setup
# Node.js App" (CloudLinux): no root, no Docker. Run it over SSH on the hosting, from
# the folder the archive made by `npm run package:cpanel` was unpacked in.
#
#   ./cpanel.sh install --domain tours.example.com [--app-root apps/tours] [--node 24]
#   ./cpanel.sh update | backup | status          [--app-root apps/tours]
#   options: --yes, --dry-run, and for update: --allow-downgrade
#
# Where things go, for the default --app-root apps/tours (always relative to $HOME):
#   ~/apps/tours             the app: dist/, migrations/, package.json, package-lock.json,
#                            app.cjs, cpanel.sh, VERSION, and .cpanel-install (the
#                            domain, the Node version and whether the install
#                            finished; nothing secret)
#   ~/apps/tours-data        db.sqlite, drafts/, public/ (install writes this path to
#                            the settings file; later commands read it from there)
#   ~/apps/tours-config.env  the settings, DATA_DIR and SETUP_CODE, mode 600. It sits
#                            beside the app folder, outside it and outside the web root.
#   ~/backups/tours-<YYYYMMDD-HHMMSS>   one folder per backup, mode 700
#
# How much of this has run on real hosting: the steps were done by hand on one shared
# cPanel account (the cloudlinux-selector command below, the folders, npm ci inside the
# app's Node environment, the restart file, an update by hand). This script itself has
# only been run against stand-ins for the hosting's commands (deploy/cpanel/test-cpanel.sh).
#
# Safety rules this script keeps:
# - The setup code is made here from /dev/urandom, written only to the settings file and
#   never printed, logged or passed as a command argument. The script tells where the
#   file is; the person reads the code there. Of the settings file, the script reads
#   only the DATA_DIR line.
# - It never removes or overwrites the data folder, the settings file or a backup. An
#   existing settings file or data folder is kept as it is, also by install.
# - update takes a backup first and stops if the backup fails; a backup without the
#   database is a failed backup. The database is copied by SQLite itself and the copy is
#   checked (PRAGMA integrity_check).
# - update stages the new dist and migrations beside the running ones (dist.new,
#   migrations.new) and then renames, back to back: the running ones become dist.old and
#   migrations.old. While that is under way the file .cpanel-update marks it. As long as
#   the marker is there, dist.old and migrations.old are never removed: running update
#   again resumes, with them as the way back. The marker goes only when the restart
#   was asked for. A build that exists only as dist.old counts as such an unfinished
#   update too. An interrupted update (Ctrl-C, a dropped connection) prints the
#   commands to go back.
# - A missing database stops update and backup, with one exception: an app that has
#   never started. That is an install the state file records as not finished
#   (FINISHED=no, until a health check passed), or, where the state file says nothing,
#   a data folder with nothing in it. So a first install that failed part-way is
#   finished with update, and a backup then says it holds no database.
# - update never rolls back by itself: when the new version does not answer, it prints
#   the commands to do so, each safe to paste and to paste twice.
# - The health check asks https://<domain>/healthz, because shared hosting routes by
#   host name and the app does not answer on 127.0.0.1. A check that fails or cannot be
#   made is reported as such, never as success.
# - --dry-run prints what would be done and runs nothing. Steps that replace files ask
#   first unless --yes is given.
#
# Every outside command (cloudlinux-selector, npm, node, sqlite3, curl, and touch for
# the restart file) is found through PATH, so the tests put stand-ins in front.
# CPANEL_HEALTH_TRIES and CPANEL_HEALTH_WAIT (seconds) change how long the health check
# keeps trying; the default is 6 tries, 5 seconds apart.

set -euo pipefail
umask 077
export LC_ALL=C

readonly DEFAULT_APP_ROOT=apps/tours
readonly DEFAULT_NODE=24
readonly STATE_NAME=.cpanel-install
readonly MARKER_NAME=.cpanel-update
# What the archive holds, and so what the app folder is made of.
readonly RELEASE_DIRS="dist migrations"
readonly RELEASE_FILES="package.json package-lock.json app.cjs cpanel.sh VERSION"

# How to run this script again, as it was started: hints the script prints can be typed
# as they are, from the folder the person is in.
case "$0" in
  */*) if [ -x "$0" ]; then SELF="$0"; else SELF="bash $0"; fi ;;
  *) SELF="bash $0" ;;
esac

COMMAND=""
APP_ROOT="$DEFAULT_APP_ROOT"
DOMAIN=""
NODE_MAJOR=""
ASSUME_YES=0
DRY_RUN=0
ALLOW_DOWNGRADE=0

SRC_DIR=""
APP_DIR=""
APP_NAME=""
DATA_DIR=""
DATA_PROBLEM=""
SETTINGS=""
STATE_FILE=""
MARKER=""
BACKUP_ROOT=""
ACTIVATE=""
LAST_BACKUP=""
PARTIAL_BACKUP=""
HEALTH=""
HEALTH_NOTE=""
RESUME=0
STAGED=0
MOVED=0
ROLLBACK_BACKUP=""
ROLLBACK_RESTORE=""
ROLLBACK_REMOVE=""
NODE_ENV_UMASK=022
# Whether the state file records that the install finished: yes, no, or empty when it
# says nothing (an install made by hand or by an earlier version of this script).
STATE_FINISHED=""
# 1 when there is, legitimately, no database to copy yet.
NO_DATABASE=0

# ---------------------------------------------------------------- messages

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: ./cpanel.sh <command> [options]

Commands:
  install     Create the Node.js app, copy the files, write the settings file, install
              the packages, restart and check health. Needs --domain.
  update      Back up, then put this archive's version in place of the installed one.
  backup      Copy the database, the drafts and public folders, the app files and the
              settings file to a new folder under ~/backups.
  status      Show the installed version, the folders, the last backup and the health.

Options:
  --app-root <path>   The app folder, relative to your home folder (default apps/tours).
                      It must be outside the folders the web server serves.
  --domain <name>     The address the app answers on, such as tours.example.com. Needed
                      for install; update remembers it.
  --node <major>      The Node.js version to run on (default 24).
  --yes               Do not ask "continue?" questions.
  --dry-run           Print what would be done and change nothing.
  --allow-downgrade   With update: accept an archive older than the installed version.
USAGE
}

usage_error() { printf 'ERROR: %s\n' "$1" >&2; usage >&2; exit 2; }

# Prints the command, then runs it unless this is a dry run.
run() {
  local q
  printf -v q '%q ' "$@"
  info "\$ ${q% }"
  [ "$DRY_RUN" = 1 ] && return 0
  "$@"
}

# ---------------------------------------------------------------- arguments

parse_args() {
  local seen=0 a want=""
  for a in "$@"; do
    if [ -n "$want" ]; then
      case "$want" in
        --app-root) APP_ROOT="$a" ;;
        --domain) DOMAIN="$a" ;;
        --node) NODE_MAJOR="$a" ;;
      esac
      want=""
      continue
    fi
    case "$a" in
      install | update | backup | status)
        [ "$seen" = 0 ] || usage_error "give only one command"
        COMMAND="$a"; seen=1 ;;
      --app-root | --domain | --node) want="$a" ;;
      --app-root=*) APP_ROOT="${a#*=}" ;;
      --domain=*) DOMAIN="${a#*=}" ;;
      --node=*) NODE_MAJOR="${a#*=}" ;;
      --yes | -y) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $a" ;;
    esac
  done
  [ -z "$want" ] || usage_error "$want needs a value"
  [ -n "$COMMAND" ] || usage_error "give a command: install, update, backup or status"
  valid_app_root "$APP_ROOT" || usage_error "--app-root must be a folder path relative to your home folder, made of letters, digits, dots, hyphens and underscores, and the app folder must be outside the folders the web server serves (public_html, www, or a folder named after a domain): $APP_ROOT"
  [ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || usage_error "--domain must be a host name in lowercase, such as tours.example.com, without https:// and without a path"
  [ -z "$NODE_MAJOR" ] || [[ "$NODE_MAJOR" =~ ^[1-9][0-9]?$ ]] || usage_error "--node must be a major version number, such as 24"
  if [ "$ALLOW_DOWNGRADE" = 1 ] && [ "$COMMAND" != update ]; then usage_error "--allow-downgrade goes only with update"; fi
  if [ "$COMMAND" = install ] && [ -z "$DOMAIN" ]; then usage_error "install needs --domain <name>"; fi
}

# ---------------------------------------------------------------- validation

# A relative path of plain names. No name starts with a dot, so "." and ".." cannot
# appear. The folders a web server serves are refused, because the settings file is
# written beside the app folder and must never be reachable from the web: public_html
# and www, and any path whose first folder has a dot in its name, which is how hosting
# names the web folder of an added domain (example.com, tours.example.com).
valid_app_root() {
  local p="$1"
  [ "${#p}" -le 200 ] || return 1
  [[ "$p" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$ ]] || return 1
  case "${p%%/*}" in
    public_html | www | nodevenv | backups | *.*) return 1 ;;
  esac
}

# A public host name: lowercase labels of letters, digits and inner hyphens, at least
# two labels, an alphabetic (or xn--) top-level label. No IP addresses, no localhost.
valid_domain() {
  local d="$1" label
  local -a labels
  [ "${#d}" -ge 4 ] && [ "${#d}" -le 253 ] || return 1
  [[ "$d" =~ ^[a-z0-9.-]+$ ]] || return 1
  [[ "$d" == *.* && "$d" != .* && "$d" != *. && "$d" != *..* ]] || return 1
  IFS=. read -r -a labels <<<"$d"
  for label in "${labels[@]}"; do
    [ "${#label}" -le 63 ] || return 1
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
  [[ "${labels[${#labels[@]}-1]}" =~ ^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$ ]] || return 1
}

valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# True when version $1 is lower than $2 (both x.y.z).
version_lt() {
  local i
  local -a a b
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((10#${a[i]} < 10#${b[i]})); then return 0; fi
    if ((10#${a[i]} > 10#${b[i]})); then return 1; fi
  done
  return 1
}

# ---------------------------------------------------------------- paths and state

resolve_paths() {
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a folder"
  case "$HOME" in
    /*) ;;
    *) die "HOME must be an absolute path" ;;
  esac
  # The paths below are put inside single quotes in commands this script prints.
  # shellcheck disable=SC1003 # the backslash pattern is meant literally
  case "$HOME" in
    *"'"* | *'"'* | *'\'* | *'$'* | *'`'* | *$'\n'*) die "the home folder's path holds a quote, a backslash, a dollar sign or a line break; this script does not work there" ;;
  esac
  SRC_DIR="$(cd "$(dirname "$0")" && pwd -P)" || die "cannot find the folder this script is in"
  APP_DIR="${HOME%/}/$APP_ROOT"
  APP_NAME="${APP_ROOT##*/}"
  SETTINGS="$APP_DIR-config.env"
  STATE_FILE="$APP_DIR/$STATE_NAME"
  MARKER="$APP_DIR/$MARKER_NAME"
  BACKUP_ROOT="${HOME%/}/backups"
}

# The folder holding the app, as the system resolves it; empty when it does not exist.
app_dir_real() { if [ -d "$APP_DIR" ]; then (cd "$APP_DIR" && pwd -P); fi; }

# An install is there when its build is, or the build an update moved aside, or one of
# the two files this script leaves: an interrupted update must still be found.
installed() {
  [ -f "$APP_DIR/dist/node/entry.js" ] || [ -f "$APP_DIR/dist.old/node/entry.js" ] || [ -f "$STATE_FILE" ] || [ -f "$MARKER" ]
}

# One value from a file of NAME=value lines this script wrote. Never sourced.
value_in() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# Fills in the domain and the Node version from the state file where the command line
# did not give them.
read_state() {
  local v
  if [ -z "$DOMAIN" ]; then
    v="$(value_in "$STATE_FILE" DOMAIN)"
    if [ -n "$v" ] && valid_domain "$v"; then DOMAIN="$v"; fi
  fi
  if [ -z "$NODE_MAJOR" ]; then
    v="$(value_in "$STATE_FILE" NODE)"
    if [[ "$v" =~ ^[1-9][0-9]?$ ]]; then NODE_MAJOR="$v"; fi
  fi
  v="$(value_in "$STATE_FILE" FINISHED)"
  case "$v" in yes | no) STATE_FINISHED="$v" ;; esac
}

set_node_paths() {
  [ -n "$NODE_MAJOR" ] || NODE_MAJOR="$DEFAULT_NODE"
  ACTIVATE="${HOME%/}/nodevenv/$APP_ROOT/$NODE_MAJOR/bin/activate"
}

write_state() {
  if [ "$DRY_RUN" = 1 ]; then info "would write $STATE_FILE (the domain and the Node version; nothing secret)"; return 0; fi
  (
    umask 022
    {
      printf '# Written by cpanel.sh. Nothing secret: the settings are in %s.\n' "$SETTINGS"
      printf 'DOMAIN=%s\n' "$DOMAIN"
      printf 'NODE=%s\n' "$NODE_MAJOR"
      # FINISHED=yes: an install or an update got as far as a passed health check, so
      # the app has run and has a database. FINISHED=no: the first install has not.
      [ -z "$STATE_FINISHED" ] || printf 'FINISHED=%s\n' "$STATE_FINISHED"
    } >"$STATE_FILE.new"
    mv -f -- "$STATE_FILE.new" "$STATE_FILE"
  )
}

# Reads the data folder from the settings file: the DATA_DIR line and no other line.
# Sets DATA_DIR, or DATA_PROBLEM and a non-zero status. The value is taken as app.cjs
# takes it: spaces around the line and one pair of quotes around the value are dropped.
read_data_dir() {
  local v
  DATA_DIR=""
  DATA_PROBLEM=""
  if [ ! -f "$SETTINGS" ]; then DATA_PROBLEM="the settings file $SETTINGS is missing"; return 1; fi
  if [ ! -r "$SETTINGS" ]; then DATA_PROBLEM="the settings file $SETTINGS cannot be read"; return 1; fi
  v="$(sed -n 's/^[[:space:]]*DATA_DIR=//p' "$SETTINGS" | head -n 1 | tr -d '\r')"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  case "$v" in
    /*) DATA_DIR="${v%/}"; [ -n "$DATA_DIR" ] || { DATA_PROBLEM="DATA_DIR in $SETTINGS must not be /"; return 1; } ;;
    "") DATA_PROBLEM="the settings file $SETTINGS has no DATA_DIR= line"; return 1 ;;
    *) DATA_PROBLEM="DATA_DIR in $SETTINGS is not an absolute path"; return 1 ;;
  esac
}

# The data folder of an existing install, with its database. Stops otherwise: a backup
# or an update that cannot find the data must not go on as if there were none.
require_data() {
  read_data_dir || die "$DATA_PROBLEM, so the data folder is not known; nothing was changed. The file must hold a line DATA_DIR=<the data folder's full path>"
  [ -d "$DATA_DIR" ] || die "the data folder $DATA_DIR, named by DATA_DIR in $SETTINGS, does not exist; nothing was changed"
  NO_DATABASE=0
  [ ! -f "$DATA_DIR/db.sqlite" ] || return 0
  # No database. That is as it should be only for an app that has never started: an
  # install this script recorded as not finished, or, where nothing is recorded, a
  # data folder with nothing in it at all.
  if [ "$STATE_FINISHED" = no ] || { [ -z "$STATE_FINISHED" ] && [ -z "$(ls -A -- "$DATA_DIR" 2>/dev/null)" ]; }; then
    NO_DATABASE=1
    return 0
  fi
  die "there is no database at $DATA_DIR/db.sqlite (DATA_DIR is read from $SETTINGS); nothing was changed. This install has run before, so it has a database somewhere: DATA_DIR points at the wrong folder, or the database was moved or removed. Put that right, or restore it from a backup, and try again"
}

# The version in a folder: its VERSION file, or the version line of its package.json
# (an install made by hand has no VERSION file). Prints nothing when neither is usable.
version_in() {
  local v=""
  if [ -f "$1/VERSION" ]; then
    v="$(head -n 1 "$1/VERSION" | tr -d ' \r\n')"
  elif [ -f "$1/package.json" ]; then
    v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1)"
  fi
  if valid_version "$v"; then printf '%s' "$v"; fi
}

# This script runs from an unpacked archive that is whole.
check_source() {
  local f
  for f in $RELEASE_DIRS; do [ -d "$SRC_DIR/$f" ] || die "$SRC_DIR/$f is missing; run this script from the folder the archive was unpacked in"; done
  for f in $RELEASE_FILES; do [ -f "$SRC_DIR/$f" ] || die "$SRC_DIR/$f is missing; run this script from the folder the archive was unpacked in"; done
  [ -f "$SRC_DIR/dist/node/entry.js" ] || die "$SRC_DIR/dist/node/entry.js is missing; the archive is not whole"
  [ -n "$(version_in "$SRC_DIR")" ] || die "$SRC_DIR/VERSION does not hold a version"
  if [ "$SRC_DIR" = "$(app_dir_real)" ]; then
    die "this is the installed copy of the script. Unpack the new archive in a folder of its own and run the cpanel.sh in it"
  fi
}

# ---------------------------------------------------------------- questions

confirm() {
  local answer=""
  # A dry run changes nothing, so there is nothing to ask about.
  [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ] && return 0
  printf '%s [y/N]: ' "$1" >&2
  IFS= read -r answer || true
  [[ "$answer" =~ ^[[:space:]]*[Yy]([Ee][Ss])?[[:space:]]*$ ]]
}

# ---------------------------------------------------------------- the app's Node environment

require_node_env() {
  [ "$DRY_RUN" = 1 ] && return 0
  [ -f "$ACTIVATE" ] || die "the app's Node.js environment was not found at $ACTIVATE. It is made when the Node.js app is created; if the app runs on another Node.js version, give it with --node"
}

# Runs a command in the app folder inside the app's Node.js environment, so that node
# and npm are the ones the app runs on.
in_node_env() {
  local q
  printf -v q '%q ' "$@"
  info "\$ source $ACTIVATE && cd $APP_DIR && ${q% }"
  [ "$DRY_RUN" = 1 ] && return 0
  (
    umask "$NODE_ENV_UMASK"
    set +eu
    # shellcheck source=/dev/null
    . "$ACTIVATE" || exit 1
    cd "$APP_DIR" || exit 1
    "$@"
  )
}

# True when the app's Node.js environment is there and has a node program.
node_env_has_node() {
  [ -f "$ACTIVATE" ] || return 1
  (
    set +eu
    # shellcheck source=/dev/null
    . "$ACTIVATE" >/dev/null 2>&1 || exit 1
    command -v node >/dev/null 2>&1
  )
}

install_packages() {
  local was_link=0
  say "Installing the app's packages (npm ci, without development packages and without install scripts)"
  # Some hosting keeps the app's node_modules as a link into the Node.js environment.
  # Whether npm ci keeps that link has not been confirmed on real hosting, so this is
  # only watched and reported, never changed.
  if [ -L "$APP_DIR/node_modules" ]; then was_link=1; fi
  in_node_env npm ci --omit=dev --ignore-scripts || return 1
  if [ "$was_link" = 1 ] && [ ! -L "$APP_DIR/node_modules" ]; then
    warn "$APP_DIR/node_modules was a link into the Node.js environment before npm ci and is a plain folder now. If cPanel's \"Setup Node.js App\" page complains about it, see the guide's list of things not yet confirmed on real hosting"
  fi
}

restart_app() {
  say "Restarting the app"
  if [ "$DRY_RUN" != 1 ]; then (umask 022; mkdir -p -- "$APP_DIR/tmp"); fi
  run touch "$APP_DIR/tmp/restart.txt"
}

# ---------------------------------------------------------------- health

# Asks the app's health address through the hosting's web server. Sets HEALTH to ok,
# failed or unknown, and HEALTH_NOTE to the reason when it is not ok.
check_health() {
  local tries="${CPANEL_HEALTH_TRIES:-6}" wait="${CPANEL_HEALTH_WAIT:-5}" i=1 reply
  [[ "$tries" =~ ^[1-9][0-9]?$ ]] || tries=6
  [[ "$wait" =~ ^[0-9]{1,3}$ ]] || wait=5
  HEALTH=unknown
  HEALTH_NOTE=""
  if [ -z "$DOMAIN" ]; then
    HEALTH_NOTE="no domain is recorded for this install; add --domain <name> (an update then remembers it)"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    HEALTH_NOTE="the curl tool is not available here; open https://$DOMAIN/healthz in a browser instead"
    return 1
  fi
  HEALTH=failed
  while :; do
    if reply="$(curl -fsS --max-time 20 "https://$DOMAIN/healthz" 2>&1)"; then
      case "$reply" in
        *'"ok":true'*) HEALTH=ok; HEALTH_NOTE=""; return 0 ;;
      esac
      HEALTH_NOTE="https://$DOMAIN/healthz answered, but not with the platform's reply; another site may be answering for this name"
    else
      reply="$(printf '%s\n' "$reply" | tail -n 1)"
      HEALTH_NOTE="https://$DOMAIN/healthz did not answer (${reply:-curl failed})"
    fi
    [ "$i" -lt "$tries" ] || return 1
    i=$((i + 1))
    sleep "$wait"
  done
}

report_health() {
  say "Checking https://${DOMAIN:-<no domain recorded>}/healthz"
  if [ "$DRY_RUN" = 1 ]; then info "would ask the health address with curl"; HEALTH=unknown; HEALTH_NOTE="dry run"; return 0; fi
  if check_health; then
    info "health: ok"
    return 0
  fi
  if [ "$HEALTH" = unknown ]; then info "health: NOT CHECKED. $HEALTH_NOTE"; else info "health: FAILED. $HEALTH_NOTE"; fi
  return 1
}

health_hints() {
  info "Things to look at:"
  info "- the app's log: in cPanel, Setup Node.js App, edit the app and set a log file for it, restart, load the address and read the file"
  info "- the name: $DOMAIN must be a domain or subdomain of this hosting account, and the Node.js app must be set to it"
  info "- the certificate: on a new subdomain the hosting's automatic certificate can take a while; until then curl refuses the address"
  info "Check again at any time with: $SELF status --app-root $APP_ROOT"
}

# ---------------------------------------------------------------- backup

# A consistent copy of a database that may be in use and in WAL mode: SQLite itself
# reads one snapshot and writes the copy (a plain file copy could be torn), and the copy
# is then checked with PRAGMA integrity_check. The app's own Node.js does it; the
# sqlite3 tool is used only where that Node.js is not there.
copy_database() {
  local from="$1" to="$2" check
  if node_env_has_node; then
    info "copying with the app's Node.js (VACUUM INTO), then checking the copy (PRAGMA integrity_check)"
    # shellcheck disable=SC2016 # the program text is for Node, not for the shell
    NODE_ENV_UMASK=077 in_node_env node -e 'const { DatabaseSync } = require("node:sqlite"); const [from, to] = process.argv.slice(1); const db = new DatabaseSync(from, { timeout: 5000 }); try { db.prepare("VACUUM INTO ?").run(to); } finally { db.close(); } const copy = new DatabaseSync(to, { readOnly: true }); let rows; try { rows = copy.prepare("PRAGMA integrity_check").all(); } finally { copy.close(); } if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") { console.error("the copy did not pass the integrity check"); process.exit(1); }' "$from" "$to" || return 1
  elif command -v sqlite3 >/dev/null 2>&1; then
    info "the app's Node.js was not found at $ACTIVATE, so the copy is made with the sqlite3 tool"
    info "\$ sqlite3 $from \".backup '$to'\""
    sqlite3 "$from" ".backup '$to'" || return 1
    info "\$ sqlite3 $to \"PRAGMA integrity_check;\""
    check="$(sqlite3 "$to" "PRAGMA integrity_check;" 2>&1)" || { warn "the integrity check of the copy could not be run"; return 1; }
    [ "$check" = ok ] || { warn "the copy did not pass the integrity check"; return 1; }
  else
    warn "neither the app's Node.js (looked for at $ACTIVATE) nor the sqlite3 tool is available to copy the database safely"
    return 1
  fi
  # Whatever the tool reported, the copy must be there and be a database.
  [ -s "$to" ] || { warn "the database copy was not written"; return 1; }
  [ "$(head -c 15 "$to" | tr -d '\0')" = "SQLite format 3" ] || { warn "the database copy is not a SQLite file"; return 1; }
}

remove_partial_backup() {
  case "$PARTIAL_BACKUP" in
    "$BACKUP_ROOT"/?*.partial) [ ! -d "$PARTIAL_BACKUP" ] || rm -rf -- "$PARTIAL_BACKUP" ;;
  esac
  PARTIAL_BACKUP=""
}

# Writes a backup folder and sets LAST_BACKUP. DATA_DIR is known and holds a database
# (require_data). The folder gets its final name only when every part was copied; a
# half-made one is removed.
do_backup() {
  local ts dest n=1 d f
  local -a members=()
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="$BACKUP_ROOT/$APP_NAME-$ts"
  while [ -e "$dest" ] || [ -e "$dest.partial" ]; do n=$((n + 1)); dest="$BACKUP_ROOT/$APP_NAME-$ts-$n"; done
  say "Backing up to $dest (mode 700)"
  for f in $RELEASE_DIRS $RELEASE_FILES "$STATE_NAME"; do
    if [ -e "$APP_DIR/$f" ]; then members+=("$f"); fi
  done
  # Where the build exists only as the copy an update moved aside, that copy is the
  # app's build and goes into the archive.
  if [ ! -f "$APP_DIR/dist/node/entry.js" ] && [ -e "$APP_DIR/dist.old" ]; then members+=("dist.old"); fi
  if [ ! -e "$APP_DIR/migrations" ] && [ -e "$APP_DIR/migrations.old" ]; then members+=("migrations.old"); fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$NO_DATABASE" = 1 ]; then
      info "there is no database to back up yet: the app has never started"
    else
      info "would copy the database $DATA_DIR/db.sqlite with SQLite itself and check the copy; never a plain file copy"
    fi
    info "would copy $DATA_DIR/drafts and $DATA_DIR/public"
    info "would write app.tgz from $APP_DIR: ${members[*]:-nothing}"
    info "would copy the settings file $SETTINGS (mode 600)"
    LAST_BACKUP="$dest"
    return 0
  fi
  if [ "$NO_DATABASE" != 1 ] && [ ! -f "$DATA_DIR/db.sqlite" ]; then warn "there is no database at $DATA_DIR/db.sqlite"; return 1; fi
  mkdir -p -- "$BACKUP_ROOT" || return 1
  PARTIAL_BACKUP="$dest.partial"
  mkdir -- "$PARTIAL_BACKUP" || { PARTIAL_BACKUP=""; return 1; }
  chmod 700 -- "$PARTIAL_BACKUP" || { remove_partial_backup; return 1; }

  if [ "$NO_DATABASE" = 1 ]; then
    info "there is no database to back up yet: the app has never started, and $DATA_DIR holds no db.sqlite. This backup has no database in it."
  else
    info "the database $DATA_DIR/db.sqlite"
    copy_database "$DATA_DIR/db.sqlite" "$PARTIAL_BACKUP/db.sqlite" || { warn "copying the database failed"; remove_partial_backup; return 1; }
  fi
  for d in drafts public; do
    if [ -d "$DATA_DIR/$d" ]; then
      info "the $d folder"
      cp -R -p -- "$DATA_DIR/$d" "$PARTIAL_BACKUP/$d" || { warn "copying $DATA_DIR/$d failed"; remove_partial_backup; return 1; }
    fi
  done
  if [ "${#members[@]}" -gt 0 ]; then
    info "the app files, as app.tgz: ${members[*]}"
    tar -czf "$PARTIAL_BACKUP/app.tgz" -C "$APP_DIR" -- "${members[@]}" || { warn "archiving the app files failed"; remove_partial_backup; return 1; }
  fi
  info "the settings file (it holds the setup code; kept at mode 600)"
  cp -- "$SETTINGS" "$PARTIAL_BACKUP/$APP_NAME-config.env" || { warn "copying the settings file failed"; remove_partial_backup; return 1; }
  chmod 600 -- "$PARTIAL_BACKUP/$APP_NAME-config.env" || { remove_partial_backup; return 1; }
  # Nothing in the backup is for anyone but this account.
  chmod -R go-rwx -- "$PARTIAL_BACKUP" || { remove_partial_backup; return 1; }
  mv -- "$PARTIAL_BACKUP" "$dest" || { remove_partial_backup; return 1; }
  PARTIAL_BACKUP=""
  LAST_BACKUP="$dest"
  info "Backup written: $dest"
  info "Older backups are never removed, and a backup on the hosting is lost with the hosting: copy it somewhere else."
}

# The newest backup folder of this app, by name; prints nothing when there is none.
last_backup() {
  local d last=""
  for d in "$BACKUP_ROOT/$APP_NAME"-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]*; do
    [ -d "$d" ] || continue
    case "$d" in *.partial) continue ;; esac
    last="$d"
  done
  printf '%s' "$last"
}

# ---------------------------------------------------------------- files

# Only these two names, inside the app folder, hold staged copies; they are this
# script's own and are removed before staging again.
remove_staged() { rm -rf -- "$APP_DIR/dist.new" "$APP_DIR/migrations.new"; }

# Copies this archive's dist and migrations to dist.new and migrations.new in the app
# folder. The running app is not touched by this.
stage_release() {
  local f
  if [ "$DRY_RUN" = 1 ]; then
    info "would copy this archive's dist and migrations to $APP_DIR/dist.new and $APP_DIR/migrations.new"
    return 0
  fi
  (
    umask 022
    mkdir -p -- "$APP_DIR" || exit 1
    rm -rf -- "$APP_DIR/dist.new" "$APP_DIR/migrations.new" || exit 1
    for f in $RELEASE_DIRS; do
      cp -R -- "$SRC_DIR/$f" "$APP_DIR/$f.new" || exit 1
    done
  ) || return 1
  STAGED=1
}

# Copies the archive's single files into the app folder.
copy_release_files() {
  local f
  if [ "$DRY_RUN" = 1 ]; then
    info "would copy into $APP_DIR: $RELEASE_FILES"
    return 0
  fi
  (
    umask 022
    for f in $RELEASE_FILES; do
      cp -f -- "$SRC_DIR/$f" "$APP_DIR/$f" || exit 1
    done
    chmod 755 -- "$APP_DIR/cpanel.sh" || exit 1
  )
}

new_setup_code() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# Creates the settings file and the data folder, each only if it is not there yet. An
# existing settings file decides where the data folder is.
create_settings_and_data() {
  local code tmp
  if [ -e "$SETTINGS" ]; then
    info "the settings file $SETTINGS is already there and is kept as it is, with the setup code it holds"
    read_data_dir || die "$DATA_PROBLEM. The file must hold a line DATA_DIR=<the data folder's full path>; put that right and finish with: $SELF update --yes --app-root $APP_ROOT"
    [ "$DRY_RUN" = 1 ] || chmod 600 -- "$SETTINGS"
  else
    DATA_DIR="$APP_DIR-data"
    if [ "$DRY_RUN" = 1 ]; then
      info "would write the settings file $SETTINGS (mode 600) with DATA_DIR and a new setup code"
    else
      code="$(new_setup_code)"
      [[ "$code" =~ ^[0-9a-f]{64}$ ]] || die "could not make a setup code from /dev/urandom"
      tmp="$SETTINGS.new"
      # printf is part of the shell, so the code is on no command line.
      {
        printf '# Settings of the tour platform in %s. Keep this file private.\n' "$APP_DIR"
        printf 'DATA_DIR=%s\n' "$DATA_DIR"
        printf 'SETUP_CODE=%s\n' "$code"
      } >"$tmp"
      chmod 600 -- "$tmp"
      mv -- "$tmp" "$SETTINGS"
      code=""
      info "wrote the settings file $SETTINGS (mode 600)"
    fi
  fi
  if [ -d "$DATA_DIR" ]; then
    info "the data folder $DATA_DIR is already there and is kept as it is"
  elif [ "$DRY_RUN" = 1 ]; then
    info "would create the data folder $DATA_DIR (mode 700)"
  else
    mkdir -p -- "$DATA_DIR"
    chmod 700 -- "$DATA_DIR"
    info "created the data folder $DATA_DIR (mode 700)"
  fi
}

# ---------------------------------------------------------------- commands

cmd_install() {
  local version out rc=0 f
  if installed; then
    die "$APP_DIR already holds an install (version $(version_in "$APP_DIR" || true)). To put a newer version in its place use: $SELF update --app-root $APP_ROOT"
  fi
  check_source
  set_node_paths
  version="$(version_in "$SRC_DIR")"
  for f in $RELEASE_DIRS; do
    [ ! -e "$APP_DIR/$f" ] || die "$APP_DIR/$f is in the way: part of an earlier attempt. Remove it and run install again"
  done
  if [ "$DRY_RUN" != 1 ]; then
    command -v cloudlinux-selector >/dev/null 2>&1 || die "the cloudlinux-selector command was not found. This script needs hosting with cPanel's \"Setup Node.js App\"; ask your hosting provider whether your plan has it and whether it works over SSH"
  fi

  say "Install version $version"
  info "address:        https://$DOMAIN"
  info "app folder:     $APP_DIR (Node.js $NODE_MAJOR)"
  info "settings file:  $SETTINGS"
  info "data folder:    $APP_DIR-data, unless an existing settings file names another"
  confirm "Create the Node.js app and install?" || die "stopped; nothing was changed"

  say "Creating the Node.js app"
  if [ "$DRY_RUN" = 1 ]; then
    run cloudlinux-selector create --json --interpreter nodejs --version "$NODE_MAJOR" --app-root "$APP_ROOT" --domain "$DOMAIN" --app-uri / --startup-file app.cjs --app-mode production
  else
    info "\$ cloudlinux-selector create --json --interpreter nodejs --version $NODE_MAJOR --app-root $APP_ROOT --domain $DOMAIN --app-uri / --startup-file app.cjs --app-mode production"
    # With the usual umask, as when the command is typed by hand: what it creates (the
    # app folder, the Node.js environment, the web server's settings for the domain)
    # must stay readable by the hosting's web server.
    out="$(umask 022; cloudlinux-selector create --json --interpreter nodejs --version "$NODE_MAJOR" --app-root "$APP_ROOT" --domain "$DOMAIN" --app-uri / --startup-file app.cjs --app-mode production 2>&1)" || rc=$?
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/    | /'
    # The command answers in JSON and can report an error with a zero exit code.
    if [ "$rc" != 0 ] || { printf '%s' "$out" | grep -q '"result"' && ! printf '%s' "$out" | grep -Eq '"result"[[:space:]]*:[[:space:]]*"success"'; }; then
      die "the hosting did not create the Node.js app; no file was copied. If an app for $APP_ROOT or $DOMAIN already exists in cPanel's \"Setup Node.js App\", remove it there (or pick another --app-root) and run install again"
    fi
  fi

  say "Copying the app files to $APP_DIR"
  stage_release || { remove_staged; die "copying the files failed; remove what was copied to $APP_DIR and run install again"; }
  if [ "$DRY_RUN" != 1 ]; then
    for f in $RELEASE_DIRS; do mv -- "$APP_DIR/$f.new" "$APP_DIR/$f"; done
  fi
  copy_release_files || die "copying the files failed; remove what was copied to $APP_DIR and run install again"
  STATE_FINISHED=no
  write_state
  say "Settings file and data folder"
  create_settings_and_data
  require_node_env
  install_packages || die "installing the packages failed. The files are in place, so install is not run again: when the cause is fixed, finish with: $SELF update --yes --app-root $APP_ROOT"
  restart_app || die "could not touch the restart file; restart the app in cPanel's \"Setup Node.js App\""

  if [ "$DRY_RUN" = 1 ]; then
    report_health
    say "Dry run: nothing was changed"
    return 0
  fi
  rc=0
  if report_health; then
    STATE_FINISHED=yes
    write_state
    say "Installed version $version, and it answers at https://$DOMAIN"
  else
    say "Installed version $version, but the health check did not pass"
    health_hints
    rc=1
  fi
  info "The settings file is $SETTINGS (only your account can read it)."
  info "The setup code is inside it, on the line that starts with SETUP_CODE=. It is not shown here on purpose."
  info "Open the file in cPanel's File Manager or in a text editor, then open https://$DOMAIN/setup and enter the code."
  info "Whoever enters the setup code first becomes the owner, so keep it private."
  return "$rc"
}

# The commands that bring the previous version back. Each line stands alone, changes
# into the app folder itself and does nothing when its work is already done, so the
# lines can be pasted one by one, and pasted again.
print_rollback() {
  local cd="cd '$APP_DIR' &&"
  say "To go back to the version that ran before, run these commands"
  info "$cd [ -d dist.old ] && rm -rf dist && mv dist.old dist"
  info "$cd [ -d migrations.old ] && rm -rf migrations && mv migrations.old migrations"
  if [ -n "$ROLLBACK_REMOVE" ]; then info "$cd rm -f $ROLLBACK_REMOVE"; fi
  if [ -n "$ROLLBACK_RESTORE" ] && [ -n "$ROLLBACK_BACKUP" ]; then info "$cd tar -xzf '$ROLLBACK_BACKUP/app.tgz' $ROLLBACK_RESTORE"; fi
  info "$cd source '$ACTIVATE' && npm ci --omit=dev --ignore-scripts"
  info "$cd rm -f $MARKER_NAME && touch tmp/restart.txt"
  info "Nothing was rolled back for you. The backup from before the update is ${ROLLBACK_BACKUP:-not known; look in $BACKUP_ROOT}."
  info "If the new version already changed the database, the old version may not start on it: then also restore db.sqlite from that backup, as the guide's restore steps describe."
}

write_marker() {
  (
    umask 022
    {
      printf '# An update by cpanel.sh was started and has not finished. While this file is\n'
      printf '# here, dist.old and migrations.old are kept: running update again resumes.\n'
      printf 'BACKUP=%s\n' "$ROLLBACK_BACKUP"
      printf 'RESTORE=%s\n' "$ROLLBACK_RESTORE"
      printf 'REMOVE=%s\n' "$ROLLBACK_REMOVE"
    } >"$MARKER.new"
    mv -f -- "$MARKER.new" "$MARKER"
  )
}

# Only names of the archive's own files, in the archive's order.
known_files() {
  local f out=""
  for f in $RELEASE_FILES; do
    case " $1 " in *" $f "*) out="${out:+$out }$f" ;; esac
  done
  printf '%s' "$out"
}

# What the interrupted update recorded about the way back.
read_marker() {
  local b
  b="$(value_in "$MARKER" BACKUP)"
  case "$b" in
    "$BACKUP_ROOT"/?*) if [ -f "$b/app.tgz" ]; then ROLLBACK_BACKUP="$b"; fi ;;
  esac
  ROLLBACK_RESTORE="$(known_files "$(value_in "$MARKER" RESTORE)")"
  ROLLBACK_REMOVE="$(known_files "$(value_in "$MARKER" REMOVE)")"
}

# Puts a staged folder in place. The folder it replaces becomes <name>.old, unless an
# interrupted update already left a <name>.old: that one is the last good copy and is
# kept, and the folder in its place, which that update had begun, is dropped.
swap_dir() {
  local d="$1"
  MOVED=1
  if [ "$RESUME" = 1 ] && [ -e "$APP_DIR/$d.old" ]; then
    rm -rf -- "${APP_DIR:?}/$d" || return 1
  elif [ -e "$APP_DIR/$d" ]; then
    mv -- "$APP_DIR/$d" "$APP_DIR/$d.old" || return 1
  fi
  mv -- "$APP_DIR/$d.new" "$APP_DIR/$d"
}

on_signal() {
  trap - INT TERM HUP
  printf '\n' >&2
  warn "interrupted"
  if [ "$MOVED" = 1 ]; then
    info "The update was cut off after it began to replace the app files."
    info "To finish it, run the update again: it resumes, and keeps dist.old and migrations.old as the way back."
    print_rollback
  elif [ "$STAGED" = 1 ]; then
    remove_staged || true
    info "The app files were not touched; the staged copies were removed."
  elif [ "$COMMAND" = update ] || [ "$COMMAND" = backup ]; then
    info "The app files were not touched."
  fi
  exit 130
}

cmd_update() {
  local old new f
  installed || die "nothing is installed at $APP_DIR. For a first install use: $SELF install --domain <name> --app-root $APP_ROOT"
  check_source
  read_state
  set_node_paths
  [ -n "$DOMAIN" ] || die "the address of this install is not recorded, so the update could not be checked afterwards; nothing was changed. Give it once and it is remembered: $SELF update --domain <name> --app-root $APP_ROOT"
  new="$(version_in "$SRC_DIR")"
  old="$(version_in "$APP_DIR" || true)"
  if [ -n "$old" ] && version_lt "$new" "$old" && [ "$ALLOW_DOWNGRADE" != 1 ]; then
    die "this archive is version $new, older than the installed $old; nothing was changed. An older version may not start on a database a newer one has changed. To do it anyway add --allow-downgrade"
  fi
  require_data
  require_node_env
  # An update is resumed when its marker is there, and also when the build exists only
  # as dist.old: something moved it aside and never put a build back.
  if [ -f "$MARKER" ] || { [ ! -f "$APP_DIR/dist/node/entry.js" ] && [ -f "$APP_DIR/dist.old/node/entry.js" ]; }; then RESUME=1; fi

  say "Update ${old:-an install of unknown version} to $new"
  if [ "$RESUME" = 1 ]; then info "An earlier update was cut off. This run finishes it; dist.old and migrations.old from before it are kept."; fi
  if [ "$NO_DATABASE" = 1 ]; then info "The app has never started, so there is no database to back up yet; the backup holds the files only."; fi
  info "address:        https://$DOMAIN"
  info "app folder:     $APP_DIR (Node.js $NODE_MAJOR)"
  info "data folder:    $DATA_DIR (not touched)"
  info "settings file:  $SETTINGS (not touched)"
  confirm "Back up, replace the app files and restart?" || die "stopped; nothing was changed"

  do_backup || die "the backup failed, so the update did not start; nothing was changed"
  if [ -f "$MARKER" ]; then
    read_marker
  else
    ROLLBACK_BACKUP="$LAST_BACKUP"
    for f in $RELEASE_FILES; do
      if [ -e "$APP_DIR/$f" ]; then ROLLBACK_RESTORE="${ROLLBACK_RESTORE:+$ROLLBACK_RESTORE }$f"; else ROLLBACK_REMOVE="${ROLLBACK_REMOVE:+$ROLLBACK_REMOVE }$f"; fi
    done
  fi

  say "Putting version $new in place"
  stage_release || { remove_staged; die "copying the new files beside the running ones failed; the app files were not touched"; }
  if [ "$DRY_RUN" = 1 ]; then
    info "would write $MARKER, then move dist to dist.old and migrations to migrations.old (replacing copies an earlier, finished update left) and move the new ones in"
    copy_release_files
    write_state
  else
    # From here on an interruption must leave something later runs recognise: the state
    # file and the marker are written before anything is moved.
    write_state
    if [ "$RESUME" != 1 ]; then
      rm -rf -- "$APP_DIR/dist.old" "$APP_DIR/migrations.old" || die "could not remove dist.old and migrations.old of an earlier update; the app files were not touched"
    fi
    if [ ! -f "$MARKER" ]; then
      write_marker || die "could not write $MARKER; the app files were not touched"
    fi
    if ! { swap_dir dist && swap_dir migrations && copy_release_files; }; then
      print_rollback
      die "replacing the app files failed part-way. Run the update again to finish it, or go back with the commands above"
    fi
    info "the previous version is kept as dist.old and migrations.old"
  fi
  if ! install_packages; then
    print_rollback
    die "installing the packages failed; the app was not restarted and may still be running the previous version from memory. Run the update again to finish it, or go back with the commands above"
  fi
  if ! restart_app; then
    print_rollback
    die "could not touch the restart file, so the app was not restarted. Run the update again to finish it, or go back with the commands above"
  fi
  # The new files and their packages are in place and the restart is asked for: the
  # update is no longer under way, and an interruption from here on only stops the check.
  [ "$DRY_RUN" = 1 ] || rm -f -- "$MARKER"
  trap - INT TERM HUP
  if [ "$DRY_RUN" = 1 ]; then
    report_health
    say "Dry run: nothing was changed"
    return 0
  fi
  if report_health; then
    STATE_FINISHED=yes
    write_state
    say "Updated to version $new, and it answers at https://$DOMAIN"
    info "The previous version stays in dist.old and migrations.old until the next update."
    return 0
  fi
  say "Version $new is in place, but the health check did not pass"
  health_hints
  print_rollback
  return 1
}

cmd_backup() {
  installed || die "nothing is installed at $APP_DIR"
  read_state
  set_node_paths
  require_data
  do_backup || die "the backup failed; no backup folder was written"
  if [ "$DRY_RUN" = 1 ]; then say "Dry run: nothing was changed"; fi
}

cmd_status() {
  local version last size
  installed || die "nothing is installed at $APP_DIR"
  read_state
  set_node_paths
  version="$(version_in "$APP_DIR" || true)"
  last="$(last_backup)"
  say "Status"
  info "version:        ${version:-unknown}"
  info "app folder:     $APP_DIR (app root $APP_ROOT, Node.js $NODE_MAJOR)"
  if [ -f "$MARKER" ]; then info "update:         an update was cut off before it finished; run the update again from the unpacked archive to finish it"; fi
  if [ -f "$SETTINGS" ]; then info "settings file:  $SETTINGS"; else info "settings file:  $SETTINGS is MISSING; the app cannot start without it"; fi
  if ! read_data_dir; then
    info "data folder:    NOT KNOWN: $DATA_PROBLEM"
  elif [ -d "$DATA_DIR" ]; then
    size="$(du -sh -- "$DATA_DIR" 2>/dev/null | cut -f1 || true)"
    info "data folder:    $DATA_DIR, ${size:-size unknown}"
    [ -f "$DATA_DIR/db.sqlite" ] || info "database:       none at $DATA_DIR/db.sqlite yet; the app writes it the first time it starts"
  else
    info "data folder:    $DATA_DIR is MISSING"
  fi
  info "last backup:    ${last:-none yet}"
  report_health || true
}

on_exit() { remove_partial_backup; }

main() {
  parse_args "$@"
  resolve_paths
  trap on_exit EXIT
  # An interruption says what state the app files are in, and cleans up after itself.
  trap on_signal INT TERM HUP
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    status) cmd_status ;;
  esac
}

main "$@"

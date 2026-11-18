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
#                            domain and Node version; nothing secret)
#   ~/apps/tours-data        db.sqlite, drafts/, public/
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
#   file is; the person reads the code there.
# - It never removes or overwrites the data folder, the settings file or a backup. An
#   existing settings file or data folder is kept as it is, also by install.
# - update takes a backup first and stops if the backup fails. It keeps the previous
#   dist and migrations as dist.old and migrations.old, and it never rolls back by
#   itself: when the new version does not answer, it prints the commands to do so.
# - The health check asks https://<domain>/healthz, because shared hosting routes by
#   host name and the app does not answer on 127.0.0.1. A check that fails or cannot be
#   made is reported as such, never as success.
# - --dry-run prints what would be done and runs nothing. Steps that replace files ask
#   first unless --yes is given.
#
# Every outside command (cloudlinux-selector, npm, node, sqlite3, curl, and touch for
# the restart file) is found through PATH, so the tests put stand-ins in front.
# CPANEL_HEALTH_TRIES and CPANEL_HEALTH_WAIT (seconds) change how long the health check
# keeps trying; the default is 6 tries, 5 seconds apart. CPANEL_TEST_NO_SQLITE3=1, for
# the tests only, makes the script behave as if the sqlite3 tool were not installed.

set -euo pipefail
umask 077
export LC_ALL=C

readonly DEFAULT_APP_ROOT=apps/tours
readonly DEFAULT_NODE=24
readonly STATE_NAME=.cpanel-install
# What the archive holds besides VERSION, and so what the app folder is made of.
readonly RELEASE_DIRS="dist migrations"
readonly RELEASE_FILES="package.json package-lock.json app.cjs cpanel.sh VERSION"

case "$0" in
  cpanel.sh | */cpanel.sh) SELF="$0" ;;
  *) SELF=./cpanel.sh ;;
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
SETTINGS=""
STATE_FILE=""
BACKUP_ROOT=""
ACTIVATE=""
LAST_BACKUP=""
PARTIAL_BACKUP=""
HEALTH=""
HEALTH_NOTE=""
ROLLBACK_RESTORE=""
ROLLBACK_REMOVE=""
MOVED_DIST=0
MOVED_MIGRATIONS=0

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
  --domain <name>     The address the app answers on, such as tours.example.com. Needed
                      for install; update and status remember it.
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
  valid_app_root "$APP_ROOT" || usage_error "--app-root must be a folder path relative to your home folder, made of letters, digits, dots, hyphens and underscores, and outside public_html: $APP_ROOT"
  [ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || usage_error "--domain must be a host name in lowercase, such as tours.example.com, without https:// and without a path"
  [ -z "$NODE_MAJOR" ] || [[ "$NODE_MAJOR" =~ ^[1-9][0-9]?$ ]] || usage_error "--node must be a major version number, such as 24"
  if [ "$ALLOW_DOWNGRADE" = 1 ] && [ "$COMMAND" != update ]; then usage_error "--allow-downgrade goes only with update"; fi
  if [ "$COMMAND" = install ] && [ -z "$DOMAIN" ]; then usage_error "install needs --domain <name>"; fi
}

# ---------------------------------------------------------------- validation

# A relative path of plain names. No name starts with a dot, so "." and ".." cannot
# appear, and the web root is refused: the settings file is written beside the app
# folder and must never be reachable from the web.
valid_app_root() {
  local p="$1"
  [ "${#p}" -le 200 ] || return 1
  [[ "$p" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$ ]] || return 1
  case "$p" in
    public_html | public_html/* | www | www/* | nodevenv | nodevenv/* | backups | backups/*) return 1 ;;
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
  # The paths below are put inside quotes in commands this script prints and runs.
  # shellcheck disable=SC1003 # the backslash pattern is meant literally
  case "$HOME" in
    *"'"* | *'"'* | *'\'* | *'$'* | *'`'* | *$'\n'*) die "the home folder's path holds a quote, a backslash, a dollar sign or a line break; this script does not work there" ;;
  esac
  SRC_DIR="$(cd "$(dirname "$0")" && pwd -P)" || die "cannot find the folder this script is in"
  APP_DIR="${HOME%/}/$APP_ROOT"
  APP_NAME="${APP_ROOT##*/}"
  DATA_DIR="$APP_DIR-data"
  SETTINGS="$APP_DIR-config.env"
  STATE_FILE="$APP_DIR/$STATE_NAME"
  BACKUP_ROOT="${HOME%/}/backups"
}

# The folder holding the app, as the system resolves it; empty when it does not exist.
app_dir_real() { if [ -d "$APP_DIR" ]; then (cd "$APP_DIR" && pwd -P); fi; }

installed() { [ -f "$APP_DIR/dist/node/entry.js" ] || [ -f "$STATE_FILE" ]; }

# One value from the state file, which holds NAME=value lines. Never sourced.
state_value() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | head -n 1
}

# Fills in the domain and the Node version from the state file where the command line
# did not give them.
read_state() {
  local v
  if [ -z "$DOMAIN" ]; then
    v="$(state_value DOMAIN)"
    if [ -n "$v" ] && valid_domain "$v"; then DOMAIN="$v"; fi
  fi
  if [ -z "$NODE_MAJOR" ]; then
    v="$(state_value NODE)"
    if [[ "$v" =~ ^[1-9][0-9]?$ ]]; then NODE_MAJOR="$v"; fi
  fi
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
    } >"$STATE_FILE.new"
    mv -f -- "$STATE_FILE.new" "$STATE_FILE"
  )
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
    umask 022
    set +eu
    # shellcheck source=/dev/null
    . "$ACTIVATE" || exit 1
    cd "$APP_DIR" || exit 1
    "$@"
  )
}

install_packages() {
  say "Installing the app's packages (npm ci, without development packages and without install scripts)"
  in_node_env npm ci --omit=dev --ignore-scripts
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

have_sqlite3() { [ "${CPANEL_TEST_NO_SQLITE3:-0}" != 1 ] && command -v sqlite3 >/dev/null 2>&1; }

# A consistent copy of a database that may be in use and in WAL mode: SQLite itself
# reads one snapshot and writes the copy. A plain file copy could be torn.
copy_database() {
  local from="$1" to="$2"
  if have_sqlite3; then
    info "\$ sqlite3 $from \".backup '$to'\""
    sqlite3 "$from" ".backup '$to'" || return 1
  else
    info "the sqlite3 tool is not installed, so the copy is made with the app's Node.js (VACUUM INTO)"
    [ -f "$ACTIVATE" ] || { warn "the app's Node.js environment was not found at $ACTIVATE"; return 1; }
    # shellcheck disable=SC2016 # the program text is for Node, not for the shell
    in_node_env node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { timeout: 5000 }); try { db.prepare("VACUUM INTO ?").run(process.argv[2]); } finally { db.close(); }' "$from" "$to" || return 1
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

# Writes a backup folder and sets LAST_BACKUP. The folder gets its final name only when
# every part was copied; a half-made one is removed.
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
  if [ "$DRY_RUN" = 1 ]; then
    info "would copy the database $DATA_DIR/db.sqlite with SQLite's own backup, never a plain file copy"
    info "would copy $DATA_DIR/drafts and $DATA_DIR/public"
    info "would write app.tgz from $APP_DIR: ${members[*]:-nothing}"
    info "would copy the settings file $SETTINGS (mode 600)"
    LAST_BACKUP="$dest"
    return 0
  fi
  mkdir -p -- "$BACKUP_ROOT" || return 1
  PARTIAL_BACKUP="$dest.partial"
  mkdir -- "$PARTIAL_BACKUP" || { PARTIAL_BACKUP=""; return 1; }
  chmod 700 -- "$PARTIAL_BACKUP" || { remove_partial_backup; return 1; }

  if [ -f "$DATA_DIR/db.sqlite" ]; then
    info "the database"
    copy_database "$DATA_DIR/db.sqlite" "$PARTIAL_BACKUP/db.sqlite" || { warn "copying the database failed"; remove_partial_backup; return 1; }
  else
    info "no database at $DATA_DIR/db.sqlite yet (the app writes it the first time it starts)"
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
  if [ -f "$SETTINGS" ]; then
    info "the settings file (it holds the setup code; kept at mode 600)"
    cp -- "$SETTINGS" "$PARTIAL_BACKUP/$APP_NAME-config.env" || { warn "copying the settings file failed"; remove_partial_backup; return 1; }
    chmod 600 -- "$PARTIAL_BACKUP/$APP_NAME-config.env" || { remove_partial_backup; return 1; }
  fi
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

# Copies this archive's files into the app folder. The folders must not be there.
copy_release() {
  local f
  if [ "$DRY_RUN" = 1 ]; then
    info "would copy into $APP_DIR: $RELEASE_DIRS $RELEASE_FILES"
    return 0
  fi
  (
    umask 022
    mkdir -p -- "$APP_DIR" || exit 1
    for f in $RELEASE_DIRS; do
      [ ! -e "$APP_DIR/$f" ] || { warn "$APP_DIR/$f is in the way"; exit 1; }
      cp -R -- "$SRC_DIR/$f" "$APP_DIR/$f" || exit 1
    done
    for f in $RELEASE_FILES; do
      cp -f -- "$SRC_DIR/$f" "$APP_DIR/$f" || exit 1
    done
    chmod 755 -- "$APP_DIR/cpanel.sh" || exit 1
  )
}

new_setup_code() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# Creates the data folder and the settings file, each only if it is not there yet.
create_data_and_settings() {
  local code tmp
  if [ -d "$DATA_DIR" ]; then
    info "the data folder $DATA_DIR is already there and is kept as it is"
  elif [ "$DRY_RUN" = 1 ]; then
    info "would create the data folder $DATA_DIR (mode 700)"
  else
    mkdir -p -- "$DATA_DIR"
    chmod 700 -- "$DATA_DIR"
    info "created the data folder $DATA_DIR (mode 700)"
  fi
  if [ -e "$SETTINGS" ]; then
    info "the settings file $SETTINGS is already there and is kept as it is, with the setup code it holds"
    [ "$DRY_RUN" = 1 ] || chmod 600 -- "$SETTINGS"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "would write the settings file $SETTINGS (mode 600) with DATA_DIR and a new setup code"
    return 0
  fi
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
}

# ---------------------------------------------------------------- commands

cmd_install() {
  local version out rc=0
  if installed; then
    die "$APP_DIR already holds an install (version $(version_in "$APP_DIR" || true)). To put a newer version in its place use: $SELF update --app-root $APP_ROOT"
  fi
  check_source
  set_node_paths
  version="$(version_in "$SRC_DIR")"
  if [ "$DRY_RUN" != 1 ]; then
    command -v cloudlinux-selector >/dev/null 2>&1 || die "the cloudlinux-selector command was not found. This script needs hosting with cPanel's \"Setup Node.js App\"; ask your hosting provider whether your plan has it and whether it works over SSH"
  fi

  say "Install version $version"
  info "address:        https://$DOMAIN"
  info "app folder:     $APP_DIR (Node.js $NODE_MAJOR)"
  info "data folder:    $DATA_DIR"
  info "settings file:  $SETTINGS"
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
  copy_release || die "copying the files failed. $APP_DIR may hold part of them; remove what was copied there and run install again"
  write_state
  say "Data folder and settings file"
  create_data_and_settings
  require_node_env
  install_packages || die "installing the packages failed. The files are in place; when the cause is fixed, finish with: $SELF update --yes --app-root $APP_ROOT"
  restart_app || die "could not touch the restart file; restart the app in cPanel's \"Setup Node.js App\""

  if [ "$DRY_RUN" = 1 ]; then
    report_health
    say "Dry run: nothing was changed"
    return 0
  fi
  if report_health; then
    say "Installed version $version, and it answers at https://$DOMAIN"
  else
    say "Installed version $version, but the health check did not pass"
    health_hints
    rc=1
  fi
  info "The settings file is $SETTINGS (only your account can read it)."
  info "The setup code is inside it, on the line that starts with SETUP_CODE=. It is not shown here on purpose."
  info "Read it in cPanel's File Manager or with a text editor over SSH, then open https://$DOMAIN/setup and enter it."
  info "Whoever enters the setup code first becomes the owner, so keep it private."
  return "$rc"
}

print_rollback() {
  say "To go back to the version that ran before, run these commands"
  info "cd $APP_DIR"
  if [ "$MOVED_DIST" = 1 ]; then info "rm -rf dist && mv dist.old dist"; fi
  if [ "$MOVED_MIGRATIONS" = 1 ]; then info "rm -rf migrations && mv migrations.old migrations"; fi
  if [ -n "$ROLLBACK_REMOVE" ]; then info "rm -f $ROLLBACK_REMOVE"; fi
  if [ -n "$ROLLBACK_RESTORE" ] && [ -n "$LAST_BACKUP" ]; then info "tar -xzf $LAST_BACKUP/app.tgz $ROLLBACK_RESTORE"; fi
  info "source $ACTIVATE && npm ci --omit=dev --ignore-scripts"
  info "touch $APP_DIR/tmp/restart.txt"
  info "Nothing was rolled back for you. The backup from before the update is $LAST_BACKUP."
  info "If the new version already changed the database, the old version may not start on it: then also restore db.sqlite from that backup, as the guide's restore steps describe."
}

# Moves the running dist and migrations aside and copies this archive's files in.
swap_release() {
  local f
  for f in $RELEASE_FILES; do
    if [ -e "$APP_DIR/$f" ]; then ROLLBACK_RESTORE="${ROLLBACK_RESTORE:+$ROLLBACK_RESTORE }$f"; else ROLLBACK_REMOVE="${ROLLBACK_REMOVE:+$ROLLBACK_REMOVE }$f"; fi
  done
  if [ "$DRY_RUN" = 1 ]; then
    info "would remove $APP_DIR/dist.old and $APP_DIR/migrations.old from an earlier update"
    info "would move dist to dist.old and migrations to migrations.old"
    copy_release
    return 0
  fi
  # Only these two names, inside the app folder, are ever removed.
  rm -rf -- "$APP_DIR/dist.old" "$APP_DIR/migrations.old" || return 1
  if [ -e "$APP_DIR/dist" ]; then mv -- "$APP_DIR/dist" "$APP_DIR/dist.old" || return 1; MOVED_DIST=1; fi
  if [ -e "$APP_DIR/migrations" ]; then mv -- "$APP_DIR/migrations" "$APP_DIR/migrations.old" || return 1; MOVED_MIGRATIONS=1; fi
  info "the previous version is kept as dist.old and migrations.old"
  copy_release
}

cmd_update() {
  local old new
  installed || die "nothing is installed at $APP_DIR. For a first install use: $SELF install --domain <name> --app-root $APP_ROOT"
  check_source
  read_state
  set_node_paths
  new="$(version_in "$SRC_DIR")"
  old="$(version_in "$APP_DIR" || true)"
  if [ -n "$old" ] && version_lt "$new" "$old" && [ "$ALLOW_DOWNGRADE" != 1 ]; then
    die "this archive is version $new, older than the installed $old; nothing was changed. An older version may not start on a database a newer one has changed. To do it anyway add --allow-downgrade"
  fi
  require_node_env

  say "Update ${old:-an install of unknown version} to $new"
  info "app folder:     $APP_DIR (Node.js $NODE_MAJOR)"
  info "data folder:    $DATA_DIR (not touched)"
  info "settings file:  $SETTINGS (not touched)"
  if [ -n "$DOMAIN" ]; then info "address:        https://$DOMAIN"; else warn "no domain is recorded, so the health check cannot be made; add --domain <name> once"; fi
  confirm "Back up, replace the app files and restart?" || die "stopped; nothing was changed"

  do_backup || die "the backup failed, so the update did not start; nothing was changed"

  say "Putting version $new in place"
  if ! swap_release; then
    [ "$MOVED_DIST" = 0 ] && [ "$MOVED_MIGRATIONS" = 0 ] || print_rollback
    die "replacing the app files failed part-way"
  fi
  write_state
  if ! install_packages; then
    print_rollback
    die "installing the packages failed; the app was not restarted and may still be running the previous version from memory"
  fi
  if ! restart_app; then
    print_rollback
    die "could not touch the restart file; restart the app in cPanel's \"Setup Node.js App\""
  fi
  if [ "$DRY_RUN" = 1 ]; then
    report_health
    say "Dry run: nothing was changed"
    return 0
  fi
  if report_health; then
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
  if [ -d "$DATA_DIR" ]; then
    size="$(du -sh -- "$DATA_DIR" 2>/dev/null | cut -f1 || true)"
    info "data folder:    $DATA_DIR, ${size:-size unknown}"
  else
    info "data folder:    $DATA_DIR is MISSING"
  fi
  if [ -f "$SETTINGS" ]; then info "settings file:  $SETTINGS"; else info "settings file:  $SETTINGS is MISSING; the app cannot start without it"; fi
  info "last backup:    ${last:-none yet}"
  report_health || true
}

on_exit() { remove_partial_backup; }

main() {
  parse_args "$@"
  resolve_paths
  trap on_exit EXIT
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    status) cmd_status ;;
  esac
}

main "$@"

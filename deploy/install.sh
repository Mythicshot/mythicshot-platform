#!/usr/bin/env bash
# Installs and runs the demo platform on Debian: the app container behind Caddy. In
# direct mode (the default) Caddy gets and renews the HTTPS certificate by itself on
# ports 80 and 443. In tunnel mode (--tunnel) no port is published: a cloudflared
# container connects out to Cloudflare, which ends HTTPS and sends requests down the
# tunnel.
#
#   sudo bash install.sh [install|update|backup|status|uninstall] [--tunnel|--direct]
#                        [--dry-run] [--yes] [--force] [--delete-data]
#
# Pages checked on 2026-11-17 for what this script does:
#   Debian releases (13 "trixie" is stable, 12 "bookworm" is oldstable):
#     https://www.debian.org/releases/
#   Docker Engine on Debian (the apt repository, its key, the sources file, the packages
#   and the unofficial packages that conflict with them):
#     https://docs.docker.com/engine/install/debian/
#   Docker's key fingerprint, 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88: the page
#   above no longer prints it, so it was read on 2026-11-17 from the key served at
#     https://download.docker.com/linux/debian/gpg
#   (fetched over HTTPS with TLS 1.2 or later, user ID "Docker Release (CE deb)").
#   Tunnel mode, checked on 2026-11-17. The token in the TUNNEL_TOKEN variable,
#   --no-autoupdate and --metrics:
#     https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/
#   The Host header reaches the service unchanged unless httpHostHeader is set:
#     https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/
#   Outbound port 7844 and no inbound port:
#     https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
#   What cloudflared 2026.11.1 prints was read from its source and by running the image
#   with no network: "Provided Tunnel token is not valid." for a token it cannot
#   decode, "Register tunnel error from server side" when Cloudflare refuses the
#   registration, "error looking up Cloudflare edge IPs" when it cannot reach Cloudflare;
#   `tunnel --metrics <address> ready` exits 0 only while a connection is up.
#
# Before running it, by hand. Direct mode: point the domain's DNS record at this server
# and open ports 80 and 443 to it. Tunnel mode: create the tunnel in Cloudflare's
# dashboard, copy its token, and give the tunnel a published application for the domain
# with the service URL http://caddy:80. Everything else is done here.
#
# Safety rules this script keeps:
# - It never removes or overwrites the data folder, the .env file or a backup. The one
#   exception is `uninstall --delete-data`, after the exact domain name is typed;
#   --yes does not skip that.
# - The data folder is a new or empty folder outside the system folders, recorded in
#   .env as its resolved path; later runs accept only that folder, and only while it
#   still resolves to itself.
# - Every rm, mv and overwrite goes through guard_path, which resolves the path and
#   refuses an empty path, /, and anything outside the install folder and the recorded
#   data folder (plus Docker's apt key and sources file, while installing Docker).
#   Replaced files are backed up first.
# - Files are written to a temporary file and moved into place. If a run fails, files
#   it replaced are restored and files it created are removed again.
# - The setup code is generated here, written only to .env (mode 600, root), printed
#   once at the end of the run that made it, and never logged or passed as a command
#   argument.
# - The tunnel token is read at a hidden prompt (or from the TUNNEL_TOKEN environment
#   variable), checked for shape only, and written only to .env. It is never printed,
#   never passed as a command argument and never written to the compose file or a
#   backup archive; cloudflared's log lines are masked for it before they are shown.
# - The mode is recorded in .env (DEPLOY_MODE=tunnel; no such line means direct). A run
#   never switches an existing install to the other mode: --tunnel or --direct against
#   the recorded mode is refused, with the steps to do it by hand.
#
# Tests: deploy/test-install.sh (runs this script in Debian containers with Docker
# replaced by a stub). DP_ROOT, for those tests only, prefixes every system path.

set -euo pipefail
umask 077
export LC_ALL=C

readonly APP_UID=1001
readonly PROJECT=demo-platform
readonly LOGICAL_INSTALL_DIR=/opt/demo-platform
readonly DEFAULT_DATA_DIR=/opt/demo-platform/data
readonly DEFAULT_APP_IMAGE=demo-platform:latest
readonly WAIT_SECONDS=120
# up --wait-timeout and up --pull need Compose 2.17 or later; 2.20 leaves a margin.
readonly MIN_COMPOSE=2.20.0
readonly DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# What the tunnel's published application points at: Caddy, by its service name on the
# stack's own network, over plain HTTP.
readonly TUNNEL_SERVICE_URL=http://caddy:80

# A token given in the environment is taken out of it at once: Compose prefers the
# environment over .env, so a leftover value would override the recorded token, and no
# child process needs it.
ENV_TOKEN="${TUNNEL_TOKEN:-}"
unset TUNNEL_TOKEN

case "$0" in
  install.sh | */install.sh) SELF="$0" ;;
  *) SELF=install.sh ;;
esac

DP_ROOT="${DP_ROOT:-}"
case "$DP_ROOT" in
  "") ;;
  /*) DP_ROOT="$(realpath -m -- "$DP_ROOT")"
      [ "$DP_ROOT" != / ] || { echo "ERROR: DP_ROOT must not be /" >&2; exit 1; } ;;
  *) echo "ERROR: DP_ROOT must be an absolute path" >&2; exit 1 ;;
esac

INSTALL_DIR="$DP_ROOT$LOGICAL_INSTALL_DIR"
INSTALL_REAL="$(realpath -m -- "$INSTALL_DIR")"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
CADDY_DIR="$INSTALL_DIR/caddy"
CADDYFILE="$CADDY_DIR/Caddyfile"
BACKUP_DIR="$INSTALL_DIR/backups"
LOCK_FILE="$INSTALL_DIR/.install.lock"
OS_RELEASE="$DP_ROOT/etc/os-release"
KEYRING_DIR="$DP_ROOT/etc/apt/keyrings"
KEYRING="$KEYRING_DIR/docker.asc"
DOCKER_SOURCES="$DP_ROOT/etc/apt/sources.list.d/docker.sources"
DC=(docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE")

COMMAND=install
DRY_RUN=0
ASSUME_YES=0
FORCE=0
DELETE_DATA=0
MODE_FLAG=""  # tunnel or direct, when --tunnel or --direct was given

MODE=""       # direct or tunnel
TOKEN=""      # the tunnel token; never printed
DOMAIN=""
ACME_EMAIL=""
DATA_DIR=""   # the resolved path as the host sees it, without DP_ROOT; stored in .env
DATA_PATH=""  # "$DP_ROOT$DATA_DIR", the path this script works on
IMAGE=""
FIRST_RUN=0
CODE_GENERATED=0
CADDY_CHANGED=0
COMPOSE_CREATED=0
COMMITTED=0
STAGED=""
LAST_BACKUP=""
OS_ID="" OS_VERSION_ID="" OS_CODENAME="" OS_PRETTY=""
TMP_FILES=()
TMP_DIRS=()
REPLACED=()
CREATED=()

# ---------------------------------------------------------------- messages

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: sudo bash install.sh [command] [options]

Commands:
  install     Install or repair the platform (the default). Safe to run again.
  update      Back up, pull newer images and restart. Changes no other file.
  backup      Write a backup archive of the database and files to the backups folder.
  status      Show the containers, the health check and the data folder's size.
  uninstall   Stop and remove the containers. The data folder and backups stay.

Options:
  --tunnel        With install: run behind a Cloudflare Tunnel. No port is published and
                  no certificate is requested; the tunnel token is asked for.
  --direct        With install: publish ports 80 and 443 and get a certificate (the
                  default at the question a first install asks).
  --dry-run       Print every command and file write without doing any.
  --yes           Do not ask "continue?" questions (never skips the data deletion check).
  --force         Try on a system other than Debian 13 or 12.
  --delete-data   With uninstall: also delete the data folder, after you type the domain.
USAGE
}

usage_error() { printf 'ERROR: %s\n' "$1" >&2; usage >&2; exit 2; }

# Prints the command, then runs it unless this is a dry run.
run() {
  local q
  q="$(printf '%q ' "$@")"
  info "\$ ${q% }"
  [ "$DRY_RUN" = 1 ] && return 0
  "$@"
}

# Package installation runs with the usual umask, so installed files are readable.
run_pkg() { ( umask 022; run "$@" ); }

# ---------------------------------------------------------------- arguments

parse_args() {
  local seen=0 a
  for a in "$@"; do
    case "$a" in
      install | update | backup | status | uninstall)
        [ "$seen" = 0 ] || usage_error "give only one command"
        COMMAND="$a"; seen=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      --force) FORCE=1 ;;
      --delete-data) DELETE_DATA=1 ;;
      --tunnel)
        [ "$MODE_FLAG" != direct ] || usage_error "give only one of --tunnel and --direct"
        MODE_FLAG=tunnel ;;
      --direct)
        [ "$MODE_FLAG" != tunnel ] || usage_error "give only one of --tunnel and --direct"
        MODE_FLAG=direct ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $a" ;;
    esac
  done
  if [ "$DELETE_DATA" = 1 ] && [ "$COMMAND" != uninstall ]; then
    usage_error "--delete-data goes only with uninstall"
  fi
  if [ -n "$MODE_FLAG" ] && [ "$COMMAND" != install ]; then
    usage_error "--tunnel and --direct go only with install; the other commands read the mode from .env"
  fi
}

# ---------------------------------------------------------------- validation

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

# A plain address: local part of letters, digits and . _ % + -, then a valid domain.
valid_email() {
  local e="$1" local_part domain
  [ "${#e}" -le 254 ] || return 1
  [[ "$e" == *@* && "$e" != *@*@* ]] || return 1
  local_part="${e%@*}"
  domain="${e#*@}"
  [ "${#local_part}" -ge 1 ] && [ "${#local_part}" -le 64 ] || return 1
  [[ "$local_part" =~ ^[A-Za-z0-9._%+-]+$ ]] || return 1
  [[ "$local_part" != .* && "$local_part" != *. && "$local_part" != *..* ]] || return 1
  valid_domain "$domain"
}

# The shape and place of a data folder (existence is checked by check_new_data_dir):
# an absolute path of plain characters; never /, /var, /home or /opt themselves, nor a
# folder directly inside /, /var or /home; never under /etc, /usr, /root or the other
# system trees; inside the install folder only its data folder.
valid_data_dir() {
  local p="$1" top parent
  [[ "$p" =~ ^(/[A-Za-z0-9._-]+)+$ ]] || return 1
  [ "${#p}" -le 200 ] || return 1
  [[ "$p/" != */./* && "$p/" != */../* ]] || return 1
  if inside "$p" "$LOGICAL_INSTALL_DIR"; then [ "$p" = "$DEFAULT_DATA_DIR" ]; return; fi
  [[ "$LOGICAL_INSTALL_DIR" != "$p"/* ]] || return 1
  top="${p#/}"; top="${top%%/*}"
  case "$top" in
    bin | boot | dev | etc | lib | lib32 | lib64 | libx32 | lost+found | proc | root | run | sbin | sys | tmp | usr) return 1 ;;
  esac
  case "$p" in /var | /home | /opt) return 1 ;; esac
  parent="${p%/*}"
  case "$parent" in "" | /var | /home) return 1 ;; esac
  case "$p" in
    /var/log | /var/log/* | /var/cache | /var/cache/* | /var/spool | /var/spool/* | /var/mail | /var/mail/* | \
    /var/backups | /var/backups/* | /var/tmp | /var/tmp/* | /var/run | /var/run/* | /var/lock | /var/lock/* | \
    /var/lib/docker | /var/lib/docker/* | /var/lib/containerd | /var/lib/containerd/*) return 1 ;;
  esac
  return 0
}

# A data folder for a first install: valid by shape, and once resolved still valid, and
# either missing or an empty folder (under /opt only a new one). Prints the resolved
# path to record; explains a refusal on stderr. Has no side effects.
check_new_data_dir() {
  local p="$1" real logical
  valid_data_dir "$p" || { warn "$p cannot be the data folder: use a new folder such as /srv/demo-platform, outside the system folders"; return 1; }
  real="$(canon "$DP_ROOT$p")"
  logical="$real"
  if [ -n "$DP_ROOT" ]; then
    [[ "$real" == "$DP_ROOT"/* ]] || { warn "$p resolves outside this system"; return 1; }
    logical="${real#"$DP_ROOT"}"
  fi
  if [ "$logical" != "$p" ]; then
    valid_data_dir "$logical" || { warn "$p resolves to $logical, which cannot be the data folder"; return 1; }
  fi
  if [ -e "$real" ] || [ -L "$real" ]; then
    [ -d "$real" ] || { warn "$logical is a file, not a folder"; return 1; }
    [ "${logical%/*}" != /opt ] || { warn "$logical already exists; directly under /opt only a new folder can be used"; return 1; }
    [ -z "$(ls -A -- "$real")" ] || { warn "$logical already has files in it; use a new or empty folder"; return 1; }
  fi
  printf '%s\n' "$logical"
}

# The shape of a tunnel token: one word of base64 text that starts with eyJ, as the
# base64 form of a JSON object does (cloudflared decodes the token as base64, then as
# JSON). Shape only: whether Cloudflare accepts it shows when cloudflared connects.
valid_token() {
  [ "${#1}" -ge 100 ] && [ "${#1}" -le 2048 ] && [[ "$1" =~ ^eyJ[A-Za-z0-9+/_-]+={0,2}$ ]]
}

# An image reference such as demo-platform:latest or registry.example.com/x/y:1.2.
valid_image() {
  [ "${#1}" -le 255 ] && [[ "$1" =~ ^[a-z0-9][a-z0-9._/:@-]*$ ]]
}

# ---------------------------------------------------------------- the path guard

canon() { realpath -m -- "$1"; }
inside() { [ -n "$2" ] && { [ "$1" = "$2" ] || [[ "$1" == "$2"/* ]]; }; }

# The recorded data folder still resolves to itself: no link anywhere in its path.
data_trusted() {
  [ -n "$DATA_DIR" ] && [ ! -L "$DATA_PATH" ] && [ "$(canon "$DATA_PATH")" = "$DATA_PATH" ]
}

# Refuses (exits) unless the path, resolved, is inside the install folder or the
# recorded data folder (while that resolves to itself), or is one of Docker's two apt
# files.
guard_path() {
  local p="$1" real
  [ -n "$p" ] || die "refusing an empty path"
  [[ "$p" == /* ]] || die "refusing a relative path: $p"
  [[ "$p/" != */./* && "$p/" != */../* ]] || die "refusing a path with . or ..: $p"
  real="$(canon "$p")"
  [ -n "$real" ] && [ "$real" != / ] || die "refusing to touch /"
  if inside "$real" "$INSTALL_REAL"; then return 0; fi
  if data_trusted && inside "$real" "$DATA_PATH"; then return 0; fi
  if [ "$real" = "$(canon "$KEYRING")" ] || [ "$real" = "$(canon "$DOCKER_SOURCES")" ]; then return 0; fi
  die "refusing to touch $p: it is outside $INSTALL_DIR and the data folder"
}

safe_rm_file() {
  guard_path "$1"
  [ ! -d "$1" ] || [ -L "$1" ] || die "refusing to remove a folder: $1"
  rm -f -- "$1"
}

safe_rmdir_empty() { guard_path "$1"; rmdir -- "$1" 2>/dev/null; }

safe_mv() { guard_path "$1"; guard_path "$2"; mv -f -- "$1" "$2"; }

# Hard-links a finished temporary file to a name that must not exist yet: never clobbers.
safe_link_new() { guard_path "$1"; guard_path "$2"; ln -- "$1" "$2"; }

# Empties and removes a temporary folder this run made, entry by entry (no rm -r).
remove_own_tmpdir() {
  local d="$1" e
  [[ "$d" == "$INSTALL_DIR"/.gnupg.?????? ]] || die "refusing to remove $d"
  guard_path "$d"
  [ -d "$d" ] && [ ! -L "$d" ] || return 0
  while IFS= read -r -d '' e; do
    if [ -d "$e" ] && [ ! -L "$e" ]; then safe_rmdir_empty "$e" || true; else safe_rm_file "$e"; fi
  done < <(find "$d" -depth -mindepth 1 -print0)
  safe_rmdir_empty "$d" || warn "could not remove $d"
}

# Undoes what a failed run created: files it made, and folders it made if empty. The
# data folder goes only if empty; while it holds files, .env stays with it.
undo_created() {
  local i p keep_env=0
  for p in ${CREATED[@]+"${CREATED[@]}"}; do
    if [ "$p" = "$DATA_PATH" ] && [ -d "$p" ]; then
      if safe_rmdir_empty "$p"; then printf 'removed %s (created by this failed run)\n' "$p" >&2
      else keep_env=1; printf 'kept %s: it is not empty\n' "$p" >&2; fi
    fi
  done
  for ((i = ${#CREATED[@]} - 1; i >= 0; i--)); do
    p="${CREATED[i]}"
    [ "$p" != "$DATA_PATH" ] || continue
    if [ "$p" = "$ENV_FILE" ] && [ "$keep_env" = 1 ]; then
      printf 'kept %s: the data folder it belongs to is not empty\n' "$p" >&2; continue
    fi
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      if safe_rmdir_empty "$p"; then printf 'removed %s (created by this failed run)\n' "$p" >&2
      else printf 'kept %s: it is not empty\n' "$p" >&2; fi
    elif [ -e "$p" ] || [ -L "$p" ]; then
      safe_rm_file "$p"
      printf 'removed %s (created by this failed run)\n' "$p" >&2
    fi
  done
}

on_exit() {
  local status=$? f
  trap - EXIT
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    if [ -e "$f" ] || [ -L "$f" ]; then safe_rm_file "$f"; fi
  done
  for f in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do remove_own_tmpdir "$f"; done
  if [ "$status" != 0 ] && [ "$DRY_RUN" = 0 ] && [ "${#CREATED[@]}" -gt 0 ]; then undo_created; fi
  exit "$status"
}

# ---------------------------------------------------------------- staged file writes

# Writes stdin to a temporary file (mode, owner root) next to the target, or in the
# folder given as a third argument; sets STAGED.
stage_file() {
  local target="$1" mode="$2" dir="${3:-}"
  [ -n "$dir" ] || dir="$(dirname -- "$target")"
  guard_path "$target"
  STAGED="$(mktemp -- "$dir/.$(basename -- "$target").new.XXXXXX")"
  TMP_FILES+=("$STAGED")
  guard_path "$STAGED"
  cat >"$STAGED"
  chmod "$mode" -- "$STAGED"
  chown 0:0 -- "$STAGED"
}

# Copies a file to <backup dir>/<name>.bak-<timestamp>, never over an existing file.
backup_existing() {
  local f="$1" dest_dir="$2" base n=1
  base="$dest_dir/$(basename -- "$f").bak-$(date +%Y%m%d-%H%M%S)"
  LAST_BACKUP="$base"
  while [ -e "$LAST_BACKUP" ]; do n=$((n + 1)); LAST_BACKUP="$base-$n"; done
  guard_path "$LAST_BACKUP"
  cp -p -- "$f" "$LAST_BACKUP"
}

# Moves STAGED over the target when they differ, backing up the old file first. Sets
# COMMITTED to 1 when the target changed. Never call it in a condition (if, ||, &&):
# that would switch off set -e inside it and hide a failed copy or move.
commit_file() {
  local target="$1" backup_dir="$2" existed=0
  COMMITTED=0
  if [ -e "$target" ] && cmp -s -- "$STAGED" "$target"; then
    info "$target is already up to date"
    safe_rm_file "$STAGED"
    return 0
  fi
  COMMITTED=1
  if [ -e "$target" ]; then
    existed=1
    backup_existing "$target" "$backup_dir"
    info "the old $target differs; saved it as $LAST_BACKUP"
    REPLACED+=("$target|$LAST_BACKUP")
  fi
  info "writing $target"
  safe_mv "$STAGED" "$target"
  # Docker's key and sources file stay even if a later step fails: they are what
  # Docker's page sets up, not files of this install.
  if [ "$existed" = 0 ] && inside "$(canon "$target")" "$INSTALL_REAL"; then CREATED+=("$target"); fi
}

restore_replaced() {
  local entry target bak tmp
  for entry in ${REPLACED[@]+"${REPLACED[@]}"}; do
    target="${entry%%|*}"
    bak="${entry#*|}"
    guard_path "$target"
    guard_path "$bak"
    tmp="$(mktemp -- "$(dirname -- "$target")/.restore.XXXXXX")"
    TMP_FILES+=("$tmp")
    cp -p -- "$bak" "$tmp"
    safe_mv "$tmp" "$target"
    info "restored $target from $bak"
  done
}

# ---------------------------------------------------------------- questions

# Reads one line from the terminal (or stdin when there is none).
read_line() {
  local __out="$1" line
  if [ ! -t 0 ] && { : </dev/tty; } 2>/dev/null; then
    IFS= read -r line </dev/tty || return 1
  else
    IFS= read -r line || return 1
  fi
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf -v "$__out" '%s' "$line"
}

# Reads one line without showing it, and keeps its last word: the token, also when the
# whole install command from the dashboard was pasted.
read_secret() {
  local __out="$1" line
  if [ ! -t 0 ] && { : </dev/tty; } 2>/dev/null; then
    IFS= read -rs line </dev/tty || return 1
  else
    IFS= read -rs line || return 1
  fi
  line="${line%"${line##*[![:space:]]}"}"
  line="${line##*[[:space:]]}"
  printf -v "$__out" '%s' "$line"
}

confirm() {
  local answer
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N]: ' "$1" >&2
  read_line answer || return 1
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

ask_mode() {
  local answer tries
  printf 'How do visitors reach this server?\n' >&2
  printf '  1  Directly: ports 80 and 443 are open to it and it gets its own HTTPS certificate\n' >&2
  printf '  2  Through a Cloudflare Tunnel: no open ports, Cloudflare ends HTTPS\n' >&2
  for tries in 1 2 3; do
    printf 'Choice [1]: ' >&2
    read_line answer || die "no answer given; run the script in a terminal"
    case "${answer,,}" in
      "" | 1 | direct) MODE=direct; return 0 ;;
      2 | tunnel) MODE=tunnel; return 0 ;;
    esac
    warn "answer 1 or 2 (try $tries of 3)"
  done
  die "no valid choice given; nothing was changed"
}

# The token is never echoed: not while it is typed, and not in a refusal.
ask_token() {
  local answer tries
  if [ -n "$ENV_TOKEN" ]; then
    valid_token "$ENV_TOKEN" || die "the TUNNEL_TOKEN environment variable does not hold a tunnel token (one long word starting with eyJ); nothing was changed"
    TOKEN="$ENV_TOKEN"
    info "the tunnel token is taken from the TUNNEL_TOKEN environment variable"
    return 0
  fi
  for tries in 1 2 3; do
    printf 'Tunnel token from the Cloudflare dashboard (what you paste is not shown): ' >&2
    read_secret answer || die "no answer given; run the script in a terminal"
    printf '\n' >&2
    if valid_token "$answer"; then TOKEN="$answer"; return 0; fi
    warn "that is not a tunnel token: paste the long word starting with eyJ, or the install command that ends with it (try $tries of 3)"
  done
  die "no valid tunnel token given; nothing was changed"
}

ask_domain() {
  local answer tries
  for tries in 1 2 3; do
    printf 'Domain name for the platform (for example tours.example.com): ' >&2
    read_line answer || die "no answer given; run the script in a terminal"
    answer="${answer,,}"; answer="${answer%.}"
    if valid_domain "$answer"; then DOMAIN="$answer"; return 0; fi
    warn "that is not a domain name like tours.example.com (try $tries of 3)"
  done
  die "no valid domain name given; nothing was changed"
}

ask_email() {
  local answer tries
  for tries in 1 2 3; do
    printf 'Email for the certificate authority (expiry notices): ' >&2
    read_line answer || die "no answer given; run the script in a terminal"
    if [[ "$answer" == *@* ]]; then answer="${answer%@*}@$(printf '%s' "${answer##*@}" | tr '[:upper:]' '[:lower:]')"; fi
    if valid_email "$answer"; then ACME_EMAIL="$answer"; return 0; fi
    warn "that is not an email address like admin@example.com (try $tries of 3)"
  done
  die "no valid email given; nothing was changed"
}

ask_data_dir() {
  local answer tries resolved
  for tries in 1 2 3; do
    printf 'Data folder, new or empty [%s]: ' "$DEFAULT_DATA_DIR" >&2
    read_line answer || die "no answer given; run the script in a terminal"
    [ -n "$answer" ] || answer="$DEFAULT_DATA_DIR"
    [ "$answer" = / ] || answer="${answer%/}"
    if resolved="$(check_new_data_dir "$answer")"; then DATA_DIR="$resolved"; return 0; fi
    warn "try $tries of 3"
  done
  die "no usable data folder given; nothing was changed"
}

# ---------------------------------------------------------------- system checks

require_root() {
  local uid
  uid="$(id -u)"
  [ "$uid" = 0 ] || die "this needs root. Run it as: sudo bash $SELF $COMMAND"
}

read_os_release() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    value="${line#*=}"
    value="${value#\"}"; value="${value%\"}"
    case "$key" in
      ID) OS_ID="$value" ;;
      VERSION_ID) OS_VERSION_ID="$value" ;;
      VERSION_CODENAME) OS_CODENAME="$value" ;;
      PRETTY_NAME) OS_PRETTY="$value" ;;
    esac
  done <"$OS_RELEASE"
}

check_os() {
  if [ ! -r "$OS_RELEASE" ]; then
    refuse_os "cannot read $OS_RELEASE, so this does not look like Debian"
    return 0
  fi
  read_os_release
  if [ "$OS_ID" = debian ] && [ "$OS_VERSION_ID" = 13 ]; then return 0; fi
  if [ "$OS_ID" = debian ] && [ "$OS_VERSION_ID" = 12 ]; then
    warn "this is Debian 12 (bookworm), the previous stable release. Docker still supports it, so the install goes ahead, but Debian 13 (trixie) is the current stable release and the one this is tested for."
    return 0
  fi
  refuse_os "this system is ${OS_PRETTY:-unknown}; supported are Debian 13 (trixie) and, with a notice, Debian 12 (bookworm)"
}

refuse_os() {
  if [ "$FORCE" = 1 ]; then warn "$1. Going on because of --force."; return 0; fi
  die "$1. Use --force to try anyway."
}

compose_present() { docker compose version >/dev/null 2>&1; }

docker_is_snap() {
  local path
  path="$(command -v docker 2>/dev/null || true)"
  [[ "$path" == /snap/* ]] && return 0
  command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1
}

refuse_snap() {
  if docker_is_snap; then
    die "Docker is installed as a snap. Its confinement keeps it from using folders such as $LOGICAL_INSTALL_DIR, so this script needs Docker's own packages. Remove the snap (snap remove docker; its images and containers go with it) and run this again."
  fi
}

# True when version $1 is at least $2 (dotted numbers; a leading v and suffixes ignored).
version_ge() {
  local i x y
  local -a a b
  IFS=. read -r -a a <<<"${1#v}"
  IFS=. read -r -a b <<<"${2#v}"
  for i in 0 1 2; do
    x="${a[i]:-0}"; x="${x%%[!0-9]*}"; x="${x:-0}"
    y="${b[i]:-0}"; y="${y%%[!0-9]*}"; y="${y:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

# Docker is usable: Compose new enough for the flags used here, and the daemon answers.
check_docker_ready() {
  local v
  v="$(docker compose version --short 2>/dev/null || true)"
  v="${v#v}"
  [ -n "$v" ] || die "could not read the Docker Compose version"
  version_ge "$v" "$MIN_COMPOSE" || die "Docker Compose $v is too old; this needs $MIN_COMPOSE or later. Update Docker from Docker's apt repository (apt-get update && apt-get install docker-compose-plugin) and run this again."
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon does not answer. Start it with: systemctl start docker (see: systemctl status docker), then run this again."
}

# The app image is on this server or can be pulled.
check_image() {
  local digests
  say "Checking the app image $IMAGE"
  if digests="$(docker image inspect --format '{{len .RepoDigests}}' "$IMAGE" 2>/dev/null)"; then
    if [ "$digests" = 0 ]; then info "found; it was loaded on this server by hand, so update will not pull it"; else info "found"; fi
    return 0
  fi
  info "not on this server yet; pulling it"
  if run docker pull "$IMAGE"; then return 0; fi
  die "the app image $IMAGE is not on this server and could not be pulled; nothing was written. To use an image file, load it first with: docker load -i <image file>.tar, then run this again (put APP_IMAGE=<its name> in front if the name differs)."
}

# The stack's own container for a service is running (so it may hold ports 80 and 443).
stack_running() {
  [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ] && compose_present || return 1
  [ -n "$("${DC[@]}" ps -q "$1" 2>/dev/null || true)" ]
}

check_ports() {
  say "Checking that ports 80 and 443 are free"
  if stack_running caddy; then info "the platform's own Caddy is using them; fine"; return 0; fi
  if ! command -v ss >/dev/null 2>&1; then
    warn "could not check port 80 or 443: the ss command (package iproute2) is missing"
    return 0
  fi
  local busy="" unknown=0 out p proto flags
  for p in 80/tcp 443/tcp 443/udp; do
    proto="${p#*/}"
    if [ "$proto" = tcp ]; then flags=-Hltnp; else flags=-Hlunp; fi
    if out="$(ss "$flags" "sport = :${p%/*}" 2>&1)"; then
      [ -z "$out" ] || busy+="  ${proto^^} port ${p%/*}: $out"$'\n'
    else
      unknown=1
      warn "could not check port ${p%/*} (${proto^^}): ${out%%$'\n'*}"
    fi
  done
  if [ -n "$busy" ]; then
    printf '%s' "$busy" >&2
    die "another program is listening on the ports above. Stop it (or move it to other ports) and run this again; nothing was changed."
  fi
  if [ "$unknown" = 1 ]; then
    warn "make sure nothing else listens on ports 80 and 443, or Caddy cannot start"
  else
    info "nothing else listens on ports 80 and 443"
  fi
}

is_private_ipv4() {
  [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]
}

# Warns, never fails: from inside a network the public address cannot always be known.
check_dns() {
  say "Checking that $DOMAIN points at this server"
  local resolved local_ips ip records="" public_v4=0
  resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  local_ips="$(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | sort -u || true)"
  for ip in $resolved; do
    if printf '%s\n' "$local_ips" | grep -qxF -- "$ip"; then
      info "$DOMAIN resolves to $ip, an address of this server"
      return 0
    fi
  done
  for ip in $local_ips; do
    if [[ "$ip" == *:* ]]; then
      [[ "$ip" == fe80:* || "$ip" == fd* || "$ip" == fc* ]] || records+="      $DOMAIN.  AAAA  $ip"$'\n'
    elif ! is_private_ipv4 "$ip"; then
      records+="      $DOMAIN.  A     $ip"$'\n'
      public_v4=1
    fi
  done
  if [ -z "$resolved" ]; then
    warn "$DOMAIN does not resolve yet, so Caddy cannot get its certificate until it does."
  else
    warn "$DOMAIN resolves to $(printf '%s' "$resolved" | tr '\n' ' ')which is not an address of this server. That is fine if this server is behind a router that forwards ports 80 and 443 to it; otherwise fix the record."
  fi
  if [ "$public_v4" = 1 ] || [ -n "$records" ]; then
    printf '    Create this DNS record at your DNS provider:\n%s' "$records" >&2
  else
    printf '    This server has only private addresses (%s), so it is behind a router. Create:\n      %s.  A     <your public IPv4 address>\n    and forward TCP ports 80 and 443 (and UDP 443) on the router to this server.\n' \
      "$(printf '%s' "$local_ips" | tr '\n' ' ' | sed 's/ $//')" "$DOMAIN" >&2
  fi
  info "the install goes on; the certificate is issued as soon as the record works."
}

# ---------------------------------------------------------------- configuration

read_env_file() {
  local line key value have_code=0 mode=""
  TOKEN=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "" | "#"*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      DOMAIN) DOMAIN="$value" ;;
      ACME_EMAIL) ACME_EMAIL="$value" ;;
      DATA_DIR) DATA_DIR="$value" ;;
      APP_IMAGE) IMAGE="$value" ;;
      SETUP_CODE) [ -z "$value" ] || have_code=1 ;;
      DEPLOY_MODE) mode="$value" ;;
      TUNNEL_TOKEN) TOKEN="$value" ;;
    esac
  done <"$ENV_FILE"
  # No DEPLOY_MODE line is direct mode: that is every .env written before tunnel mode
  # existed, and what direct mode still writes.
  case "$mode" in
    "" | direct) MODE=direct ;;
    tunnel) MODE=tunnel ;;
    *) die "$ENV_FILE has a DEPLOY_MODE that is neither direct nor tunnel; fix it by hand, nothing was changed" ;;
  esac
  valid_domain "$DOMAIN" || die "$ENV_FILE has no valid DOMAIN; fix it by hand, nothing was changed"
  if [ "$MODE" = tunnel ]; then
    valid_token "$TOKEN" || die "$ENV_FILE says DEPLOY_MODE=tunnel but has no TUNNEL_TOKEN of the right shape (one long word starting with eyJ); fix it by hand, nothing was changed"
  else
    TOKEN=""
    valid_email "$ACME_EMAIL" || die "$ENV_FILE has no valid ACME_EMAIL; fix it by hand, nothing was changed"
  fi
  valid_data_dir "$DATA_DIR" || die "$ENV_FILE has a DATA_DIR ($DATA_DIR) that cannot be a data folder; nothing was changed"
  valid_image "$IMAGE" || die "$ENV_FILE has no valid APP_IMAGE; fix it by hand, nothing was changed"
  [ "$have_code" = 1 ] || die "$ENV_FILE has no SETUP_CODE; fix it by hand, nothing was changed"
  DATA_PATH="$DP_ROOT$DATA_DIR"
}

# The recorded data folder is still the folder it was: it resolves to itself and is a
# folder. "lenient" also accepts a folder that no longer exists.
check_recorded_data() {
  if [ ! -e "$DATA_PATH" ] && [ ! -L "$DATA_PATH" ]; then
    [ "$1" = lenient ] && return 0
    die "the data folder $DATA_DIR recorded in $ENV_FILE is missing. If it is on a disk that is not mounted, mount it and run this again. To start over with an empty platform, move the settings aside first: mv $LOGICAL_INSTALL_DIR/.env $LOGICAL_INSTALL_DIR/.env.old"
  fi
  if ! data_trusted || [ ! -d "$DATA_PATH" ]; then
    die "the data folder $DATA_DIR recorded in $ENV_FILE is no longer that folder (a link was put in its path, or it is not a folder); nothing was changed"
  fi
}

load_or_ask_config() {
  if [ -f "$ENV_FILE" ]; then
    say "Reading the earlier answers from $ENV_FILE"
    read_env_file
    check_recorded_data strict
    if [ -n "$MODE_FLAG" ] && [ "$MODE_FLAG" != "$MODE" ]; then refuse_mode_switch; fi
    if [ "$MODE" = tunnel ]; then
      info "tunnel mode, domain $DOMAIN, data folder $DATA_DIR, image $IMAGE"
    else
      info "domain $DOMAIN, email $ACME_EMAIL, data folder $DATA_DIR, image $IMAGE"
    fi
    refuse_other_modes_stack
    return 0
  fi
  FIRST_RUN=1
  say "A few questions"
  if [ -n "$MODE_FLAG" ]; then MODE="$MODE_FLAG"; else ask_mode; fi
  ask_domain
  if [ "$MODE" = tunnel ]; then ask_token; else ask_email; fi
  ask_data_dir
  DATA_PATH="$DP_ROOT$DATA_DIR"
  IMAGE="${APP_IMAGE:-$DEFAULT_APP_IMAGE}"
  valid_image "$IMAGE" || die "APP_IMAGE is not a valid image name"
}

# An existing install is never switched to the other mode by a flag: the two modes
# differ in what is open to the internet, so the change is made by hand, step by step.
refuse_mode_switch() {
  local env="$LOGICAL_INSTALL_DIR/.env"
  if [ "$MODE" = direct ]; then
    die "this install is in direct mode (ports 80 and 443, its own certificate), recorded in $env; --tunnel does not switch it. Nothing was changed. To switch by hand, keeping the data and the setup code: 1. stop it: sudo bash $SELF uninstall  2. as root, add two lines to $env with an editor: DEPLOY_MODE=tunnel and TUNNEL_TOKEN=<the tunnel token>  3. start it: sudo bash $SELF install  4. close ports 80 and 443 on the firewall or router. The runbook's section on switching routes has the details."
  fi
  die "this install is in tunnel mode (behind a Cloudflare Tunnel), recorded in $env; --direct does not switch it. Nothing was changed. To switch by hand, keeping the data and the setup code: 1. stop it: sudo bash $SELF uninstall  2. as root, edit $env: remove the DEPLOY_MODE and TUNNEL_TOKEN lines and add ACME_EMAIL=<your email>  3. point the DNS record at this server and open ports 80 and 443  4. start it: sudo bash $SELF install. The runbook's section on switching routes has the details."
}

# The mode of the stack file on disk: tunnel when it has a cloudflared service.
stack_file_mode() {
  if grep -q '^  cloudflared:' "$COMPOSE_FILE" 2>/dev/null; then echo tunnel; else echo direct; fi
}

# After .env was edited to the other mode: the stack written for the old mode must be
# stopped first, so its Caddy does not pass for this mode's (it may hold ports 80 and
# 443, or none) and a failed start has a consistent setup to go back to.
refuse_other_modes_stack() {
  [ -f "$COMPOSE_FILE" ] && compose_present || return 0
  local was
  was="$(stack_file_mode)"
  [ "$was" != "$MODE" ] || return 0
  # Asked of Docker by the project's label, not through the old stack file, which may
  # no longer read with the edited .env.
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)" ] || return 0
  die "$LOGICAL_INSTALL_DIR/.env now says $MODE mode, but the running stack was written for $was mode. Nothing was changed. Put .env back as it was, stop the stack with: sudo bash $SELF uninstall (the data, .env and the backups stay), make the edit again, and then run install."
}

require_installed() {
  [ -f "$ENV_FILE" ] || die "the platform is not installed here ($ENV_FILE is missing). Run: sudo bash $SELF install"
  read_env_file
  [ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE is missing. Run: sudo bash $SELF install"
}

# Holds a lock for the rest of the run, so two runs cannot interleave.
take_lock() {
  [ "$DRY_RUN" = 0 ] && [ -d "$INSTALL_DIR" ] || return 0
  command -v flock >/dev/null 2>&1 || return 0
  [ -e "$LOCK_FILE" ] || CREATED+=("$LOCK_FILE")
  exec 9>>"$LOCK_FILE"
  flock -n 9 || die "another run of this script is in progress"
}

new_setup_code() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# ---------------------------------------------------------------- install steps

make_dir() { # path mode uid
  local path="$1" mode="$2" owner="$3"
  if [ -d "$path" ]; then info "$path exists; left as it is"; return 0; fi
  [ ! -e "$path" ] || die "$path exists and is not a folder"
  guard_path "$path"
  run install -d -m "$mode" -o "$owner" -g "$owner" -- "$path"
  [ "$DRY_RUN" = 1 ] || CREATED+=("$path")
}

create_folders() {
  say "Creating $LOGICAL_INSTALL_DIR (root only) and the data folder $DATA_DIR (owned by id $APP_UID, private)"
  make_dir "$INSTALL_DIR" 0700 0
  make_dir "$CADDY_DIR" 0700 0
  make_dir "$BACKUP_DIR" 0700 0
  if [ "$FIRST_RUN" = 1 ] && [ -d "$DATA_PATH" ]; then
    # Checked empty by check_new_data_dir: it becomes the app's folder.
    info "$DATA_DIR is an empty folder; giving it to id $APP_UID with mode 700"
    guard_path "$DATA_PATH"
    run chown "$APP_UID:$APP_UID" -- "$DATA_PATH"
    run chmod 0700 -- "$DATA_PATH"
  elif [ -d "$DATA_PATH" ]; then
    info "$DATA_DIR exists; left as it is"
    local owner
    owner="$(stat -c %u -- "$DATA_PATH")"
    [ "$owner" = "$APP_UID" ] || warn "$DATA_DIR is owned by id $owner, not $APP_UID; the app runs as id $APP_UID and cannot write to it. Find out what changed its owner before starting the platform on it."
  else
    make_dir "$DATA_PATH" 0700 "$APP_UID"
  fi
}

check_conflicting_packages() {
  local pkg found=""
  for pkg in docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc; do
    if dpkg-query -W -f='${db:Status-Abbrev}' "$pkg" 2>/dev/null | grep -q '^ii'; then found+=" $pkg"; fi
  done
  [ -z "$found" ] || die "these packages conflict with Docker's own:$found. Docker's page says to remove them first (apt-get remove$found); this script leaves that to you."
}

# Refuses unless the downloaded key is exactly Docker's: one primary key, fingerprint
# DOCKER_KEY_FPR.
verify_docker_key() {
  local key="$1" home listing pubs first
  home="$(mktemp -d -- "$INSTALL_DIR/.gnupg.XXXXXX")"
  TMP_DIRS+=("$home")
  listing="$(gpg --homedir "$home" --batch --no-tty --quiet --show-keys --with-colons --with-fingerprint -- "$key" 2>/dev/null || true)"
  pubs="$(printf '%s\n' "$listing" | grep -c '^pub:' || true)"
  first="$(printf '%s\n' "$listing" | awk -F: '/^pub:/ {p = 1; next} p && /^fpr:/ {print $10; exit}')"
  if [ "$pubs" != 1 ] || [ "$first" != "$DOCKER_KEY_FPR" ]; then
    die "the key downloaded from download.docker.com has fingerprint ${first:-unknown}, not Docker's $DOCKER_KEY_FPR; nothing was installed"
  fi
  info "the key's fingerprint is Docker's ($DOCKER_KEY_FPR)"
}

install_docker() {
  say "Installing Docker Engine and the Compose plugin from Docker's apt repository"
  export DEBIAN_FRONTEND=noninteractive
  run_pkg apt-get update
  run_pkg apt-get install -y ca-certificates curl gpg
  run_pkg install -m 0755 -d -- "$KEYRING_DIR"
  if [ "$DRY_RUN" = 1 ]; then
    run curl --proto '=https' --tlsv1.2 -fsSL https://download.docker.com/linux/debian/gpg -o "$KEYRING"
    info "would check that the key's fingerprint is $DOCKER_KEY_FPR"
    info "would write $DOCKER_SOURCES for $OS_CODENAME"
  else
    local key arch
    key="$(mktemp -- "$INSTALL_DIR/.docker.asc.XXXXXX")"
    TMP_FILES+=("$key")
    run curl --proto '=https' --tlsv1.2 -fsSL https://download.docker.com/linux/debian/gpg -o "$key"
    verify_docker_key "$key"
    stage_file "$KEYRING" 0644 "$INSTALL_DIR" <"$key"
    commit_file "$KEYRING" "$BACKUP_DIR"
    arch="$(dpkg --print-architecture)"
    [ -n "$OS_CODENAME" ] || die "$OS_RELEASE has no VERSION_CODENAME for Docker's repository"
    stage_file "$DOCKER_SOURCES" 0644 "$INSTALL_DIR" <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $OS_CODENAME
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    commit_file "$DOCKER_SOURCES" "$BACKUP_DIR"
  fi
  run_pkg apt-get update
  run_pkg apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  [ "$DRY_RUN" = 1 ] || compose_present || die "Docker was installed but 'docker compose version' still fails"
}

write_env_file() {
  if [ -e "$ENV_FILE" ]; then
    say "Keeping $ENV_FILE as it is (the setup code does not change)"
    return 0
  fi
  if [ "$MODE" = tunnel ]; then
    say "Writing $ENV_FILE (mode 600, root only) with a new setup code and the tunnel token"
  else
    say "Writing $ENV_FILE (mode 600, root only) with a new setup code"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$MODE" = tunnel ]; then
      info "would write DOMAIN, DEPLOY_MODE, DATA_DIR, APP_IMAGE, a new SETUP_CODE and the TUNNEL_TOKEN to $ENV_FILE"
    else
      info "would write DOMAIN, ACME_EMAIL, DATA_DIR, APP_IMAGE and a new SETUP_CODE to $ENV_FILE"
    fi
    return 0
  fi
  local tmp code
  tmp="$(mktemp -- "$INSTALL_DIR/.env.new.XXXXXX")"
  TMP_FILES+=("$tmp")
  guard_path "$tmp"
  code="$(new_setup_code)"
  [[ "$code" =~ ^[0-9a-f]{32}$ ]] || die "could not read random bytes from /dev/urandom"
  # printf is a shell builtin: neither the code nor the token is on a command line.
  if [ "$MODE" = tunnel ]; then
    valid_token "$TOKEN" || die "no tunnel token to write"
    {
      printf '# Written by install.sh. Root only: SETUP_CODE claims this install and TUNNEL_TOKEN runs its tunnel. Never share or commit.\n'
      printf 'DOMAIN=%s\n' "$DOMAIN"
      printf 'DEPLOY_MODE=tunnel\n'
      printf 'DATA_DIR=%s\n' "$DATA_DIR"
      printf 'APP_IMAGE=%s\n' "$IMAGE"
      printf 'SETUP_CODE=%s\n' "$code"
      printf 'TUNNEL_TOKEN=%s\n' "$TOKEN"
    } >"$tmp"
  else
    {
      printf '# Written by install.sh. Root only: SETUP_CODE claims this install. Never share or commit.\n'
      printf 'DOMAIN=%s\n' "$DOMAIN"
      printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
      printf 'DATA_DIR=%s\n' "$DATA_DIR"
      printf 'APP_IMAGE=%s\n' "$IMAGE"
      printf 'SETUP_CODE=%s\n' "$code"
    } >"$tmp"
  fi
  code=""
  chmod 600 -- "$tmp"
  chown 0:0 -- "$tmp"
  safe_link_new "$tmp" "$ENV_FILE"
  CREATED+=("$ENV_FILE")
  CODE_GENERATED=1
  safe_rm_file "$tmp"
}

install_stack_files() {
  if [ "$MODE" = tunnel ]; then
    say "Writing $COMPOSE_FILE and $CADDYFILE for tunnel mode (no published ports; the domain and the token come from .env)"
  else
    say "Writing $COMPOSE_FILE and $CADDYFILE (the domain and email come from .env)"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    local f
    for f in "$COMPOSE_FILE" "$CADDYFILE"; do
      if [ -e "$f" ]; then info "would compare $f and, if it differs, save it as .bak-<timestamp> and replace it"
      else info "would write $f"; fi
    done
    return 0
  fi
  [ -e "$COMPOSE_FILE" ] || COMPOSE_CREATED=1
  if [ "$MODE" = tunnel ]; then
    stage_file "$COMPOSE_FILE" 0600 < <(tunnel_compose_file_content)
  else
    stage_file "$COMPOSE_FILE" 0600 < <(compose_file_content)
  fi
  local staged_compose="$STAGED"
  run docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$staged_compose" config --quiet \
    || die "the new compose file does not validate; nothing was replaced"
  STAGED="$staged_compose"
  commit_file "$COMPOSE_FILE" "$INSTALL_DIR"
  if [ "$MODE" = tunnel ]; then
    stage_file "$CADDYFILE" 0600 < <(tunnel_caddyfile_content)
  else
    stage_file "$CADDYFILE" 0600 < <(caddyfile_content)
  fi
  commit_file "$CADDYFILE" "$CADDY_DIR"
  CADDY_CHANGED="$COMMITTED"
}

# Shows cloudflared's last log lines, masked for the token, and says in plain words what
# the known ones mean. The messages matched here are cloudflared's own (see the top of
# this file); the text Cloudflare adds after a refused registration is not relied on.
explain_tunnel_failure() {
  local logs
  say "cloudflared's last log lines"
  info "\$ ${DC[*]} logs --no-color --tail 40 cloudflared"
  logs="$("${DC[@]}" logs --no-color --tail 40 cloudflared 2>&1 || true)"
  if [ -n "$TOKEN" ]; then logs="${logs//"$TOKEN"/<tunnel token hidden>}"; fi
  printf '%s\n' "$logs"
  case "$logs" in
    *"Provided Tunnel token is not valid"*)
      warn "cloudflared could not read the token: what was given is not a complete tunnel token. Copy it again from the tunnel's page in Cloudflare's dashboard (the long word starting with eyJ, to its very end)." ;;
    *"Register tunnel error from server side"* | *Unauthorized*)
      warn "Cloudflare refused the tunnel's registration. The token is most likely for a tunnel that was deleted, or was refreshed in the dashboard since it was copied. Copy the current token from the tunnel's page and try again." ;;
    *"error looking up Cloudflare edge IPs"* | *"edge discovery"* | *"network is unreachable"* | *"i/o timeout"*)
      warn "cloudflared could not reach Cloudflare. This server needs outbound access to Cloudflare on port 7844 (TCP and UDP) and working DNS; no inbound port is needed. Check the firewall and try again." ;;
    *)
      warn "the tunnel did not connect within ${WAIT_SECONDS}s; the lines above are cloudflared's own account of why." ;;
  esac
}

start_stack() {
  local caddy_was_running=0
  if stack_running caddy; then caddy_was_running=1; fi
  if [ "$MODE" = tunnel ]; then
    say "Starting the platform: pulling any image not on this server yet, then waiting up to ${WAIT_SECONDS}s for the app to report healthy and the tunnel to connect"
  else
    say "Starting the platform: pulling any image not on this server yet, then waiting up to ${WAIT_SECONDS}s for it to report healthy"
  fi
  # --remove-orphans: a container left by the other mode's stack file (cloudflared after
  # a switch back to direct mode) does not keep running beside this one.
  if ! run "${DC[@]}" up -d --pull missing --wait --wait-timeout "$WAIT_SECONDS" --remove-orphans; then
    warn "the platform did not start"
    if [ "$MODE" = tunnel ]; then explain_tunnel_failure; fi
    if [ "$COMPOSE_CREATED" = 1 ]; then
      say "The app's last log lines"
      run "${DC[@]}" logs --tail 50 app || true
      say "Taking the half-started stack down again"
      run "${DC[@]}" down || warn "could not take the stack down"
      die "starting failed; see the log lines above. The files this run created are removed below."
    fi
    if [ "${#REPLACED[@]}" -gt 0 ]; then
      say "Putting back the files this run replaced and starting the previous setup"
      restore_replaced
      run "${DC[@]}" up -d || warn "the previous setup did not start either"
    fi
    die "starting failed. The data folder, $ENV_FILE and the backups were not changed. See the logs with: ${DC[*]} logs"
  fi
  if [ "$CADDY_CHANGED" = 1 ] && [ "$caddy_was_running" = 1 ]; then
    say "Restarting Caddy so it reads the new Caddyfile"
    run "${DC[@]}" restart caddy
  fi
}

finish() {
  if [ "$DRY_RUN" = 1 ]; then say "Dry run finished: nothing was changed"; return 0; fi
  if [ "$MODE" = tunnel ]; then
    printf '\nThe platform is running and its tunnel is connected to Cloudflare.\n'
    printf "\nIn Cloudflare's dashboard, the tunnel needs one published application (skip this if it is there already):\n"
    printf '  Hostname:     %s\n' "$DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf 'No port is published on this server; it is reached only through the tunnel, at https://%s\n' "$DOMAIN"
  else
    printf '\nThe platform is running at https://%s\n' "$DOMAIN"
  fi
  if [ "$CODE_GENERATED" = 1 ]; then
    local line code=""
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in SETUP_CODE=*) code="${line#SETUP_CODE=}" ;; esac
    done <"$ENV_FILE"
    printf '\n  Open:        https://%s/setup\n' "$DOMAIN"
    printf '  Setup code:  %s\n\n' "$code"
    printf 'This is the only time the code is printed. It is kept in %s (root only). Whoever enters it first becomes the owner; once setup is finished it opens nothing.\n' "$LOGICAL_INSTALL_DIR/.env"
  else
    printf 'The setup code did not change and is not printed again; it is SETUP_CODE in %s (root only).\n' "$LOGICAL_INSTALL_DIR/.env"
  fi
}

cmd_install() {
  say "Installing the demo platform"
  load_or_ask_config
  if [ "$MODE" = tunnel ]; then
    info "Tunnel mode. Do these by hand, in Cloudflare's dashboard: create the tunnel, and give it a published application for $DOMAIN with the service URL $TUNNEL_SERVICE_URL."
  else
    info "Do these by hand first: point the domain's DNS record at this server and open ports 80 and 443 to it."
  fi
  if [ "$FIRST_RUN" = 1 ]; then
    say "About to install"
    info "domain:      $DOMAIN"
    if [ "$MODE" = tunnel ]; then
      info "reached:     through a Cloudflare Tunnel; no port is published"
      info "token:       given (not shown)"
    else
      info "email:       $ACME_EMAIL"
    fi
    info "data folder: $DATA_DIR"
    info "image:       $IMAGE"
    info "folder:      $LOGICAL_INSTALL_DIR"
    confirm "Continue?" || die "cancelled; nothing was changed"
  fi
  say "Checking Docker"
  refuse_snap
  local docker_missing=0
  if compose_present; then
    check_docker_ready
    info "Docker with Compose $(docker compose version --short 2>/dev/null || true) is installed and its daemon answers"
    check_image
  else
    docker_missing=1
    info "Docker with the Compose plugin is not installed yet; it is installed below"
    check_conflicting_packages
  fi
  if [ "$MODE" = tunnel ]; then
    say "Tunnel mode: no port is published, so ports 80 and 443 and the DNS record are not checked"
    info "the DNS record for $DOMAIN belongs to the tunnel and is managed in Cloudflare's dashboard, not here"
  else
    check_ports
    check_dns
  fi
  if [ "$docker_missing" = 1 ]; then
    make_dir "$INSTALL_DIR" 0700 0
    install_docker
    if [ "$DRY_RUN" = 0 ]; then check_docker_ready; check_image; fi
  fi
  create_folders
  take_lock
  write_env_file
  install_stack_files
  start_stack
  finish
}

# ---------------------------------------------------------------- other commands

# Writes backups/demo-platform-<time>.tar.gz (mode 600) from a consistent database copy
# made inside the app container, and the drafts and public folders.
do_backup() {
  local ts copy base archive tmp n=1
  local -a members
  ts="$(date +%Y%m%d-%H%M%S)"
  copy=".backup-$ts.sqlite"
  [ ! -e "$DATA_PATH/$copy" ] || die "$DATA_PATH/$copy already exists; try again in a second"
  make_dir "$BACKUP_DIR" 0700 0
  base="$BACKUP_DIR/demo-platform-$ts"
  archive="$base.tar.gz"
  while [ -e "$archive" ]; do n=$((n + 1)); archive="$base-$n.tar.gz"; done
  say "Making a consistent copy of the database inside the app container"
  TMP_FILES+=("$DATA_PATH/$copy")
  run "${DC[@]}" exec -T app node dist/node/backup.js "/data/$copy" \
    || die "the database copy failed; is the platform running? Check with: sudo bash $SELF status"
  members=("$copy")
  [ ! -d "$DATA_PATH/drafts" ] || members+=(drafts)
  [ ! -d "$DATA_PATH/public" ] || members+=(public)
  say "Writing $archive (mode 600): the database copy and the drafts and public folders"
  if [ "$DRY_RUN" = 1 ]; then
    run tar -czf "$archive" -C "$DATA_PATH" --transform "s|^\\.backup-$ts\\.sqlite\$|db.sqlite|" -- "${members[@]}"
    return 0
  fi
  tmp="$(mktemp -- "$BACKUP_DIR/.partial.XXXXXX")"
  TMP_FILES+=("$tmp")
  run tar -czf "$tmp" -C "$DATA_PATH" --transform "s|^\\.backup-$ts\\.sqlite\$|db.sqlite|" -- "${members[@]}"
  chmod 600 -- "$tmp"
  safe_link_new "$tmp" "$archive"
  safe_rm_file "$tmp"
  say "Removing the temporary database copy from the data folder"
  safe_rm_file "$DATA_PATH/$copy"
  info "Backup written: $archive. Older backups are never removed; copy it off this server."
}

cmd_update() {
  require_installed
  check_recorded_data strict
  refuse_snap
  check_docker_ready
  take_lock
  local digests
  digests="$(docker image inspect --format '{{len .RepoDigests}}' "$IMAGE" 2>/dev/null || true)"
  if [ "$digests" = 0 ] && [ "$MODE" = tunnel ]; then
    say "Pulling newer Caddy and cloudflared images"
    info "APP_IMAGE $IMAGE was loaded on this server by hand, so it is not pulled; load a newer one with docker load before running update"
    run "${DC[@]}" pull caddy cloudflared || die "pulling failed; nothing was changed"
  elif [ "$digests" = 0 ]; then
    say "Pulling a newer Caddy image"
    info "APP_IMAGE $IMAGE was loaded on this server by hand, so it is not pulled; load a newer one with docker load before running update"
    run "${DC[@]}" pull caddy || die "pulling failed; nothing was changed"
  else
    say "Pulling newer images"
    run "${DC[@]}" pull || die "pulling failed; nothing was changed. If APP_IMAGE is an image loaded by hand, load the new one with docker load and run: ${DC[*]} up -d"
  fi
  say "Backing up before restarting"
  do_backup
  say "Restarting on the new images (waiting up to ${WAIT_SECONDS}s for health)"
  if ! run "${DC[@]}" up -d --wait --wait-timeout "$WAIT_SECONDS"; then
    if [ "$MODE" = tunnel ]; then explain_tunnel_failure; fi
    die "the platform did not report healthy. The data folder and $ENV_FILE were not changed, and the backup above holds the state before the update. See: ${DC[*]} logs"
  fi
  say "Updated"
}

cmd_backup() {
  require_installed
  check_recorded_data strict
  take_lock
  do_backup
}

cmd_status() {
  require_installed
  local id
  say "Containers"
  "${DC[@]}" ps || true
  say "Health check of the app"
  id="$("${DC[@]}" ps -q app 2>/dev/null || true)"
  if [ -n "$id" ]; then
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no health check{{end}}' "$id" || true
  else
    info "the app container is not running"
  fi
  if [ "$MODE" = tunnel ]; then
    # healthy means cloudflared holds a connection to Cloudflare.
    say "Health check of the tunnel (cloudflared)"
    id="$("${DC[@]}" ps -q cloudflared 2>/dev/null || true)"
    if [ -n "$id" ]; then
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no health check{{end}}' "$id" || true
      info "healthy means it is connected to Cloudflare. If it is not, see why with: ${DC[*]} logs cloudflared"
    else
      info "the cloudflared container is not running"
    fi
  fi
  say "Data folder"
  if [ -d "$DATA_PATH" ]; then du -sh -- "$DATA_PATH" || true; else warn "$DATA_DIR is missing"; fi
  info "address: https://$DOMAIN"
  if [ "$MODE" = tunnel ]; then
    info "mode: behind a Cloudflare Tunnel; no port is published. The tunnel's published application for $DOMAIN has the service URL $TUNNEL_SERVICE_URL"
  fi
}

# Deletes the data folder only if it is still exactly the folder recorded at install
# time, resolved, outside the system folders, and holds nothing the platform does not
# make.
delete_data_folder() {
  local real logical unexpected=""
  data_trusted || die "refusing: $DATA_DIR no longer resolves to itself (a link in its path?); nothing was deleted"
  [ -d "$DATA_PATH" ] || die "refusing: $DATA_DIR is not a folder; nothing was deleted"
  real="$(canon "$DATA_PATH")"
  logical="${real#"$DP_ROOT"}"
  [ "$DP_ROOT$logical" = "$real" ] && [ "$logical" = "$DATA_DIR" ] || die "refusing: $DATA_DIR resolves to $real; nothing was deleted"
  valid_data_dir "$logical" || die "refusing: $logical cannot be a data folder; nothing was deleted"
  [ "$real" != "$INSTALL_REAL" ] || die "refusing to delete the install folder"
  ! inside "$INSTALL_REAL" "$real" || die "refusing: $DATA_DIR contains the install folder"
  while IFS= read -r -d '' name; do
    case "$name" in
      db.sqlite | db.sqlite-wal | db.sqlite-shm | db.sqlite-journal | drafts | public | .backup-*.sqlite) ;;
      *) unexpected+=" $name" ;;
    esac
  done < <(find "$real" -mindepth 1 -maxdepth 1 -printf '%f\0')
  [ -z "$unexpected" ] || die "refusing: $DATA_DIR holds entries the platform does not make:$unexpected. Nothing was deleted; remove the folder by hand if you are sure."
  guard_path "$DATA_PATH"
  say "Deleting $DATA_DIR"
  run rm -rf --one-file-system -- "$DATA_PATH"
}

cmd_uninstall() {
  require_installed
  check_recorded_data lenient
  take_lock
  say "Uninstalling: this stops and removes the platform's containers"
  info "The data folder $DATA_DIR, $LOGICAL_INSTALL_DIR/.env and $LOGICAL_INSTALL_DIR/backups stay."
  confirm "Stop and remove the containers?" || die "cancelled; nothing was changed"
  run "${DC[@]}" down --remove-orphans
  if [ "$DELETE_DATA" = 1 ] && [ -e "$DATA_PATH" ]; then
    local answer=""
    printf '\nDELETING THE DATA FOLDER %s PERMANENTLY REMOVES EVERY TOUR, IMAGE AND TOKEN.\n' "$DATA_DIR" >&2
    printf 'Backups in %s are kept. Type the domain name (%s) to delete it, or press Enter to keep it: ' "$LOGICAL_INSTALL_DIR/backups" "$DOMAIN" >&2
    read_line answer || answer=""
    if [ "$answer" = "$DOMAIN" ]; then
      delete_data_folder
    else
      say "The text did not match the domain; the data folder was kept at $DATA_DIR"
      exit 1
    fi
  fi
  say "Uninstalled"
  if [ -e "$DATA_PATH" ]; then
    info "data folder:  $DATA_DIR"
    info "Run install again to start it on the same data."
  else
    info "To install again from scratch, move the settings aside first: mv $LOGICAL_INSTALL_DIR/.env $LOGICAL_INSTALL_DIR/.env.old"
  fi
  if [ "$MODE" = tunnel ]; then
    info "settings:     $LOGICAL_INSTALL_DIR/.env (holds the setup code and the tunnel token; root only)"
  else
    info "settings:     $LOGICAL_INSTALL_DIR/.env (holds the setup code; root only)"
  fi
  info "backups:      $LOGICAL_INSTALL_DIR/backups"
  if [ "$MODE" = tunnel ]; then
    info "The tunnel and its DNS record stay in your Cloudflare account, and the token in .env still runs it: delete the tunnel in Cloudflare's dashboard when you no longer need it."
  fi
}

# ---------------------------------------------------------------- embedded stack files

# Exact copies of deploy/docker-compose.yml and deploy/caddy/Caddyfile (direct mode), so
# the script works on its own; deploy/test-install.sh fails if they, or the tunnel
# mode copies further down, drift apart from the files in deploy/.
compose_file_content() {
  cat <<'DP_COMPOSE_END'
# The container stack: the app behind Caddy, which ends HTTPS and is the only service
# with published ports. Run from the folder holding this file, a .env file and the
# caddy/ folder: docker compose up -d
#
# .env (mode 600, never committed) holds DOMAIN, ACME_EMAIL, DATA_DIR (a host folder
# owned by id 1001), APP_IMAGE and SETUP_CODE.

# Docker's local log files, capped at three files of 10 MB per container.
x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

services:
  app:
    image: ${APP_IMAGE:?APP_IMAGE is not set in .env}
    env_file: .env
    environment:
      # Paths and port inside the container. These win over the same names in .env,
      # where DATA_DIR is the folder on the host.
      DATA_DIR: /data
      PORT: "3000"
    volumes:
      # The data folder must already exist, owned by id 1001. Docker would otherwise
      # create a missing one owned by root, which the app cannot write to.
      - type: bind
        source: ${DATA_DIR:?DATA_DIR is not set in .env}
        target: /data
        bind:
          create_host_path: false
    # No ports: the app is reached only through caddy on the stack's own network.
    restart: unless-stopped
    stop_grace_period: 10s
    logging: *logging

  caddy:
    # caddy:2.11.9-alpine, pinned by the digest of its multi-platform index.
    image: caddy@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    environment:
      # Read by the Caddyfile as {$DOMAIN} and {$ACME_EMAIL}.
      DOMAIN: ${DOMAIN:?DOMAIN is not set in .env}
      ACME_EMAIL: ${ACME_EMAIL:?ACME_EMAIL is not set in .env}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      # The folder is mounted, not the single Caddyfile, so edits and reloads apply.
      - ./caddy:/etc/caddy:ro
      # Certificates and their keys; must persist, never treat as a cache.
      - ./caddy-data:/data
      - ./caddy-config:/config
    logging: *logging
DP_COMPOSE_END
}

caddyfile_content() {
  cat <<'DP_CADDYFILE_END'
# Caddy gets and renews the certificate for DOMAIN by itself once the domain's DNS
# record points at this server and ports 80 and 443 are reachable. ACME_EMAIL is the
# contact address for the certificate authority. Both come from the stack's .env.
{
	email {$ACME_EMAIL}
}

{$DOMAIN} {
	# Browsers keep to HTTPS for this host for one week. No subdomains, no preload list.
	header Strict-Transport-Security "max-age=604800"

	# Caddy passes the Host header through unchanged, which the setup wizard's
	# same-origin check compares against the page's Origin.
	reverse_proxy app:3000
}
DP_CADDYFILE_END
}

# Exact copies of deploy/tunnel/docker-compose.yml and deploy/tunnel/caddy/Caddyfile,
# written instead of the two above in tunnel mode.
tunnel_compose_file_content() {
  cat <<'DP_TUNNEL_COMPOSE_END'
# The container stack behind a Cloudflare Tunnel: the app behind Caddy, and cloudflared,
# which connects out to Cloudflare and hands each request to Caddy over plain HTTP on
# the stack's own network. No service publishes a port on the host. Run from the folder
# holding this file, a .env file and the caddy/ folder: docker compose up -d
#
# .env (mode 600, never committed) holds DOMAIN, DEPLOY_MODE=tunnel, DATA_DIR (a host
# folder owned by id 1001), APP_IMAGE, SETUP_CODE and TUNNEL_TOKEN.
#
# In Cloudflare's dashboard the tunnel's published application for DOMAIN has the
# service URL http://caddy:80

# Docker's local log files, capped at three files of 10 MB per container.
x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

services:
  app:
    image: ${APP_IMAGE:?APP_IMAGE is not set in .env}
    environment:
      # Named one by one instead of env_file: .env also holds TUNNEL_TOKEN, which only
      # cloudflared may see.
      SETUP_CODE: ${SETUP_CODE:?SETUP_CODE is not set in .env}
      PUBLIC_IMAGE_BASE: ${PUBLIC_IMAGE_BASE:-}
      # Paths and port inside the container; in .env, DATA_DIR is the folder on the host.
      DATA_DIR: /data
      PORT: "3000"
    volumes:
      # The data folder must already exist, owned by id 1001. Docker would otherwise
      # create a missing one owned by root, which the app cannot write to.
      - type: bind
        source: ${DATA_DIR:?DATA_DIR is not set in .env}
        target: /data
        bind:
          create_host_path: false
    # No ports: the app is reached only through caddy on the stack's own network.
    restart: unless-stopped
    stop_grace_period: 10s
    logging: *logging

  caddy:
    # caddy:2.11.9-alpine, pinned by the digest of its multi-platform index.
    image: caddy@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    environment:
      # Read by the Caddyfile as {$DOMAIN}.
      DOMAIN: ${DOMAIN:?DOMAIN is not set in .env}
    # No ports: only cloudflared, on the stack's own network, reaches Caddy.
    volumes:
      # The folder is mounted, not the single Caddyfile, so edits and reloads apply.
      - ./caddy:/etc/caddy:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    logging: *logging

  cloudflared:
    # cloudflare/cloudflared:2026.11.1, pinned by the digest of its multi-platform index,
    # read from Docker Hub on 2026-11-17. To refresh it, pick the newest version tag on
    # Docker Hub and take the line "Digest:" that this prints:
    #   docker buildx imagetools inspect cloudflare/cloudflared:<version>
    # then change it here and in the copy inside install.sh.
    image: cloudflare/cloudflared@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d
    restart: unless-stopped
    depends_on:
      - caddy
    # The token is not on this command line: cloudflared reads it from TUNNEL_TOKEN.
    # The metrics address serves the health check below and is not reachable from
    # outside the container.
    command: tunnel --no-autoupdate --metrics 127.0.0.1:20241 run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:?TUNNEL_TOKEN is not set in .env}
    healthcheck:
      # Succeeds once cloudflared holds a connection to Cloudflare.
      test: ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"]
      interval: 15s
      timeout: 5s
      start_period: 20s
      start_interval: 2s
      retries: 3
    logging: *logging
DP_TUNNEL_COMPOSE_END
}

tunnel_caddyfile_content() {
  cat <<'DP_TUNNEL_CADDYFILE_END'
# Behind a Cloudflare Tunnel: Cloudflare ends HTTPS for DOMAIN, and cloudflared, the only
# client that can reach this server, sends each request here as plain HTTP with the
# visitor's Host header unchanged. DOMAIN comes from the stack's .env.
{
	# No certificate is requested and nothing listens on port 443.
	auto_https off
}

http://{$DOMAIN} {
	# Cloudflare sets X-Forwarded-Proto to the protocol the visitor used and overwrites
	# a value the visitor sent, so a visitor on plain HTTP is sent to HTTPS here.
	@plain header X-Forwarded-Proto http
	redir @plain https://{host}{uri} 308

	# Browsers keep to HTTPS for this host for one week. No subdomains, no preload list.
	header Strict-Transport-Security "max-age=604800"

	# Caddy passes the Host header through unchanged, which the setup wizard's
	# same-origin check compares against the page's Origin. The app reads no forwarded
	# address or scheme, so nothing a visitor sends in such a header is trusted.
	reverse_proxy app:3000
}
DP_TUNNEL_CADDYFILE_END
}

# ---------------------------------------------------------------- main

main() {
  parse_args "$@"
  require_root
  check_os
  trap on_exit EXIT
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    status) cmd_status ;;
    uninstall) cmd_uninstall ;;
  esac
}

if [ "${DP_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi

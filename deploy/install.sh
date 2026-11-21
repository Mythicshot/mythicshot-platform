#!/usr/bin/env bash
# Installs and runs the demo platform on Debian: the app container behind Caddy. In
# direct mode (the default) Caddy gets and renews the HTTPS certificate by itself on
# ports 80 and 443. In tunnel mode (--tunnel) no port is published: a cloudflared
# container connects out to Cloudflare, which ends HTTPS and sends requests down the
# tunnel.
#
#   sudo bash install.sh [install|update|backup|status|uninstall] [--tunnel|--direct]
#                        [--app-domain=<name>] [--img-domain=<name>] [--new-token]
#                        [--dry-run] [--yes]
#                        [--force] [--delete-data]
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
# with the service URL http://caddy:80. Everything else is done here. With a second
# address for the app (--app-domain=<name>), the same for that name: a second DNS record,
# or a second published application with the same service URL. With a third address,
# for shared images and clips (--img-domain=<name>), the same once more.
#
# Safety rules this script keeps:
# - It never removes or overwrites the data folder, the .env file or a backup. The
#   exceptions: `uninstall --delete-data`, after the exact domain name is typed (--yes
#   does not skip that); and, in tunnel mode, the TUNNEL_TOKEN line of .env, which is
#   replaced once a new token (--new-token, or while the tunnel has never connected)
#   has connected. Every other line of .env, the setup code included, is carried over
#   unchanged, and no copy of the old file is kept.
# - A new token for an install whose tunnel has connected before (--new-token) is
#   tried before it is saved: the stack is started with the token in that one command's
#   environment, which Compose reads before .env, and the token is written to .env as
#   soon as the tunnel has connected with it, before any later step. Trying it restarts
#   the tunnel, so the site is out of reach meanwhile. A run that fails or is
#   interrupted before the token is saved leaves .env as it was and puts the containers
#   back in line with it: the stack is started again on the previous token, or, if it
#   was not running before the run, taken down again.
# - While the tunnel has never connected there is no working token to protect: a token
#   given then is written to .env before the start, so the containers never run on a
#   token that .env does not hold.
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
#   argument. In tunnel mode it is printed once at the end of the first run whose
#   tunnel connects, which may be a later run than the one that made it.
# - A tunnel that has never connected is marked by the file .tunnel-pending in the
#   install folder. While it is there, an install run asks for the token again, so a
#   wrong token is put right by running the script again. Only an install run whose
#   tunnel connects removes the file; update leaves it and says what to run.
# - The tunnel token is read at a hidden prompt (or from the TUNNEL_TOKEN environment
#   variable), checked for shape only, and written only to .env (mode 600, and so is
#   the temporary file it is written to first, which is removed when the run ends,
#   however it ends; one left by a run that was killed outright is removed, unread, by
#   the next run). It is never printed, not even in part, never passed as a command
#   argument and never written to the compose file or a backup archive; cloudflared's
#   log lines are masked for it before they are shown.
# - The mode is recorded in .env (DEPLOY_MODE=tunnel; no such line means direct). A run
#   never switches an existing install to the other mode: --tunnel or --direct against
#   the recorded mode is refused, with the steps to do it by hand.
# - A second address, for the app, is recorded in .env as APP_DOMAIN; DOMAIN is then the
#   address of the tours, and no such line means one address, as before. The stack file
#   derives the app's two settings (TOURS_HOST, APP_HOST) from the pair, and the
#   Caddyfile written is the two-address one. --app-domain=<name> writes the line on a
#   first install only: an existing .env is not rewritten for it, so on an existing
#   install the line is added (or removed) by hand and the next install run writes the
#   stack files to match. update refuses to start a stack whose Caddyfile was written
#   for the other number of addresses.
# - With two addresses, each is asked for /healthz after the start and must report its
#   own role. An address that reports another role, or none, fails the run with exit
#   code 1; nothing is undone, and the setup code of a first install is still printed.
#   An address that cannot be asked yet, or does not answer, is reported and is no
#   failure.
# - A third address, for shared images and clips, is recorded in .env as IMG_HOST, the
#   app's own setting, and only beside APP_DOMAIN. The stack files stay as they are: the
#   direct one hands the app the whole .env, the tunnel one passes IMG_HOST on. The name
#   is written into the Caddyfile itself, as a third name in the two-address site
#   address, so Caddy gets a certificate for it too. --img-domain=<name> writes the line
#   on a first install only, as --app-domain does; on an existing install it is added
#   (or removed) by hand and the next install run writes the Caddyfile to match. update
#   refuses to start while the Caddyfile does not answer for exactly the IMG_HOST of
#   .env. With it, the third address is asked for /healthz too and must report "img".
#   Without IMG_HOST every file is written exactly as before.
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
# The stack files' two-address settings nest one variable in another
# (${APP_DOMAIN:+${DOMAIN}}). That was checked on Compose 5.5.1, not on this minimum,
# so the script checks it itself on whatever Compose is installed: install_stack_files
# validates the new stack file and then has Compose render it, and requires the app's
# TOURS_HOST and APP_HOST to come out as meant (check_rendered_addresses). A Compose
# that cannot read the file, or fills the two in differently, stops the run before
# anything is replaced.
readonly MIN_COMPOSE=2.20.0
readonly DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# What the tunnel's published application points at: Caddy, by its service name on the
# stack's own network, over plain HTTP.
readonly TUNNEL_SERVICE_URL=http://caddy:80
# With two addresses: how often an address that does not answer /healthz is asked after
# a start (a new certificate takes a moment), and the seconds between two tries.
readonly ROLE_TRIES=5
readonly ROLE_PAUSE=4

# A token given in the environment is taken out of it at once: Compose prefers the
# environment over .env, so a leftover value would override the recorded token, and no
# child process needs it.
ENV_TOKEN="${TUNNEL_TOKEN:-}"
unset TUNNEL_TOKEN
# The two host names come from .env, the domain question and --app-domain only: this
# script never takes either from the environment. One left there would be read by
# Compose before .env, so both are taken out. So is the third address's IMG_HOST, which
# the tunnel stack file passes on from .env.
unset APP_DOMAIN
unset DOMAIN
unset IMG_HOST

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
PENDING_FILE="$INSTALL_DIR/.tunnel-pending"
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
NEW_TOKEN=0
APP_DOMAIN_FLAG=""  # the name given with --app-domain=
IMG_HOST_FLAG=""    # the name given with --img-domain=

MODE=""       # direct or tunnel
TOKEN=""      # the tunnel token; never printed
OLD_TOKEN=""  # the token .env held when this run began
TOKEN_CHANGED=0   # 1 when TOKEN is not the token .env held when this run began
TOKEN_ON_TRIAL=0  # 1 while TOKEN is tried first and is not in .env yet (see renew_token)
STACK_ON_TRIAL=0  # 1 while the containers run on that token: every way out ends the trial
STACK_WAS_RUNNING=0  # 1 when the stack was running before the token was tried
TRIAL_END=""      # what end_trial did, as a sentence for the closing message
PENDING=0     # 1 when this install's tunnel has never connected (PENDING_FILE was there)
UNFINISHED=0  # 1 when update found PENDING_FILE; on_exit then repeats what to run
SECRET_EXTRA=0
DOMAIN=""
APP_DOMAIN=""  # the app address of a two-address install (DOMAIN is then the address of the tours); empty: one address
IMG_HOST=""    # the img address, for shared images and clips, only beside APP_DOMAIN; empty: none
SKIP_IMG_CHECK=0  # 1 when status found that the Caddyfile does not answer for IMG_HOST
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
  --new-token     With install, on a tunnel install: ask for the tunnel token again and
                  replace the one in .env once the new one has connected.
  --app-domain=<name>  With install: a second address, for the app. The domain asked for stays the address of the tours.
  --img-domain=<name>  With install, beside --app-domain: a third address, for shared images and clips.
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
  local seen=0 app_seen=0 img_seen=0 a
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
      --new-token) NEW_TOKEN=1 ;;
      --app-domain=*)
        [ "$app_seen" = 0 ] || usage_error "give --app-domain only once"
        APP_DOMAIN_FLAG="${a#--app-domain=}"; app_seen=1 ;;
      --img-domain=*)
        [ "$img_seen" = 0 ] || usage_error "give --img-domain only once"
        IMG_HOST_FLAG="${a#--img-domain=}"; img_seen=1 ;;
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
  if [ "$NEW_TOKEN" = 1 ] && [ "$COMMAND" != install ]; then
    usage_error "--new-token goes only with install"
  fi
  if [ "$app_seen" = 1 ]; then
    [ "$COMMAND" = install ] || usage_error "--app-domain goes only with install"
    valid_domain "$APP_DOMAIN_FLAG" || usage_error "--app-domain must be a host name in lowercase, such as app.example.com, without https:// and without a path"
  fi
  if [ "$img_seen" = 1 ]; then
    [ "$COMMAND" = install ] || usage_error "--img-domain goes only with install"
    valid_domain "$IMG_HOST_FLAG" || usage_error "--img-domain must be a host name in lowercase, such as img.example.com, without https:// and without a path"
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
# data folder goes only if empty; while it holds files, .env stays with it, and so does
# the mark that the tunnel has never connected, which makes the next run ask for the
# token again.
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
    if [ "$p" = "$PENDING_FILE" ] && [ "$keep_env" = 1 ]; then continue; fi
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      if safe_rmdir_empty "$p"; then printf 'removed %s (created by this failed run)\n' "$p" >&2
      else printf 'kept %s: it is not empty\n' "$p" >&2; fi
    elif [ -e "$p" ] || [ -L "$p" ]; then
      safe_rm_file "$p"
      printf 'removed %s (created by this failed run)\n' "$p" >&2
    fi
  done
}

# Ends the trial of a new token that was not saved, and puts the containers back in line
# with .env, which still holds the previous token: files this run replaced are put
# back, then the stack is started again from .env, or, if it was not running before
# this run, what this run started is taken down. Sets TRIAL_END. Never exits early.
end_trial() {
  ( restore_replaced ) || warn "could not put back every file this run replaced; see the lines above"
  # A signal can end the run inside with_trial_token, where the new token is still in
  # the environment that commands get: take it out, so that Compose reads .env.
  unset TUNNEL_TOKEN
  [ -z "${TUNNEL_TOKEN+set}" ] || unset TUNNEL_TOKEN
  if [ "$STACK_WAS_RUNNING" = 1 ]; then
    say "Starting the site again on the previous token"
    if run "${DC[@]}" up -d; then
      TRIAL_END="The site is started again on the previous token; it could not be reached while the new one was tried."
    else
      TRIAL_END="The previous setup did not start: start it with: sudo bash $SELF install (the previous token is still in $ENV_FILE)."
    fi
  else
    say "The platform was not running before this run, so what this run started is taken down again"
    if run "${DC[@]}" down; then
      TRIAL_END="The platform was not running before this run and is stopped again."
    else
      TRIAL_END="The platform was not running before this run, and what this run started could not be taken down: stop it with: sudo bash $SELF uninstall (the data, $ENV_FILE and the backups stay)."
    fi
  fi
  STACK_ON_TRIAL=0
}

# Runs however the script ends, a signal included (see main). Temporary files go first:
# one of them may hold a token.
on_exit() {
  local status=$? f
  trap - EXIT
  # A further Ctrl-C, hang-up or kill must not cut short what follows: the containers
  # are put back in line with .env and the closing message is printed.
  trap : INT TERM HUP
  # Every step below is tried even if one before it fails, such as a message to a
  # terminal that is gone.
  set +e
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    if [ -e "$f" ] || [ -L "$f" ]; then safe_rm_file "$f"; fi
  done
  for f in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do remove_own_tmpdir "$f"; done
  if [ "$STACK_ON_TRIAL" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    warn "this run stopped before the new tunnel token had connected, so the new token was not saved. $ENV_FILE still holds the previous token."
    end_trial
    warn "$TRIAL_END To replace the token, run: sudo bash $SELF install --new-token"
  fi
  if [ "$status" != 0 ] && [ "$DRY_RUN" = 0 ] && [ "${#CREATED[@]}" -gt 0 ]; then undo_created; fi
  if [ "$UNFINISHED" = 1 ] && [ -e "$PENDING_FILE" ]; then
    printf "NOTE: this install is still not finished: its tunnel had never connected to Cloudflare when it was installed, and update leaves that as it is. Run: sudo bash %s install. It asks for the tunnel token again (paste it from the tunnel's page in Cloudflare's dashboard, or press Enter to keep the stored one) and prints the setup code once the tunnel has connected.\n" "$SELF" >&2
  fi
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

# Puts back every file this run replaced, from the copy saved first. Each step is
# checked by itself, so that a copy that fails is never followed by a move: a file
# that cannot be put back is left as this run wrote it, and the return value is 1.
restore_replaced() {
  local entry target bak tmp failed=0
  for entry in ${REPLACED[@]+"${REPLACED[@]}"}; do
    target="${entry%%|*}"
    bak="${entry#*|}"
    guard_path "$target"
    guard_path "$bak"
    if ! tmp="$(mktemp -- "$(dirname -- "$target")/.restore.XXXXXX")"; then
      warn "could not put back $target: no temporary file could be made. It is left as this run wrote it; the earlier one is $bak"
      failed=1
      continue
    fi
    TMP_FILES+=("$tmp")
    guard_path "$tmp"
    if ! cp -p -- "$bak" "$tmp"; then
      warn "could not put back $target: copying $bak failed. It is left as this run wrote it; the earlier one is $bak"
      rm -f -- "$tmp"
      failed=1
      continue
    fi
    if ! mv -f -- "$tmp" "$target"; then
      warn "could not put back $target: the move failed. It is left as this run wrote it; the earlier one is $bak"
      rm -f -- "$tmp"
      failed=1
      continue
    fi
    info "restored $target from $bak"
  done
  return "$failed"
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
# whole install command from the dashboard was pasted. A paste can hold a line break:
# on a terminal, whatever arrives right after the line is read too, hidden, and thrown
# away, so that it cannot fall into the next question and be echoed there. SECRET_EXTRA
# is 1 when such extra text was thrown away. Answers piped in are not a paste and are
# left alone.
read_secret() {
  local __out="$1" line extra="" more=0
  if [ ! -t 0 ] && { : </dev/tty; } 2>/dev/null; then
    IFS= read -rs line </dev/tty || return 1
    while IFS= read -rs -t 0.3 extra </dev/tty; do
      [ -z "${extra//[[:space:]]/}" ] || more=1
      extra=""
    done
  else
    IFS= read -rs line || return 1
    if [ -t 0 ]; then
      while IFS= read -rs -t 0.3 extra; do
        [ -z "${extra//[[:space:]]/}" ] || more=1
        extra=""
      done
    fi
  fi
  # A last piece without a line end is in extra when the wait ran out.
  [ -z "${extra//[[:space:]]/}" ] || more=1
  SECRET_EXTRA="$more"
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

# Stops a run that got no usable token, saying what state that leaves and what to run.
no_token() {
  if [ "$FIRST_RUN" = 1 ]; then
    die "$1. Nothing was installed and nothing was changed. Copy the token from the tunnel's page in Cloudflare's dashboard, then run: sudo bash $SELF install --tunnel"
  fi
  if [ "$PENDING" = 1 ]; then
    die "$1. Nothing was changed, and the install here is still not finished. Copy the token from the tunnel's page in Cloudflare's dashboard, then run: sudo bash $SELF install"
  fi
  die "$1. Nothing was changed: the token already stored is still the one in use. To try again, run: sudo bash $SELF install --new-token"
}

# The token is never echoed: not while it is typed, and not in a refusal. With "keep",
# an empty answer keeps the token already in TOKEN.
ask_token() {
  local keep="${1:-}" answer tries
  local prompt='Tunnel token from the Cloudflare dashboard (what you paste is not shown): '
  [ -z "$keep" ] || prompt='Tunnel token from the Cloudflare dashboard (what you paste is not shown; Enter keeps the one in .env): '
  if [ -n "$ENV_TOKEN" ]; then
    valid_token "$ENV_TOKEN" || die "the TUNNEL_TOKEN environment variable does not hold a tunnel token (one long word starting with eyJ); nothing was changed"
    TOKEN="$ENV_TOKEN"
    info "the tunnel token is taken from the TUNNEL_TOKEN environment variable"
    return 0
  fi
  for tries in 1 2 3; do
    printf '%s' "$prompt" >&2
    read_secret answer || no_token "no answer was given at the token question (run the script in a terminal)"
    printf '\n' >&2
    if [ "$SECRET_EXTRA" = 1 ]; then
      warn "what was pasted had more than one line, so none of it was taken: paste the token as one line (try $tries of 3)"
      continue
    fi
    if [ -n "$keep" ] && [ -z "$answer" ]; then info "keeping the token in .env"; return 0; fi
    if valid_token "$answer"; then TOKEN="$answer"; return 0; fi
    warn "that is not a tunnel token: paste the long word starting with eyJ, or the install command that ends with it (try $tries of 3)"
  done
  no_token "none of the three answers was a tunnel token"
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
# Asked of Docker by the labels Compose gives its containers, not through the stack
# file: that one cannot be read while .env has no value for a variable it requires.
stack_running() {
  [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ] && compose_present || return 1
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" 2>/dev/null || true)" ]
}

# Any container of the stack is running.
project_running() {
  compose_present || return 1
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)" ]
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
# $1 is the name: the domain, the app address of a two-address install, or the img address.
check_dns() {
  local name="$1"
  say "Checking that $name points at this server"
  local resolved local_ips ip records="" public_v4=0
  resolved="$(getent ahosts "$name" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  local_ips="$(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | sort -u || true)"
  for ip in $resolved; do
    if printf '%s\n' "$local_ips" | grep -qxF -- "$ip"; then
      info "$name resolves to $ip, an address of this server"
      return 0
    fi
  done
  for ip in $local_ips; do
    if [[ "$ip" == *:* ]]; then
      [[ "$ip" == fe80:* || "$ip" == fd* || "$ip" == fc* ]] || records+="      $name.  AAAA  $ip"$'\n'
    elif ! is_private_ipv4 "$ip"; then
      records+="      $name.  A     $ip"$'\n'
      public_v4=1
    fi
  done
  if [ -z "$resolved" ]; then
    warn "$name does not resolve yet, so Caddy cannot get its certificate until it does."
  else
    warn "$name resolves to $(printf '%s' "$resolved" | tr '\n' ' ')which is not an address of this server. That is fine if this server is behind a router that forwards ports 80 and 443 to it; otherwise fix the record."
  fi
  if [ "$public_v4" = 1 ] || [ -n "$records" ]; then
    printf '    Create this DNS record at your DNS provider:\n%s' "$records" >&2
  else
    printf '    This server has only private addresses (%s), so it is behind a router. Create:\n      %s.  A     <your public IPv4 address>\n    and forward TCP ports 80 and 443 (and UDP 443) on the router to this server.\n' \
      "$(printf '%s' "$local_ips" | tr '\n' ' ' | sed 's/ $//')" "$name" >&2
  fi
  info "the install goes on; the certificate is issued as soon as the record works."
}

# The name resolves to an address of this server.
resolves_here() {
  local resolved local_ips ip
  resolved="$(getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  local_ips="$(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | sort -u || true)"
  for ip in $resolved; do
    if printf '%s\n' "$local_ips" | grep -qxF -- "$ip"; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- configuration

read_env_file() {
  local line key value have_code=0 mode="" host_lines=0
  TOKEN=""
  APP_DOMAIN=""
  IMG_HOST=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "" | "#"*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      DOMAIN) DOMAIN="$value" ;;
      APP_DOMAIN) APP_DOMAIN="$value" ;;
      IMG_HOST) IMG_HOST="$value" ;;
      ACME_EMAIL) ACME_EMAIL="$value" ;;
      DATA_DIR) DATA_DIR="$value" ;;
      APP_IMAGE) IMAGE="$value" ;;
      SETUP_CODE) [ -z "$value" ] || have_code=1 ;;
      DEPLOY_MODE) mode="$value" ;;
      TUNNEL_TOKEN) TOKEN="$value" ;;
      TOURS_HOST | APP_HOST) host_lines=1 ;;
    esac
  done <"$ENV_FILE"
  # The app's own two settings: the stack file sets both from DOMAIN and APP_DOMAIN, so
  # a line for either in .env changes nothing. Said once, without the values.
  if [ "$host_lines" = 1 ]; then
    warn "$ENV_FILE has a TOURS_HOST or APP_HOST line, which has no effect on an install made by this script: a second address is set with APP_DOMAIN, and the stack gives the app both settings from DOMAIN and APP_DOMAIN. Remove the line."
  fi
  # No DEPLOY_MODE line is direct mode: that is every .env written before tunnel mode
  # existed, and what direct mode still writes.
  case "$mode" in
    "" | direct) MODE=direct ;;
    tunnel) MODE=tunnel ;;
    *) die "$ENV_FILE has a DEPLOY_MODE that is neither direct nor tunnel; fix it by hand, nothing was changed" ;;
  esac
  valid_domain "$DOMAIN" || die "$ENV_FILE has no valid DOMAIN; fix it by hand, nothing was changed"
  # No APP_DOMAIN line, or an empty one, is one address: every .env written before two
  # addresses existed. One that is set must be a second name; a half-right pair would
  # start an app that refuses its own address.
  if [ -n "$APP_DOMAIN" ]; then
    if ! valid_domain "$APP_DOMAIN" || [ "$APP_DOMAIN" = "$DOMAIN" ]; then
      die "$ENV_FILE has an APP_DOMAIN that is not a valid host name or is the same as DOMAIN; fix it by hand, nothing was changed"
    fi
  fi
  # No IMG_HOST line, or an empty one, is no third address. One that is set goes only
  # beside the other two, under a name of its own, as the app itself requires (it does
  # not start otherwise).
  if [ -n "$IMG_HOST" ]; then
    if [ -z "$APP_DOMAIN" ]; then
      die "$ENV_FILE has an IMG_HOST but no APP_DOMAIN: the img address goes only beside the two others. Add the APP_DOMAIN line or remove the IMG_HOST line by hand; nothing was changed"
    fi
    if ! valid_domain "$IMG_HOST" || [ "$IMG_HOST" = "$DOMAIN" ] || [ "$IMG_HOST" = "$APP_DOMAIN" ]; then
      die "$ENV_FILE has an IMG_HOST that is not a valid host name or is the same as DOMAIN or APP_DOMAIN; fix it by hand, nothing was changed"
    fi
  fi
  if [ "$MODE" = tunnel ]; then
    if ! valid_token "$TOKEN"; then
      # An install run that is about to ask for the token anyway goes on without one.
      if [ "$COMMAND" = install ] && { [ -e "$PENDING_FILE" ] || [ "$NEW_TOKEN" = 1 ]; }; then
        TOKEN=""
      else
        die "$ENV_FILE says DEPLOY_MODE=tunnel but has no TUNNEL_TOKEN of the right shape (one long word starting with eyJ); nothing was changed. Give it a new one with: sudo bash $SELF install --new-token"
      fi
    fi
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
    if [ "$NEW_TOKEN" = 1 ] && [ "$MODE" != tunnel ]; then
      die "--new-token is for an install in tunnel mode, and this install is not in tunnel mode: it is in direct mode (ports 80 and 443, its own certificate) and has no tunnel token. Nothing was changed. Run it without the option: sudo bash $SELF install"
    fi
    check_recorded_data strict
    if [ -n "$MODE_FLAG" ] && [ "$MODE_FLAG" != "$MODE" ]; then refuse_mode_switch; fi
    if [ -n "$APP_DOMAIN_FLAG" ] && [ "$APP_DOMAIN_FLAG" != "$APP_DOMAIN" ]; then refuse_app_domain_change; fi
    if [ -n "$IMG_HOST_FLAG" ] && [ "$IMG_HOST_FLAG" != "$IMG_HOST" ]; then refuse_img_host_change; fi
    if [ "$MODE" = tunnel ]; then
      info "tunnel mode, domain $DOMAIN, data folder $DATA_DIR, image $IMAGE"
    else
      info "domain $DOMAIN, email $ACME_EMAIL, data folder $DATA_DIR, image $IMAGE"
    fi
    if [ -n "$APP_DOMAIN" ]; then
      info "two addresses: $DOMAIN is the address of the tours, the app address is $APP_DOMAIN"
    fi
    if [ -n "$IMG_HOST" ]; then
      info "img address: $IMG_HOST (for shared images and clips)"
    fi
    refuse_other_modes_stack
    if [ "$MODE" = tunnel ]; then renew_token; fi
    return 0
  fi
  FIRST_RUN=1
  if [ -n "$IMG_HOST_FLAG" ] && [ -z "$APP_DOMAIN_FLAG" ]; then
    die "the img address goes only beside an app address: give --app-domain=<name> too. Nothing was installed and nothing was changed."
  fi
  say "A few questions"
  if [ -n "$MODE_FLAG" ]; then MODE="$MODE_FLAG"; else ask_mode; fi
  ask_domain
  if [ -n "$APP_DOMAIN_FLAG" ]; then
    [ "$APP_DOMAIN_FLAG" != "$DOMAIN" ] || die "the app address must be a different name than the tours address. Nothing was installed and nothing was changed."
    APP_DOMAIN="$APP_DOMAIN_FLAG"
  fi
  if [ -n "$IMG_HOST_FLAG" ]; then
    if [ "$IMG_HOST_FLAG" = "$DOMAIN" ] || [ "$IMG_HOST_FLAG" = "$APP_DOMAIN" ]; then
      die "the img address must be a different name than the tours address and the app address. Nothing was installed and nothing was changed."
    fi
    IMG_HOST="$IMG_HOST_FLAG"
  fi
  if [ "$MODE" = tunnel ]; then ask_token; else ask_email; fi
  ask_data_dir
  DATA_PATH="$DP_ROOT$DATA_DIR"
  IMAGE="${APP_IMAGE:-$DEFAULT_APP_IMAGE}"
  valid_image "$IMAGE" || die "APP_IMAGE is not a valid image name"
}

# On an existing tunnel install: asks for the token again when the tunnel has never
# connected (so a wrong token is put right by running the script again) or when
# --new-token was given. Otherwise the token in .env stays, whatever the environment
# holds. A new token for an install whose tunnel has connected on the stored one is
# tried first (TOKEN_ON_TRIAL) and saved once it has connected (save_new_token). While
# there is no working token to protect (the tunnel never connected, or the stored token
# is unusable), the new one is saved before the start (write_env_file).
renew_token() {
  OLD_TOKEN="$TOKEN"
  [ ! -e "$PENDING_FILE" ] || PENDING=1
  if [ "$PENDING" = 1 ] || [ "$NEW_TOKEN" = 1 ]; then
    if [ "$PENDING" = 1 ]; then
      say "The last install here did not finish: its tunnel never connected to Cloudflare, so the site cannot be reached yet"
      if [ -n "$ENV_TOKEN" ]; then
        info "This run tries again, with the token given in the TUNNEL_TOKEN environment variable."
      elif valid_token "$OLD_TOKEN"; then
        info "Paste the tunnel token again at the question below; copy it fresh from the tunnel's page in Cloudflare's dashboard. If the token was not the problem, press Enter to keep the token already stored."
      else
        info "Paste the tunnel token again at the question below; copy it fresh from the tunnel's page in Cloudflare's dashboard."
      fi
    else
      say "Replacing the tunnel token"
      if valid_token "$OLD_TOKEN" && project_running; then
        info "The token in use now stays in $LOGICAL_INSTALL_DIR/.env until the new one has connected. Trying the new one restarts the tunnel, so the site cannot be reached for a moment. If the new one does not connect within ${WAIT_SECONDS}s, it is not saved and the site is started again on the previous token; until then the site stays out of reach."
      elif valid_token "$OLD_TOKEN"; then
        info "The token in use now stays in $LOGICAL_INSTALL_DIR/.env until the new one has connected. The platform is not running now: this run starts it on the new token. If the new one does not connect within ${WAIT_SECONDS}s, it is not saved and the platform is stopped again."
      else
        info "The token stored in $LOGICAL_INSTALL_DIR/.env cannot be used, so the new one is saved as soon as it is given."
      fi
    fi
    if valid_token "$OLD_TOKEN"; then ask_token keep; else ask_token; fi
    if [ "$TOKEN" != "$OLD_TOKEN" ]; then
      TOKEN_CHANGED=1
      if [ "$PENDING" = 0 ] && valid_token "$OLD_TOKEN"; then TOKEN_ON_TRIAL=1; fi
    fi
  elif [ -n "$ENV_TOKEN" ]; then
    warn "TUNNEL_TOKEN is set in the environment, but this install already has a token that connected, so it is not taken. To replace the token: sudo bash $SELF install --new-token"
  fi
}

# Rewrites .env with one line changed, TUNNEL_TOKEN, and every other line as it was.
# The new file is made by mktemp (mode 600 from its first byte), is complete before it
# takes the old one's place in one move, and is removed by on_exit if the run ends
# before that; no copy of the old file is kept, so no file but .env ever holds a token.
replace_env_token() {
  local new="$1" tmp line found=0
  valid_token "$new" || die "no tunnel token to write"
  if [ "$DRY_RUN" = 1 ]; then info "would replace the TUNNEL_TOKEN line of $ENV_FILE"; return 0; fi
  tmp="$(mktemp -- "$INSTALL_DIR/.env.new.XXXXXX")"
  TMP_FILES+=("$tmp")
  guard_path "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      TUNNEL_TOKEN=*) [ "$found" = 1 ] || printf 'TUNNEL_TOKEN=%s\n' "$new"; found=1 ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$ENV_FILE" >"$tmp"
  [ "$found" = 1 ] || printf 'TUNNEL_TOKEN=%s\n' "$new" >>"$tmp"
  chmod 600 -- "$tmp"
  chown 0:0 -- "$tmp"
  safe_mv "$tmp" "$ENV_FILE"
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

# The second address of an existing install is never set or changed by a flag: .env is
# not rewritten for it, so the line is added by hand and the next install run writes the
# stack files for it.
refuse_app_domain_change() {
  local env="$LOGICAL_INSTALL_DIR/.env"
  if [ "$APP_DOMAIN_FLAG" = "$DOMAIN" ]; then
    die "the app address must be a different name than the tours address. Nothing was changed."
  fi
  if [ -n "$APP_DOMAIN" ]; then
    die "this install's .env does not hold APP_DOMAIN=$APP_DOMAIN_FLAG, and install.sh does not change that file. To add the second address, add that line to $env as root, then run: sudo bash $SELF install. The file holds APP_DOMAIN=$APP_DOMAIN now: change that line instead of adding one. Nothing was changed."
  fi
  die "this install's .env does not hold APP_DOMAIN=$APP_DOMAIN_FLAG, and install.sh does not change that file. To add the second address, add that line to $env as root, then run: sudo bash $SELF install. Nothing was changed."
}

# The third address of an existing install is never set or changed by a flag either: the
# IMG_HOST line is added by hand, beside APP_DOMAIN, and the next install run writes the
# Caddyfile for it.
refuse_img_host_change() {
  local env="$LOGICAL_INSTALL_DIR/.env"
  if [ "$IMG_HOST_FLAG" = "$DOMAIN" ] || [ "$IMG_HOST_FLAG" = "$APP_DOMAIN" ]; then
    die "the img address must be a different name than the tours address and the app address. Nothing was changed."
  fi
  if [ -z "$APP_DOMAIN" ]; then
    die "this install's .env does not hold IMG_HOST=$IMG_HOST_FLAG, and install.sh does not change that file. The img address goes only beside an app address, and this install has none: add an APP_DOMAIN line first (see the runbook's section on two addresses), then the IMG_HOST line, then run: sudo bash $SELF install. Nothing was changed."
  fi
  if [ -n "$IMG_HOST" ]; then
    die "this install's .env does not hold IMG_HOST=$IMG_HOST_FLAG, and install.sh does not change that file. To add the img address, add that line to $env as root, then run: sudo bash $SELF install. The file holds IMG_HOST=$IMG_HOST now: change that line instead of adding one. Nothing was changed."
  fi
  die "this install's .env does not hold IMG_HOST=$IMG_HOST_FLAG, and install.sh does not change that file. To add the img address, add that line to $env as root, then run: sudo bash $SELF install. Nothing was changed."
}

# The third name in the site address of the Caddyfile on disk, as caddyfile_three_content
# writes it; nothing when it has none.
caddyfile_img_name() {
  local line prefix
  # shellcheck disable=SC2016 # the literal Caddyfile placeholders
  local direct='{$DOMAIN}, {$APP_DOMAIN}, ' tunnel='http://{$DOMAIN}, http://{$APP_DOMAIN}, http://' end=' {'
  [ -f "$CADDYFILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    for prefix in "$direct" "$tunnel"; do
      if [[ "$line" == "$prefix"*"$end" ]]; then
        line="${line#"$prefix"}"
        printf '%s\n' "${line%"$end"}"
        return 0
      fi
    done
  done <"$CADDYFILE"
  return 0
}

# The Caddyfile on disk was written for the addresses .env records: the two-address one
# when there is an app address, the one-address one when there is none.
caddyfile_matches_addresses() {
  local two=0
  # shellcheck disable=SC2016 # the literal Caddyfile placeholder
  if grep -qF '{$APP_DOMAIN}' "$CADDYFILE" 2>/dev/null; then two=1; fi
  if [ -n "$APP_DOMAIN" ]; then [ "$two" = 1 ]; else [ "$two" = 0 ]; fi
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

# Holds a lock for the rest of the run, so two runs cannot interleave. With the lock
# held, no other run is writing .env, so a temporary .env still lying there was left by
# a run that was killed outright: it is removed.
take_lock() {
  [ "$DRY_RUN" = 0 ] && [ -d "$INSTALL_DIR" ] || return 0
  if command -v flock >/dev/null 2>&1; then
    [ -e "$LOCK_FILE" ] || CREATED+=("$LOCK_FILE")
    exec 9>>"$LOCK_FILE"
    flock -n 9 || die "another run of this script is in progress"
  fi
  remove_stale_env_tmp
}

# Removes temporary .env files (the names replace_env_token and write_env_file give
# them) that an earlier run left behind. They may hold a token: they are not read, and
# only their names are printed.
remove_stale_env_tmp() {
  local f
  for f in "$INSTALL_DIR"/.env.new.??????; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    safe_rm_file "$f"
    info "removed $f, a temporary file left by an earlier run that was stopped"
  done
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
  if [ -e "$ENV_FILE" ] && [ "$TOKEN_ON_TRIAL" = 1 ]; then
    say "Keeping $ENV_FILE as it is for now: the new tunnel token is saved in it only once it has connected"
    return 0
  fi
  if [ -e "$ENV_FILE" ] && [ "$TOKEN_CHANGED" = 1 ]; then
    say "Saving the tunnel token in $ENV_FILE (every other line stays as it is; the setup code does not change)"
    replace_env_token "$TOKEN"
    return 0
  fi
  if [ -e "$ENV_FILE" ]; then
    say "Keeping $ENV_FILE as it is (the setup code does not change)"
    return 0
  fi
  if [ "$MODE" = tunnel ]; then
    say "Writing $ENV_FILE (mode 600, root only) with a new setup code and the tunnel token"
  else
    say "Writing $ENV_FILE (mode 600, root only) with a new setup code"
  fi
  local names=DOMAIN
  [ -z "$APP_DOMAIN" ] || names="DOMAIN, APP_DOMAIN"
  [ -z "$IMG_HOST" ] || names="$names, IMG_HOST"
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$MODE" = tunnel ]; then
      info "would write $names, DEPLOY_MODE, DATA_DIR, APP_IMAGE, a new SETUP_CODE and the TUNNEL_TOKEN to $ENV_FILE"
    else
      info "would write $names, ACME_EMAIL, DATA_DIR, APP_IMAGE and a new SETUP_CODE to $ENV_FILE"
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
      [ -z "$APP_DOMAIN" ] || printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN"
      [ -z "$IMG_HOST" ] || printf 'IMG_HOST=%s\n' "$IMG_HOST"
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
      [ -z "$APP_DOMAIN" ] || printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN"
      [ -z "$IMG_HOST" ] || printf 'IMG_HOST=%s\n' "$IMG_HOST"
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
  if [ "$MODE" = tunnel ]; then
    # Stays until the tunnel has connected once; see finish.
    guard_path "$PENDING_FILE"
    printf 'Written by install.sh: the tunnel of this install has not connected yet. Until it has, install asks for the tunnel token again. Removed by the first run that connects.\n' >"$PENDING_FILE"
    chmod 600 -- "$PENDING_FILE"
    CREATED+=("$PENDING_FILE")
  fi
}

install_stack_files() {
  if [ "$MODE" = tunnel ]; then
    say "Writing $COMPOSE_FILE and $CADDYFILE for tunnel mode (no published ports; the domain and the token come from .env)"
  else
    say "Writing $COMPOSE_FILE and $CADDYFILE (the domain and email come from .env)"
  fi
  if [ -n "$IMG_HOST" ]; then
    info "three addresses: the Caddyfile is the one that answers for $DOMAIN, $APP_DOMAIN and $IMG_HOST"
  elif [ -n "$APP_DOMAIN" ]; then
    info "two addresses: the Caddyfile is the one that answers for $DOMAIN and $APP_DOMAIN"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    local f
    for f in "$COMPOSE_FILE" "$CADDYFILE"; do
      if [ -e "$f" ]; then info "would compare $f and, if it differs, save it as .bak-<timestamp> and replace it"
      else info "would write $f"; fi
    done
    if [ -n "$APP_DOMAIN" ]; then
      info "would check that Docker Compose fills in the new stack file with TOURS_HOST=$DOMAIN and APP_HOST=$APP_DOMAIN for the app, before it replaces anything"
    else
      info "would check that Docker Compose fills in the new stack file with TOURS_HOST and APP_HOST both empty for the app, before it replaces anything"
    fi
    return 0
  fi
  [ -e "$COMPOSE_FILE" ] || COMPOSE_CREATED=1
  if [ "$MODE" = tunnel ]; then
    stage_file "$COMPOSE_FILE" 0600 < <(tunnel_compose_file_content)
  else
    stage_file "$COMPOSE_FILE" 0600 < <(compose_file_content)
  fi
  local staged_compose="$STAGED"
  with_trial_token run docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$staged_compose" config --quiet \
    || die "the new compose file does not validate; nothing was replaced"
  check_rendered_addresses "$staged_compose"
  STAGED="$staged_compose"
  commit_file "$COMPOSE_FILE" "$INSTALL_DIR"
  # Made first, so that a failure while making it stops the run (a process substitution
  # could not). $(...) drops the file's one closing newline, which printf puts back.
  local caddy_content
  caddy_content="$(caddyfile_for_install)" || exit 1
  stage_file "$CADDYFILE" 0600 < <(printf '%s\n' "$caddy_content")
  commit_file "$CADDYFILE" "$CADDY_DIR"
  CADDY_CHANGED="$COMMITTED"
}

# Stops the run, before anything is replaced, unless the installed Compose fills in the
# staged stack file with the app's TOURS_HOST and APP_HOST exactly as this script means
# them: both empty with one address, DOMAIN and APP_DOMAIN with two. Compose renders the
# file with the project folder, and so the .env, that the start uses, and with a token on
# trial the way the start gets it. The rendering holds the setup code and the token: it
# goes down a pipe to rendered_app_hosts and nowhere else, never to the terminal or a
# file, and what comes back is compared and never printed. The app's IMG_HOST must also
# come out as the IMG_HOST this script read (absent and empty alike when there is none):
# Compose reads .env more leniently than read_env_file (an "export " in front, blanks
# before the name or around the =), and a line only Compose takes would give the app a
# third address that the Caddyfile written here does not answer for. With "img-only"
# (update, on the stack file in place) only IMG_HOST is compared.
check_rendered_addresses() {
  local staged="$1" only="${2:-}" want="|" got
  [ -z "$APP_DOMAIN" ] || want="$DOMAIN|$APP_DOMAIN"
  # update asks without a word, so that it prints what it printed before 0.1.50.
  [ "$only" = img-only ]     || info "asking Docker Compose how it fills in the new stack file's two address settings (what it prints is read here and not shown)"
  got="$(with_trial_token docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$staged" config 2>/dev/null | rendered_app_hosts img)" || got=""
  if [ -z "$got" ] || { [ "$only" != img-only ] && [ "${got%|*}" != "$want" ]; }; then
    die "This version of Docker Compose does not read the two-address settings in the stack file the way this script expects, so nothing was changed. Update Docker Compose and run install again."
  fi
  [ "${got##*|}" = "$IMG_HOST" ] \
    || die "Docker Compose hands the app another IMG_HOST than install.sh reads in .env, so nothing was changed. Write the line exactly as IMG_HOST=<name>, at the start of the line, without export, spaces or quotes (or remove it), and run install again."
}

# Reads a rendered stack file (the output of docker compose config) and prints the app
# service's two settings as "<TOURS_HOST>|<APP_HOST>", quotes taken off; nothing unless
# each is under services, app, environment exactly once. A setting without a value is
# not an empty one. No other part of what is read is passed on. With "img" it adds the
# app's IMG_HOST as a third field, "<TOURS_HOST>|<APP_HOST>|<IMG_HOST>": empty when it is
# absent or empty, "(no value)" or "(twice)" when it cannot be a name.
rendered_app_hosts() {
  awk -v sq="'" -v img="${1:-}" '
    { sub(/\r$/, "") }
    /^[^ ]/ { top = $0; svc = ""; sec = ""; next }
    /^  [^ ]/ { svc = $0; sec = ""; next }
    /^    [^ ]/ { sec = $0; next }
    top == "services:" && svc == "  app:" && sec == "    environment:" && /^      (TOURS_HOST|APP_HOST|IMG_HOST):( |$)/ {
      key = $1; sub(/:$/, "", key)
      val = $0; sub(/^      [A-Z_]+:/, "", val); gsub(/^ +| +$/, "", val)
      first = substr(val, 1, 1); last = substr(val, length(val), 1)
      if (length(val) >= 2 && first == last && (first == "\"" || first == sq)) val = substr(val, 2, length(val) - 2)
      else if (val == "") val = "(no value)"
      seen[key]++; value[key] = val
    }
    END {
      if (seen["TOURS_HOST"] != 1 || seen["APP_HOST"] != 1) exit
      if (img != "img") { printf "%s|%s\n", value["TOURS_HOST"], value["APP_HOST"]; exit }
      i = ""
      if (seen["IMG_HOST"] > 1) i = "(twice)"
      else if (seen["IMG_HOST"] == 1) i = value["IMG_HOST"]
      printf "%s|%s|%s\n", value["TOURS_HOST"], value["APP_HOST"], i
    }
  '
}

# The Caddyfile for this install's mode and its one, two or three addresses.
caddyfile_for_install() {
  case "$MODE:${APP_DOMAIN:+two}${IMG_HOST:+three}" in
    tunnel:twothree) caddyfile_three_content tunnel_caddyfile_two_content \
      "http://{\$DOMAIN}, http://{\$APP_DOMAIN} {" "http://{\$DOMAIN}, http://{\$APP_DOMAIN}, http://$IMG_HOST {" ;;
    tunnel:two) tunnel_caddyfile_two_content ;;
    tunnel:) tunnel_caddyfile_content ;;
    *:twothree) caddyfile_three_content caddyfile_two_content \
      "{\$DOMAIN}, {\$APP_DOMAIN} {" "{\$DOMAIN}, {\$APP_DOMAIN}, $IMG_HOST {" ;;
    *:two) caddyfile_two_content ;;
    *) caddyfile_content ;;
  esac
}

# The three-address Caddyfile: caddyfile_three_content <two-address function> <its site
# address line> <the same line with the img address>. The two-address file with the img
# address as a third name in its site address, and every other line as it is, so Caddy
# gets a certificate for that name too (in tunnel mode it answers plain HTTP for it).
# The name is written into the file, not read from the environment as the other two are:
# the stack files hand Caddy only DOMAIN and APP_DOMAIN, and stay the same files with or
# without the third address. It is a host name from .env, checked by valid_domain.
caddyfile_three_content() {
  local line found=0
  while IFS= read -r line; do
    if [ "$line" = "$2" ]; then printf '%s\n' "$3"; found=1; else printf '%s\n' "$line"; fi
  done < <("$1")
  [ "$found" = 1 ] || die "the two-address Caddyfile has no site address line to add the img address to"
}

# Runs a command. While a new token is on trial, that command alone gets it, as
# TUNNEL_TOKEN in its environment, which Compose reads before .env. So the token is on
# no command line and in no file until it has connected.
with_trial_token() {
  if [ "$TOKEN_ON_TRIAL" = 1 ]; then
    local -x TUNNEL_TOKEN="$TOKEN"
  fi
  "$@"
}

# The new token has connected: only now does it take the old one's place in .env. Run
# straight after the start, before any other step, so that nothing later in the run can
# undo a token that works.
save_new_token() {
  [ "$TOKEN_ON_TRIAL" = 1 ] || return 0
  if [ "$DRY_RUN" = 1 ]; then
    info "would save the new tunnel token in $ENV_FILE once it has connected"
    return 0
  fi
  say "The new tunnel token connected; saving it in $ENV_FILE (every other line stays as it is; the setup code does not change)"
  replace_env_token "$TOKEN"
  TOKEN_ON_TRIAL=0
  STACK_ON_TRIAL=0
}

# Shows cloudflared's last log lines, masked for the token, and says in plain words what
# the known ones mean. The messages matched here are cloudflared's own (see the top of
# this file); the text Cloudflare adds after a refused registration is not relied on.
explain_tunnel_failure() {
  local logs
  say "cloudflared's last log lines"
  info "\$ ${DC[*]} logs --no-color --tail 40 cloudflared"
  logs="$(with_trial_token "${DC[@]}" logs --no-color --tail 40 cloudflared 2>&1 || true)"
  if [ -n "$TOKEN" ]; then logs="${logs//"$TOKEN"/<tunnel token hidden>}"; fi
  if [ -n "$OLD_TOKEN" ]; then logs="${logs//"$OLD_TOKEN"/<tunnel token hidden>}"; fi
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
  # A new token on trial: from here until it is saved, every way out of this run ends
  # the trial (end_trial: below when the start fails, in on_exit when the run is
  # interrupted), so that the containers and .env agree again.
  if [ "$TOKEN_ON_TRIAL" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    if project_running; then STACK_WAS_RUNNING=1; fi
    STACK_ON_TRIAL=1
  fi
  if ! with_trial_token run "${DC[@]}" up -d --pull missing --wait --wait-timeout "$WAIT_SECONDS"; then
    warn "the platform did not start"
    if [ "$MODE" = tunnel ]; then explain_tunnel_failure; fi
    if [ "$STACK_ON_TRIAL" = 1 ]; then
      say "The new token did not connect, so it is not saved: $ENV_FILE still holds the previous token, which connected before"
      end_trial
      die "the tunnel did not connect with the new token, so the new token was not saved. $TRIAL_END $ENV_FILE, the data folder and the backups were not changed. Copy the current token from the tunnel's page in Cloudflare's dashboard, then run: sudo bash $SELF install --new-token"
    fi
    if [ "$COMPOSE_CREATED" = 1 ]; then
      say "The app's last log lines"
      run "${DC[@]}" logs --tail 50 app || true
      say "Taking the half-started stack down again"
      run "${DC[@]}" down || warn "could not take the stack down"
      if [ "$MODE" = tunnel ]; then
        die "starting failed; see the log lines above. Run: sudo bash $SELF install; it asks for the tunnel token again and prints the setup code once the tunnel has connected. The files this run created are removed below; .env stays if the app has already written to the data folder."
      fi
      die "starting failed; see the log lines above. The files this run created are removed below."
    fi
    if [ "${#REPLACED[@]}" -gt 0 ]; then
      say "Putting back the files this run replaced and starting the previous setup"
      restore_replaced || warn "could not put back every file this run replaced; see the lines above"
      run "${DC[@]}" up -d || warn "the previous setup did not start either"
    fi
    # The Caddyfile put back may no longer match the IMG_HOST line of .env, which this
    # run never changes: say which way, and what puts it right.
    local hint="" back_img
    if [ "$CADDY_CHANGED" = 1 ]; then
      back_img="$(caddyfile_img_name)"
      if [ "$back_img" != "$IMG_HOST" ] && [ -n "$IMG_HOST" ]; then
        hint=" The earlier Caddyfile was put back, and it does not answer for IMG_HOST=$IMG_HOST in $LOGICAL_INSTALL_DIR/.env: remove that line, or put right what stopped the start and run: sudo bash $SELF install"
      elif [ "$back_img" != "$IMG_HOST" ]; then
        hint=" The earlier Caddyfile was put back, and it still answers for $back_img, which $LOGICAL_INSTALL_DIR/.env no longer holds as IMG_HOST: put that line back, or put right what stopped the start and run: sudo bash $SELF install"
      fi
    fi
    if [ "$MODE" = tunnel ] && [ "$PENDING" = 1 ]; then
      die "starting failed: the tunnel still did not connect, so the site cannot be reached yet. The data folder and the backups were not changed. Run: sudo bash $SELF install; it asks for the tunnel token again. See the logs with: ${DC[*]} logs$hint"
    fi
    if [ "$MODE" = tunnel ]; then
      die "starting failed. The data folder, $ENV_FILE and the backups were not changed. If the token is the cause, replace it with: sudo bash $SELF install --new-token. See the logs with: ${DC[*]} logs$hint"
    fi
    die "starting failed. The data folder, $ENV_FILE and the backups were not changed. See the logs with: ${DC[*]} logs$hint"
  fi
  save_new_token
  if [ "$CADDY_CHANGED" = 1 ] && [ "$caddy_was_running" = 1 ]; then
    say "Restarting Caddy so it reads the new Caddyfile"
    run "${DC[@]}" restart caddy
  fi
}

finish() {
  if [ "$DRY_RUN" = 1 ]; then say "Dry run finished: nothing was changed"; return 0; fi
  if [ "$MODE" = tunnel ] && [ -n "$IMG_HOST" ]; then
    printf '\nThe platform is running and its tunnel is connected to Cloudflare.\n'
    printf "\nIn Cloudflare's dashboard, the tunnel needs three published applications, one for each address (skip this if they are there already):\n"
    printf '  Hostname:     %s\n' "$DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf '  Hostname:     %s\n' "$APP_DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf '  Hostname:     %s\n' "$IMG_HOST"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf 'No port is published on this server; it is reached only through the tunnel.\n'
  elif [ "$MODE" = tunnel ] && [ -n "$APP_DOMAIN" ]; then
    printf '\nThe platform is running and its tunnel is connected to Cloudflare.\n'
    printf "\nIn Cloudflare's dashboard, the tunnel needs two published applications, one for each address (skip this if they are there already):\n"
    printf '  Hostname:     %s\n' "$DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf '  Hostname:     %s\n' "$APP_DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf 'No port is published on this server; it is reached only through the tunnel.\n'
  elif [ "$MODE" = tunnel ]; then
    printf '\nThe platform is running and its tunnel is connected to Cloudflare.\n'
    printf "\nIn Cloudflare's dashboard, the tunnel needs one published application (skip this if it is there already):\n"
    printf '  Hostname:     %s\n' "$DOMAIN"
    printf '  Service URL:  %s\n' "$TUNNEL_SERVICE_URL"
    printf 'No port is published on this server; it is reached only through the tunnel, at https://%s\n' "$DOMAIN"
  else
    printf '\nThe platform is running at https://%s\n' "$DOMAIN"
  fi
  if [ -n "$APP_DOMAIN" ]; then
    printf 'Tours are at https://%s; the app address is https://%s. Mythicshot keeps using https://%s.\n' "$DOMAIN" "$APP_DOMAIN" "$DOMAIN"
  fi
  if [ -n "$IMG_HOST" ]; then
    printf 'Shared images and clips are at https://%s.\n' "$IMG_HOST"
  fi
  # The tunnel has connected: the mark that it never did goes, and a setup code that a
  # failed earlier run made without printing it is printed now, once.
  if [ "$MODE" = tunnel ] && [ -e "$PENDING_FILE" ]; then safe_rm_file "$PENDING_FILE"; fi
  if [ "$CODE_GENERATED" = 1 ] || [ "$PENDING" = 1 ]; then
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

# With two addresses: asks each one for /healthz, through whatever is in front of the
# platform, and requires the role the platform reports to be that address's own. An
# address that answers in another role, or in none, fails the run with exit code 1;
# nothing is undone, the install stays as it is. $1 is how often an address that does
# not answer is asked.
check_roles() {
  local tries="$1" bad=0
  [ -n "$APP_DOMAIN" ] || return 0
  if [ "$DRY_RUN" = 1 ] && [ -n "$IMG_HOST" ]; then
    info "would ask https://$DOMAIN/healthz, https://$APP_DOMAIN/healthz and https://$IMG_HOST/healthz which address the platform sees each as"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "would ask https://$DOMAIN/healthz and https://$APP_DOMAIN/healthz which address the platform sees each as"
    return 0
  fi
  # The stack has started: from here the install stays as it is however this run ends,
  # an interruption while an address is asked included. Nothing it created is removed.
  CREATED=()
  say "Checking that the platform sees each address in its own role"
  if ! command -v curl >/dev/null 2>&1 && [ -n "$IMG_HOST" ]; then
    warn "curl is not installed, so the three addresses were not asked. Install it (apt-get install curl) and run: sudo bash $SELF status. Or open each in a browser: https://$DOMAIN/healthz must show \"address\":\"tours\", https://$APP_DOMAIN/healthz must show \"address\":\"app\" and https://$IMG_HOST/healthz must show \"address\":\"img\"."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl is not installed, so the two addresses were not asked. Install it (apt-get install curl) and run: sudo bash $SELF status. Or open both in a browser: https://$DOMAIN/healthz must show \"address\":\"tours\" and https://$APP_DOMAIN/healthz must show \"address\":\"app\"."
    return 0
  fi
  check_role "$DOMAIN" tours "$tries" || bad=1
  check_role "$APP_DOMAIN" app "$tries" || bad=1
  if [ -n "$IMG_HOST" ] && [ "$SKIP_IMG_CHECK" = 0 ]; then check_role "$IMG_HOST" img "$tries" || bad=1; fi
  [ "$bad" = 1 ] || return 0
  exit 1
}

# Asks one address for /healthz: check_role <host> <role> <tries>. Returns 1 only when
# the address answered and the platform does not report that role for it. In direct
# mode a name is asked only while it resolves to this server: otherwise the request
# would go to another machine, and Caddy has no certificate for the name yet. An address
# that does not answer is reported and is no failure: its certificate or its published
# application may not be there yet. The address is a host name from .env; nothing
# secret is on the command line.
check_role() {
  local host="$1" role="$2" tries="$3" url body n
  url="https://$host/healthz"
  if [ "$MODE" != tunnel ] && ! resolves_here "$host"; then
    warn "$url was not asked: $host does not resolve to an address of this server (not yet, or this server is behind a router). Open it in a browser instead: it must show \"address\":\"$role\"."
    return 0
  fi
  # -q comes first, so that root's curl settings file is not read.
  info "\$ curl -q --proto =https --tlsv1.2 -fsS --max-time 8 $url"
  for ((n = 1; n <= tries; n++)); do
    body=""
    if body="$(curl -q --proto '=https' --tlsv1.2 -fsS --max-time 8 "$url" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]]; then
      if [[ "$body" == *"\"address\":\"$role\""* ]]; then
        info "$host is the platform's $role address"
        return 0
      fi
      # No role at all: an app from before two addresses answers like that, and so does
      # a current one for a host name that is neither of its two (or three). On the img
      # address, an app from before the img address does.
      if [[ "$body" != *'"address"'* ]] && [ "$role" = img ]; then
        printf 'ERROR: %s answered, but the platform running here is older than the img address, or IMG_HOST does not reach the app. Run: sudo bash %s update. If it is up to date already, the request reached it under another host name: check that nothing in front of the platform changes the Host header.\n' "$url" "$SELF" >&2
        return 1
      fi
      if [[ "$body" != *'"address"'* ]]; then
        printf 'ERROR: %s answered, but the platform running here is older than two addresses. Run: sudo bash %s update. If it is up to date already, the request reached it under another host name: check that nothing in front of the platform changes the Host header.\n' "$url" "$SELF" >&2
        return 1
      fi
      if [ -n "$IMG_HOST" ]; then
        printf 'ERROR: %s answered, but the platform does not see it as its %s address. Check DOMAIN, APP_DOMAIN and IMG_HOST in %s, and that nothing in front of the platform changes the Host header.\n' "$url" "$role" "$LOGICAL_INSTALL_DIR/.env" >&2
        return 1
      fi
      printf 'ERROR: %s answered, but the platform does not see it as its %s address. Check DOMAIN and APP_DOMAIN in %s, and that nothing in front of the platform changes the Host header.\n' "$url" "$role" "$LOGICAL_INSTALL_DIR/.env" >&2
      return 1
    fi
    [ "$n" -ge "$tries" ] || sleep "$ROLE_PAUSE"
  done
  if [ "$MODE" = tunnel ]; then
    warn "$url did not answer. Check in Cloudflare's dashboard that the tunnel has a published application for $host with the service URL $TUNNEL_SERVICE_URL, then run: sudo bash $SELF status"
  else
    warn "$url did not answer. Caddy may still be getting the certificate for $host: check that ports 80 and 443 reach this server, then run: sudo bash $SELF status"
  fi
  return 0
}

cmd_install() {
  # Before any question or check: --new-token has nothing to replace without an install.
  if [ "$NEW_TOKEN" = 1 ] && [ ! -f "$ENV_FILE" ]; then
    die "nothing is installed on this machine ($LOGICAL_INSTALL_DIR/.env is missing), so there is no tunnel token to replace. Nothing was changed. To install in tunnel mode, run: sudo bash $SELF install --tunnel"
  fi
  say "Installing the demo platform"
  load_or_ask_config
  if [ "$MODE" = tunnel ] && [ -n "$IMG_HOST" ]; then
    info "Tunnel mode. Do these by hand, in Cloudflare's dashboard: create the tunnel, and give the tunnel a published application for each of $DOMAIN, $APP_DOMAIN and $IMG_HOST, all with the service URL $TUNNEL_SERVICE_URL."
  elif [ -n "$IMG_HOST" ]; then
    info "Do these by hand first: point the DNS records of $DOMAIN, $APP_DOMAIN and $IMG_HOST at this server and open ports 80 and 443 to it."
  elif [ "$MODE" = tunnel ] && [ -n "$APP_DOMAIN" ]; then
    info "Tunnel mode. Do these by hand, in Cloudflare's dashboard: create the tunnel, and give the tunnel a published application for each of $DOMAIN and $APP_DOMAIN, both with the service URL $TUNNEL_SERVICE_URL."
  elif [ "$MODE" = tunnel ]; then
    info "Tunnel mode. Do these by hand, in Cloudflare's dashboard: create the tunnel, and give it a published application for $DOMAIN with the service URL $TUNNEL_SERVICE_URL."
  elif [ -n "$APP_DOMAIN" ]; then
    info "Do these by hand first: point the DNS records of $DOMAIN and $APP_DOMAIN at this server and open ports 80 and 443 to it."
  else
    info "Do these by hand first: point the domain's DNS record at this server and open ports 80 and 443 to it."
  fi
  if [ "$FIRST_RUN" = 1 ]; then
    say "About to install"
    info "domain:      $DOMAIN"
    if [ -n "$APP_DOMAIN" ]; then
      info "app address: $APP_DOMAIN (the domain above is then the address of the tours)"
    fi
    if [ -n "$IMG_HOST" ]; then
      info "img address: $IMG_HOST (for shared images and clips)"
    fi
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
    if [ -n "$APP_DOMAIN" ]; then info "and so does the one for $APP_DOMAIN"; fi
    if [ -n "$IMG_HOST" ]; then info "and so does the one for $IMG_HOST"; fi
  else
    check_ports
    check_dns "$DOMAIN"
    if [ -n "$APP_DOMAIN" ]; then check_dns "$APP_DOMAIN"; fi
    if [ -n "$IMG_HOST" ]; then check_dns "$IMG_HOST"; fi
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
  check_roles "$ROLE_TRIES"
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
  # Noted before anything can stop this command, so that every way out of it repeats
  # what to run (on_exit). update never removes the file: only an install run confirms
  # the tunnel, and it is the one that prints the setup code.
  if [ -f "$ENV_FILE" ] && [ -e "$PENDING_FILE" ]; then UNFINISHED=1; fi
  require_installed
  [ "$MODE" = tunnel ] || UNFINISHED=0
  if [ "$UNFINISHED" = 1 ]; then
    warn "this install was never finished: its tunnel has not connected to Cloudflare yet. update leaves that as it is; what to run is repeated at the end."
  fi
  check_recorded_data strict
  # update starts the stack from the files on disk and writes none of them.
  if ! caddyfile_matches_addresses; then
    if [ -n "$APP_DOMAIN" ]; then
      die "$ENV_FILE holds APP_DOMAIN=$APP_DOMAIN, but the Caddyfile here was written for one address, and update does not rewrite it. Nothing was changed. Run: sudo bash $SELF install"
    fi
    die "$ENV_FILE holds no APP_DOMAIN, but the Caddyfile here was written for two addresses, and update does not rewrite it. Nothing was changed. Run: sudo bash $SELF install"
  fi
  local found_img
  found_img="$(caddyfile_img_name)"
  if [ "$found_img" != "$IMG_HOST" ]; then
    if [ -n "$IMG_HOST" ]; then
      die "$ENV_FILE holds IMG_HOST=$IMG_HOST, but the Caddyfile here does not answer for that name, and update does not rewrite it. Nothing was changed. Run: sudo bash $SELF install"
    fi
    # Also a name the owner added to the Caddyfile by hand: install would replace that
    # edit, so the message says so before anyone runs it.
    die "$ENV_FILE holds no IMG_HOST, but the Caddyfile here answers for a third name, $found_img, and update does not rewrite it. Nothing was changed. If that name was added to the Caddyfile by hand, install writes the Caddyfile for the addresses in .env and so replaces that edit (it keeps the edited file as a .bak copy); to keep the name as the img address, add IMG_HOST=$found_img to .env first. Then run: sudo bash $SELF install"
  fi
  refuse_snap
  check_docker_ready
  # A hand-written IMG_HOST line that read_env_file does not take but Compose does would
  # give the app a third address the Caddyfile does not answer for: checked here too,
  # since update writes no file and starts the stack as it is.
  # A dry run asks nothing, as install's does not.
  [ "$DRY_RUN" = 1 ] || check_rendered_addresses "$COMPOSE_FILE" img-only
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
  check_roles "$ROLE_TRIES"
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
  if [ -n "$APP_DOMAIN" ]; then
    info "app address: https://$APP_DOMAIN (the address above is the address of the tours)"
  fi
  if [ -n "$IMG_HOST" ]; then
    info "img address: https://$IMG_HOST (for shared images and clips)"
  fi
  if [ "$MODE" = tunnel ] && [ -n "$IMG_HOST" ]; then
    info "mode: behind a Cloudflare Tunnel; no port is published. The tunnel has a published application for each of $DOMAIN, $APP_DOMAIN and $IMG_HOST, all with the service URL $TUNNEL_SERVICE_URL"
  elif [ "$MODE" = tunnel ] && [ -n "$APP_DOMAIN" ]; then
    info "mode: behind a Cloudflare Tunnel; no port is published. The tunnel has a published application for each of $DOMAIN and $APP_DOMAIN, both with the service URL $TUNNEL_SERVICE_URL"
  elif [ "$MODE" = tunnel ]; then
    info "mode: behind a Cloudflare Tunnel; no port is published. The tunnel's published application for $DOMAIN has the service URL $TUNNEL_SERVICE_URL"
  fi
  # .env and the Caddyfile disagree on the img address (a line added, changed or removed
  # by hand without an install run since): said as such, and that address is not asked,
  # since its answer would only point at a certificate.
  local found_img
  found_img="$(caddyfile_img_name)"
  if [ "$found_img" != "$IMG_HOST" ] && [ -n "$IMG_HOST" ]; then
    warn "the Caddyfile here does not answer for IMG_HOST=$IMG_HOST in $LOGICAL_INSTALL_DIR/.env, so the img address cannot work yet. Run: sudo bash $SELF install"
    SKIP_IMG_CHECK=1
  elif [ "$found_img" != "$IMG_HOST" ]; then
    warn "the Caddyfile here answers for a third name, $found_img, that $LOGICAL_INSTALL_DIR/.env does not hold as IMG_HOST. Run: sudo bash $SELF install"
  fi
  check_roles 1
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

# Exact copies of deploy/docker-compose.yml, deploy/caddy/Caddyfile and, for two
# addresses, deploy/caddy/Caddyfile.two (direct mode), so the script works on its own;
# deploy/test-install.sh fails if they, or the tunnel mode copies further down, drift
# apart from the files in deploy/.
compose_file_content() {
  cat <<'DP_COMPOSE_END'
# The container stack: the app behind Caddy, which ends HTTPS and is the only service
# with published ports. Run from the folder holding this file, a .env file and the
# caddy/ folder: docker compose up -d
#
# .env (mode 600, never committed) holds DOMAIN, ACME_EMAIL, DATA_DIR (a host folder
# owned by id 1001), APP_IMAGE and SETUP_CODE. With a second address, for the app, it
# also holds APP_DOMAIN; DOMAIN is then the address of the tours, and caddy/Caddyfile
# is the two-address one (deploy/caddy/Caddyfile.two).

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
      # The two addresses the app answers on, each in its own role. Both are empty
      # without APP_DOMAIN in .env, which is one address: every host is answered.
      TOURS_HOST: ${APP_DOMAIN:+${DOMAIN}}
      APP_HOST: ${APP_DOMAIN:-}
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
      # Read only by the two-address Caddyfile, as {$APP_DOMAIN}.
      APP_DOMAIN: ${APP_DOMAIN:-}
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

# The same file with one more name in the site address: Caddy gets a certificate for
# each. Written instead of the one above when .env has an APP_DOMAIN.
caddyfile_two_content() {
  cat <<'DP_CADDYFILE_TWO_END'
# Caddy gets and renews the certificate for DOMAIN by itself once the domain's DNS
# record points at this server and ports 80 and 443 are reachable. ACME_EMAIL is the
# contact address for the certificate authority. Both come from the stack's .env.
{
	email {$ACME_EMAIL}
}

{$DOMAIN}, {$APP_DOMAIN} {
	# Browsers keep to HTTPS for this host for one week. No subdomains, no preload list.
	header Strict-Transport-Security "max-age=604800"

	# Caddy passes the Host header through unchanged, which the setup wizard's
	# same-origin check compares against the page's Origin.
	reverse_proxy app:3000
}
DP_CADDYFILE_TWO_END
}

# Exact copies of deploy/tunnel/docker-compose.yml, deploy/tunnel/caddy/Caddyfile and,
# for two addresses, deploy/tunnel/caddy/Caddyfile.two, written instead of the three
# above in tunnel mode.
tunnel_compose_file_content() {
  cat <<'DP_TUNNEL_COMPOSE_END'
# The container stack behind a Cloudflare Tunnel: the app behind Caddy, and cloudflared,
# which connects out to Cloudflare and hands each request to Caddy over plain HTTP on
# the stack's own network. No service publishes a port on the host. Run from the folder
# holding this file, a .env file and the caddy/ folder: docker compose up -d
#
# .env (mode 600, never committed) holds DOMAIN, DEPLOY_MODE=tunnel, DATA_DIR (a host
# folder owned by id 1001), APP_IMAGE, SETUP_CODE and TUNNEL_TOKEN. With a second
# address, for the app, it also holds APP_DOMAIN; DOMAIN is then the address of the
# tours, and caddy/Caddyfile is the two-address one (deploy/tunnel/caddy/Caddyfile.two).
#
# In Cloudflare's dashboard the tunnel's published application for DOMAIN has the
# service URL http://caddy:80, and so has the one for APP_DOMAIN when there is one.

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
      # The two addresses the app answers on, each in its own role. Both are empty
      # without APP_DOMAIN in .env, which is one address: every host is answered.
      TOURS_HOST: ${APP_DOMAIN:+${DOMAIN}}
      APP_HOST: ${APP_DOMAIN:-}
      # Optional settings, each empty unless .env has a line for it; the app reads an
      # empty one as not set. The storage allowance of a workspace, in bytes.
      STORAGE_ALLOWANCE_BYTES: ${STORAGE_ALLOWANCE_BYTES:-}
      # Who to ask for an invite, shown on the sign-in page: an email address or an https address.
      INVITE_CONTACT: ${INVITE_CONTACT:-}
      # The public page the desktop app is downloaded from, linked on the dashboard: an https address.
      DOWNLOAD_URL: ${DOWNLOAD_URL:-}
      # The sign-in lifetimes in whole days, each 0 or off to switch it off: a browser session
      # ends this long after its sign-in (default 90), a connection from Mythicshot stops after
      # this long unused (default 90) or this long after it was made (default off).
      SESSION_MAX_DAYS: ${SESSION_MAX_DAYS:-}
      CONNECTION_IDLE_DAYS: ${CONNECTION_IDLE_DAYS:-}
      CONNECTION_MAX_DAYS: ${CONNECTION_MAX_DAYS:-}
      # The optional third address, for shared images and clips, beside the two above.
      # The stack does not add it to Caddy's site address: see the runbook first.
      IMG_HOST: ${IMG_HOST:-}
      # Mail: off unless MAIL_MODE is smtp; then the sender, the mail server, its port
      # (465 when empty) and the mailbox's sign-in. SMTP_PASSWORD is a secret, like
      # SETUP_CODE: it lives in .env only.
      MAIL_MODE: ${MAIL_MODE:-}
      MAIL_FROM: ${MAIL_FROM:-}
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      # The host name sign-in links use on one address (with two, the app address is used).
      SITE_HOST: ${SITE_HOST:-}
      # The header in which a proxy writes the visitor's address, for rate limits only.
      CLIENT_ADDRESS_HEADER: ${CLIENT_ADDRESS_HEADER:-}
      # Read by the admin command only, run here with docker compose exec, never by the app.
      RECOVERY_LINKS: ${RECOVERY_LINKS:-}
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
      # Read only by the two-address Caddyfile, as {$APP_DOMAIN}.
      APP_DOMAIN: ${APP_DOMAIN:-}
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

# The same file with one more name in the site address. A separate file, not an
# optional name in the one above: an empty name after http:// would match every host.
tunnel_caddyfile_two_content() {
  cat <<'DP_TUNNEL_CADDYFILE_TWO_END'
# Behind a Cloudflare Tunnel: Cloudflare ends HTTPS for DOMAIN, and cloudflared, the only
# client that can reach this server, sends each request here as plain HTTP with the
# visitor's Host header unchanged. DOMAIN comes from the stack's .env.
{
	# No certificate is requested and nothing listens on port 443.
	auto_https off
}

http://{$DOMAIN}, http://{$APP_DOMAIN} {
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
DP_TUNNEL_CADDYFILE_TWO_END
}

# ---------------------------------------------------------------- main

main() {
  parse_args "$@"
  require_root
  check_os
  trap on_exit EXIT
  # Ctrl-C, a closed terminal or a kill ends the run through on_exit as well.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    status) cmd_status ;;
    uninstall) cmd_uninstall ;;
  esac
}

if [ "${DP_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi

#!/usr/bin/env bash
# Installs and runs the demo platform on Debian: the app container behind Caddy, which
# gets and renews the HTTPS certificate by itself.
#
#   sudo bash install.sh [install|update|backup|status|uninstall] [--dry-run] [--yes]
#                        [--force] [--delete-data]
#
# Pages checked on 2026-11-17 for what this script does:
#   Debian releases (13 "trixie" is stable, 12 "bookworm" is oldstable):
#     https://www.debian.org/releases/
#   Docker Engine on Debian (the apt repository, its key, the sources file, the packages
#   and the unofficial packages that conflict with them):
#     https://docs.docker.com/engine/install/debian/
#
# Before running it, by hand: point the domain's DNS record at this server and open
# ports 80 and 443 to it. Everything else is done here.
#
# Safety rules this script keeps:
# - It never removes or overwrites the data folder, the .env file or a backup. The one
#   exception is `uninstall --delete-data`, after the exact domain name is typed;
#   --yes does not skip that.
# - Every rm, mv and overwrite goes through guard_path, which refuses an empty path, /,
#   and anything outside the install folder and the data folder (plus Docker's apt key
#   and sources file, while installing Docker). Replaced files are backed up first.
# - Files are written to a temporary file and moved into place, so a failed run leaves
#   the previous files; if starting the stack fails, files it replaced are restored.
# - The setup code is generated here, written only to .env (mode 600, root), printed
#   once at the end, and never logged or passed as a command argument.
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

DP_ROOT="${DP_ROOT:-}"
case "$DP_ROOT" in
  "") ;;
  /*) DP_ROOT="${DP_ROOT%/}"
      [ -n "$DP_ROOT" ] || { echo "ERROR: DP_ROOT must not be /" >&2; exit 1; } ;;
  *) echo "ERROR: DP_ROOT must be an absolute path" >&2; exit 1 ;;
esac

INSTALL_DIR="$DP_ROOT$LOGICAL_INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
CADDY_DIR="$INSTALL_DIR/caddy"
CADDYFILE="$CADDY_DIR/Caddyfile"
BACKUP_DIR="$INSTALL_DIR/backups"
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

DOMAIN=""
ACME_EMAIL=""
DATA_DIR=""   # the path as the host sees it, without DP_ROOT; stored in .env
DATA_PATH=""  # "$DP_ROOT$DATA_DIR", the path this script works on
IMAGE=""
FIRST_RUN=0
CADDY_CHANGED=0
STAGED=""
LAST_BACKUP=""
OS_ID="" OS_VERSION_ID="" OS_CODENAME="" OS_PRETTY=""
TMP_FILES=()
REPLACED=()

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
  update      Pull newer images and restart. Changes no file.
  backup      Write a backup archive of the database and files to the backups folder.
  status      Show the containers, the health check and the data folder's size.
  uninstall   Stop and remove the containers. The data folder and backups stay.

Options:
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
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $a" ;;
    esac
  done
  if [ "$DELETE_DATA" = 1 ] && [ "$COMMAND" != uninstall ]; then
    usage_error "--delete-data goes only with uninstall"
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

# An absolute path of plain characters, outside the system folders and not overlapping
# the install folder's own files.
valid_data_dir() {
  local p="$1" top
  [[ "$p" =~ ^(/[A-Za-z0-9._-]+)+$ ]] || return 1
  [ "${#p}" -le 200 ] || return 1
  [[ "$p/" != */./* && "$p/" != */../* ]] || return 1
  top="${p#/}"; top="${top%%/*}"
  case "$top" in
    bin | boot | dev | etc | lib | lib32 | lib64 | libx32 | proc | run | sbin | sys | tmp | usr) return 1 ;;
  esac
  case "$p" in
    /home | /media | /mnt | /opt | /root | /srv | /var | /var/tmp | /var/tmp/* | /var/run | /var/run/* | /var/lib/docker | /var/lib/docker/*) return 1 ;;
    "$LOGICAL_INSTALL_DIR" | "$LOGICAL_INSTALL_DIR"/caddy | "$LOGICAL_INSTALL_DIR"/caddy/* | \
    "$LOGICAL_INSTALL_DIR"/caddy-data | "$LOGICAL_INSTALL_DIR"/caddy-data/* | \
    "$LOGICAL_INSTALL_DIR"/caddy-config | "$LOGICAL_INSTALL_DIR"/caddy-config/* | \
    "$LOGICAL_INSTALL_DIR"/backups | "$LOGICAL_INSTALL_DIR"/backups/*) return 1 ;;
  esac
  # Not a parent of the install folder.
  [[ "$LOGICAL_INSTALL_DIR" != "$p"/* ]] || return 1
}

# An image reference such as demo-platform:latest or registry.example.com/x/y:1.2.
valid_image() {
  [ "${#1}" -le 255 ] && [[ "$1" =~ ^[a-z0-9][a-z0-9._/:@-]*$ ]]
}

# ---------------------------------------------------------------- the path guard

canon() { realpath -m -- "$1"; }
inside() { [ -n "$2" ] && { [ "$1" = "$2" ] || [[ "$1" == "$2"/* ]]; }; }

# Refuses (exits) unless the path, resolved, is inside the install folder or the data
# folder, or is one of Docker's two apt files.
guard_path() {
  local p="$1" real inst data=""
  [ -n "$p" ] || die "refusing an empty path"
  [[ "$p" == /* ]] || die "refusing a relative path: $p"
  [[ "$p/" != */./* && "$p/" != */../* ]] || die "refusing a path with . or ..: $p"
  real="$(canon "$p")"
  [ -n "$real" ] && [ "$real" != / ] || die "refusing to touch /"
  inst="$(canon "$INSTALL_DIR")"
  [ -z "$DATA_DIR" ] || data="$(canon "$DATA_PATH")"
  if inside "$real" "$inst" || inside "$real" "$data"; then return 0; fi
  if [ "$real" = "$(canon "$KEYRING")" ] || [ "$real" = "$(canon "$DOCKER_SOURCES")" ]; then return 0; fi
  die "refusing to touch $p: it is outside $INSTALL_DIR and the data folder"
}

safe_rm_file() {
  guard_path "$1"
  [ ! -d "$1" ] || die "refusing to remove a folder: $1"
  rm -f -- "$1"
}

safe_mv() { guard_path "$1"; guard_path "$2"; mv -f -- "$1" "$2"; }

# Hard-links a finished temporary file to a name that must not exist yet: never clobbers.
safe_link_new() { guard_path "$1"; guard_path "$2"; ln -- "$1" "$2"; }

cleanup() {
  local f
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    if [ -e "$f" ]; then safe_rm_file "$f"; fi
  done
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
COMMITTED=0
commit_file() {
  local target="$1" backup_dir="$2"
  COMMITTED=0
  if [ -e "$target" ] && cmp -s -- "$STAGED" "$target"; then
    info "$target is already up to date"
    safe_rm_file "$STAGED"
    return 0
  fi
  COMMITTED=1
  if [ -e "$target" ]; then
    backup_existing "$target" "$backup_dir"
    info "the old $target differs; saved it as $LAST_BACKUP"
    REPLACED+=("$target|$LAST_BACKUP")
  fi
  info "writing $target"
  safe_mv "$STAGED" "$target"
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

confirm() {
  local answer
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N]: ' "$1" >&2
  read_line answer || return 1
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
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
  local answer tries
  for tries in 1 2 3; do
    printf 'Data folder [%s]: ' "$DEFAULT_DATA_DIR" >&2
    read_line answer || die "no answer given; run the script in a terminal"
    [ -n "$answer" ] || answer="$DEFAULT_DATA_DIR"
    [ "$answer" = / ] || answer="${answer%/}"
    if valid_data_dir "$answer"; then DATA_DIR="$answer"; return 0; fi
    warn "use an absolute path of letters, digits, . _ - outside the system folders, such as /srv/demo-platform (try $tries of 3)"
  done
  die "no valid data folder given; nothing was changed"
}

# ---------------------------------------------------------------- system checks

require_root() {
  local uid
  uid="$(id -u)"
  [ "$uid" = 0 ] || die "this needs root. Run it as: sudo bash $0 $COMMAND"
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

have_docker() { docker compose version >/dev/null 2>&1; }

# The stack's own container for a service is running (so it may hold ports 80 and 443).
stack_running() {
  [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ] && have_docker || return 1
  [ -n "$("${DC[@]}" ps -q "$1" 2>/dev/null || true)" ]
}

check_ports() {
  say "Checking that ports 80 and 443 are free"
  if stack_running caddy; then info "the platform's own Caddy is using them; fine"; return 0; fi
  if ! command -v ss >/dev/null 2>&1; then
    warn "cannot check the ports: the ss command (package iproute2) is missing"
    return 0
  fi
  local busy="" out p
  for p in 80 443; do
    out="$(ss -Hltnp "sport = :$p" 2>/dev/null || true)"
    [ -z "$out" ] || busy+="  TCP port $p: $out"$'\n'
  done
  out="$(ss -Hlunp "sport = :443" 2>/dev/null || true)"
  [ -z "$out" ] || busy+="  UDP port 443: $out"$'\n'
  if [ -n "$busy" ]; then
    printf '%s' "$busy" >&2
    die "another program is listening on the ports above. Stop it (or move it to other ports) and run this again; nothing was changed."
  fi
  info "ports 80 and 443 are free"
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
  local line key value have_code=0
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
    esac
  done <"$ENV_FILE"
  valid_domain "$DOMAIN" || die "$ENV_FILE has no valid DOMAIN; fix it by hand, nothing was changed"
  valid_email "$ACME_EMAIL" || die "$ENV_FILE has no valid ACME_EMAIL; fix it by hand, nothing was changed"
  valid_data_dir "$DATA_DIR" || die "$ENV_FILE has no valid DATA_DIR; fix it by hand, nothing was changed"
  valid_image "$IMAGE" || die "$ENV_FILE has no valid APP_IMAGE; fix it by hand, nothing was changed"
  [ "$have_code" = 1 ] || die "$ENV_FILE has no SETUP_CODE; fix it by hand, nothing was changed"
  DATA_PATH="$DP_ROOT$DATA_DIR"
}

load_or_ask_config() {
  if [ -f "$ENV_FILE" ]; then
    say "Reading the earlier answers from $ENV_FILE"
    read_env_file
    info "domain $DOMAIN, email $ACME_EMAIL, data folder $DATA_DIR, image $IMAGE"
    return 0
  fi
  FIRST_RUN=1
  say "Three questions"
  ask_domain
  ask_email
  ask_data_dir
  DATA_PATH="$DP_ROOT$DATA_DIR"
  IMAGE="${APP_IMAGE:-$DEFAULT_APP_IMAGE}"
  valid_image "$IMAGE" || die "APP_IMAGE is not a valid image name"
}

require_installed() {
  [ -f "$ENV_FILE" ] || die "the platform is not installed here ($ENV_FILE is missing). Run: sudo bash $0 install"
  read_env_file
  [ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE is missing. Run: sudo bash $0 install"
}

# Holds a lock for the rest of the run, so two runs cannot interleave.
take_lock() {
  [ "$DRY_RUN" = 0 ] && [ -d "$INSTALL_DIR" ] || return 0
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>>"$INSTALL_DIR/.install.lock"
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
}

create_folders() {
  say "Creating $LOGICAL_INSTALL_DIR (root only) and the data folder $DATA_DIR (owned by id $APP_UID, private)"
  make_dir "$INSTALL_DIR" 0700 0
  make_dir "$CADDY_DIR" 0700 0
  make_dir "$BACKUP_DIR" 0700 0
  if [ -d "$DATA_PATH" ]; then
    info "$DATA_DIR exists; left as it is"
    local owner
    owner="$(stat -c %u -- "$DATA_PATH")"
    [ "$owner" = "$APP_UID" ] || warn "$DATA_DIR is owned by id $owner, not $APP_UID, so the app cannot write to it. Fix with: chown -R $APP_UID:$APP_UID $DATA_DIR"
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

install_docker() {
  if have_docker; then say "Docker with the Compose plugin is already installed"; return 0; fi
  say "Installing Docker Engine and the Compose plugin from Docker's apt repository"
  export DEBIAN_FRONTEND=noninteractive
  check_conflicting_packages
  run apt-get update
  run apt-get install -y ca-certificates curl
  run install -m 0755 -d -- "$KEYRING_DIR"
  if [ "$DRY_RUN" = 1 ]; then
    run curl -fsSL https://download.docker.com/linux/debian/gpg -o "$KEYRING"
    run chmod a+r -- "$KEYRING"
    info "would write $DOCKER_SOURCES for $OS_CODENAME"
  else
    local key arch
    key="$(mktemp -- "$INSTALL_DIR/.docker.asc.XXXXXX")"
    TMP_FILES+=("$key")
    run curl -fsSL https://download.docker.com/linux/debian/gpg -o "$key"
    grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$key" || die "the download from download.docker.com is not a key; nothing was installed"
    stage_file "$KEYRING" 0644 "$INSTALL_DIR" <"$key"
    commit_file "$KEYRING" "$BACKUP_DIR"
    run chmod a+r -- "$KEYRING"
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
  run apt-get update
  run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  [ "$DRY_RUN" = 1 ] || have_docker || die "Docker was installed but 'docker compose version' still fails"
}

write_env_file() {
  if [ -e "$ENV_FILE" ]; then
    say "Keeping $ENV_FILE as it is (the setup code does not change)"
    return 0
  fi
  say "Writing $ENV_FILE (mode 600, root only) with a new setup code"
  if [ "$DRY_RUN" = 1 ]; then
    info "would write DOMAIN, ACME_EMAIL, DATA_DIR, APP_IMAGE and a new SETUP_CODE to $ENV_FILE"
    return 0
  fi
  local tmp code
  tmp="$(mktemp -- "$INSTALL_DIR/.env.new.XXXXXX")"
  TMP_FILES+=("$tmp")
  guard_path "$tmp"
  code="$(new_setup_code)"
  [[ "$code" =~ ^[0-9a-f]{32}$ ]] || die "could not read random bytes from /dev/urandom"
  {
    printf '# Written by install.sh. Root only: SETUP_CODE claims this install. Never share or commit.\n'
    printf 'DOMAIN=%s\n' "$DOMAIN"
    printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'APP_IMAGE=%s\n' "$IMAGE"
    printf 'SETUP_CODE=%s\n' "$code"
  } >"$tmp"
  code=""
  chmod 600 -- "$tmp"
  chown 0:0 -- "$tmp"
  safe_link_new "$tmp" "$ENV_FILE"
  safe_rm_file "$tmp"
}

install_stack_files() {
  say "Writing $COMPOSE_FILE and $CADDYFILE (the domain and email come from .env)"
  if [ "$DRY_RUN" = 1 ]; then
    local f
    for f in "$COMPOSE_FILE" "$CADDYFILE"; do
      if [ -e "$f" ]; then info "would compare $f and, if it differs, save it as .bak-<timestamp> and replace it"
      else info "would write $f"; fi
    done
    return 0
  fi
  stage_file "$COMPOSE_FILE" 0600 < <(compose_file_content)
  local staged_compose="$STAGED"
  run docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$staged_compose" config --quiet \
    || die "the new compose file does not validate; nothing was replaced"
  STAGED="$staged_compose"
  commit_file "$COMPOSE_FILE" "$INSTALL_DIR"
  stage_file "$CADDYFILE" 0600 < <(caddyfile_content)
  commit_file "$CADDYFILE" "$CADDY_DIR"
  CADDY_CHANGED="$COMMITTED"
}

start_stack() {
  local caddy_was_running=0
  if stack_running caddy; then caddy_was_running=1; fi
  say "Starting the platform: pulling any image not on this server yet, then waiting up to ${WAIT_SECONDS}s for it to report healthy"
  if ! run "${DC[@]}" up -d --pull missing --wait --wait-timeout "$WAIT_SECONDS"; then
    warn "the platform did not start"
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

print_setup_code() {
  local line code=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in SETUP_CODE=*) code="${line#SETUP_CODE=}" ;; esac
  done <"$ENV_FILE"
  printf '\nThe platform is running.\n\n'
  printf '  Open:        https://%s/setup\n' "$DOMAIN"
  printf '  Setup code:  %s\n\n' "$code"
  printf 'The code is kept only in %s (root only). Whoever enters it first becomes the owner; once setup is finished it opens nothing.\n' "$ENV_FILE"
}

cmd_install() {
  say "Installing the demo platform"
  info "Do these by hand first: point the domain's DNS record at this server and open ports 80 and 443 to it."
  load_or_ask_config
  if [ "$FIRST_RUN" = 1 ]; then
    say "About to install"
    info "domain:      $DOMAIN"
    info "email:       $ACME_EMAIL"
    info "data folder: $DATA_DIR"
    info "image:       $IMAGE"
    info "folder:      $LOGICAL_INSTALL_DIR"
    confirm "Continue?" || die "cancelled; nothing was changed"
  fi
  check_ports
  check_dns
  create_folders
  take_lock
  install_docker
  write_env_file
  install_stack_files
  start_stack
  if [ "$DRY_RUN" = 1 ]; then say "Dry run finished: nothing was changed"; return 0; fi
  print_setup_code
}

# ---------------------------------------------------------------- other commands

cmd_update() {
  require_installed
  take_lock
  say "Pulling newer images"
  run "${DC[@]}" pull || die "pulling failed; nothing was changed. If APP_IMAGE is an image loaded by hand, load the new one with docker load and run: ${DC[*]} up -d"
  say "Restarting on the new images (waiting up to ${WAIT_SECONDS}s for health)"
  run "${DC[@]}" up -d --wait --wait-timeout "$WAIT_SECONDS" || die "the platform did not report healthy. The data folder and $ENV_FILE were not changed. See: ${DC[*]} logs"
  say "Updated"
}

cmd_backup() {
  require_installed
  take_lock
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
    || die "the database copy failed; is the platform running? Check with: sudo bash $0 status"
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
  say "Data folder"
  if [ -d "$DATA_PATH" ]; then du -sh -- "$DATA_PATH" || true; else warn "$DATA_DIR is missing"; fi
  info "address: https://$DOMAIN"
}

delete_data_folder() {
  local real inst
  guard_path "$DATA_PATH"
  [ ! -L "$DATA_PATH" ] || die "refusing: $DATA_DIR is a symbolic link"
  real="$(canon "$DATA_PATH")"
  inst="$(canon "$INSTALL_DIR")"
  [ "$real" != / ] && [ "$real" != "$inst" ] || die "refusing to delete $real"
  ! inside "$inst" "$real" || die "refusing: $DATA_DIR contains the install folder"
  valid_data_dir "$DATA_DIR" || die "refusing: $DATA_DIR is not a valid data folder"
  say "Deleting $DATA_DIR"
  run rm -rf --one-file-system -- "$DATA_PATH"
}

cmd_uninstall() {
  require_installed
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
  [ ! -e "$DATA_PATH" ] || info "data folder:  $DATA_DIR"
  info "settings:     $LOGICAL_INSTALL_DIR/.env (holds the setup code; root only)"
  info "backups:      $LOGICAL_INSTALL_DIR/backups"
  info "Run install again to start it on the same data."
}

# ---------------------------------------------------------------- embedded stack files

# Exact copies of deploy/docker-compose.yml and deploy/caddy/Caddyfile, so the script
# works on its own; deploy/test-install.sh fails if they drift apart.
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

# ---------------------------------------------------------------- main

main() {
  parse_args "$@"
  require_root
  check_os
  trap cleanup EXIT
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    status) cmd_status ;;
    uninstall) cmd_uninstall ;;
  esac
}

if [ "${DP_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi

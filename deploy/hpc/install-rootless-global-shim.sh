#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "install-rootless-global-shim.sh must run as root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <rootless-install-root> [service-username] [root-cli] [global-launcher]" >&2
  exit 1
fi

install_root=$1
service_username=${2:-codexeverywhere}
root_cli=${3:-}
global_launcher=${4:-/usr/local/bin/ce}

assert_root_owned_directory_chain() {
  candidate=$1
  while :; do
    if [ ! -d "$candidate" ] || [ -L "$candidate" ]; then
      echo "Root execution path contains an unsafe directory: $candidate" >&2
      exit 1
    fi
    if [ "$(stat -c %u "$candidate")" -ne 0 ]; then
      echo "Root execution path directory must be owned by root: $candidate" >&2
      exit 1
    fi
    if find "$candidate" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
      echo "Root execution path directory must not be group/world writable: $candidate" >&2
      exit 1
    fi
    if [ "$candidate" = / ]; then break; fi
    candidate=$(dirname "$candidate")
  done
}

script_path=$(readlink -f "$0")
if [ "$(stat -c %u "$script_path")" -ne 0 ] ||
  find "$script_path" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Global shim installer must be a root-owned, non-writable file: $script_path" >&2
  exit 1
fi
assert_root_owned_directory_chain "$(dirname "$script_path")"
case "$install_root" in
  /*) ;;
  *)
    echo "Install root must be absolute" >&2
    exit 1
    ;;
esac
case "$install_root" in
  *[!A-Za-z0-9_./:-]*)
    echo "Install root contains unsupported characters" >&2
    exit 1
    ;;
esac
case "$service_username" in
  [A-Za-z_]*) ;;
  *)
    echo "Service username is invalid" >&2
    exit 1
    ;;
esac
case "$service_username" in
  *[!A-Za-z0-9_.-]*)
    echo "Service username is invalid" >&2
    exit 1
    ;;
esac
case "$global_launcher" in
  /*) ;;
  *)
    echo "Global launcher path must be absolute" >&2
    exit 1
    ;;
esac
case "$global_launcher" in
  *[!A-Za-z0-9_./:-]*)
    echo "Global launcher path contains unsupported characters" >&2
    exit 1
    ;;
esac

service_uid=$(id -u "$service_username")
if [ "$service_uid" -eq 0 ]; then
  echo "Deployment account must not be root" >&2
  exit 1
fi
if [ ! -x "$install_root/bin/ce" ]; then
  echo "Rootless shared CLI is missing: $install_root/bin/ce" >&2
  exit 1
fi
if [ "$(stat -c %u "$install_root")" -ne "$service_uid" ]; then
  echo "Rootless install root is not owned by $service_username" >&2
  exit 1
fi
if [ -n "$root_cli" ]; then
  case "$root_cli" in
    /*) ;;
    *)
      echo "Root CLI path must be absolute" >&2
      exit 1
      ;;
  esac
  case "$root_cli" in
    *[!A-Za-z0-9_./:-]*)
      echo "Root CLI path contains unsupported characters" >&2
      exit 1
      ;;
  esac
  root_cli=$(readlink -f "$root_cli")
  if [ ! -f "$root_cli" ] || [ -L "$root_cli" ] || [ ! -x "$root_cli" ]; then
    echo "Root CLI must be a regular executable file: $root_cli" >&2
    exit 1
  fi
  if [ "$(stat -c %u "$root_cli")" -ne 0 ]; then
    echo "Root CLI must be owned by root: $root_cli" >&2
    exit 1
  fi
  if find "$root_cli" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
    echo "Root CLI must not be group/world writable: $root_cli" >&2
    exit 1
  fi
  assert_root_owned_directory_chain "$(dirname "$root_cli")"
fi

launcher_directory=$(readlink -f "$(dirname "$global_launcher")")
global_launcher=$launcher_directory/$(basename "$global_launcher")
assert_root_owned_directory_chain "$launcher_directory"

wrapper=$(mktemp "$launcher_directory/.ce.XXXXXX")
trap 'rm -f "$wrapper"' EXIT HUP INT TERM
if [ -n "$root_cli" ]; then
  cat >"$wrapper" <<EOF
#!/bin/sh
if [ "\$(id -u)" -eq 0 ]; then
  exec '$root_cli' "\$@"
fi
exec '$install_root/bin/ce' "\$@"
EOF
else
  cat >"$wrapper" <<EOF
#!/bin/sh
if [ "\$(id -u)" -eq 0 ]; then
  echo "The shared ce launcher refuses to execute deployment-account code as root." >&2
  exit 126
fi
exec '$install_root/bin/ce' "\$@"
EOF
fi
chown root:root "$wrapper"
chmod 0755 "$wrapper"
mv "$wrapper" "$global_launcher"
trap - EXIT HUP INT TERM

echo "Installed permanent root-safe global ce launcher: $global_launcher"
if [ -n "$root_cli" ]; then
  echo "Root commands use the separately installed root-owned CLI: $root_cli"
fi

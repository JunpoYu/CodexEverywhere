#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-rootless-global-shim.sh is the final one-time root step" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <rootless-install-root> [service-username]" >&2
  exit 1
fi

install_root=$1
service_username=${2:-codexeverywhere}
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

wrapper=$(mktemp /usr/local/bin/.ce.XXXXXX)
trap 'rm -f "$wrapper"' EXIT HUP INT TERM
cat >"$wrapper" <<EOF
#!/bin/sh
if [ "\$(id -u)" -eq 0 ]; then
  echo "The shared ce launcher refuses to execute deployment-account code as root." >&2
  exit 126
fi
exec '$install_root/bin/ce' "\$@"
EOF
chown root:root "$wrapper"
chmod 0755 "$wrapper"
mv "$wrapper" /usr/local/bin/ce
trap - EXIT HUP INT TERM

echo "Installed permanent root-safe global ce launcher: /usr/local/bin/ce"

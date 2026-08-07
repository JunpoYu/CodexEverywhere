#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-shared-agent.sh must run as root" >&2
  exit 1
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <agent-bundle> <release-id> [install-root] [runtime-directory]" >&2
  exit 1
fi

agent_bundle=$1
release_id=$2
install_root=${3:-/public/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
release_directory=$install_root/releases/$release_id
staging_directory=$install_root/releases/.$release_id.staging

if [ -z "$release_id" ]; then
  echo "Release ID must not be empty" >&2
  exit 1
fi

case "$install_root:$runtime_directory:$release_id" in
  /*:/*:*[!A-Za-z0-9._-]*)
    echo "Install paths must be absolute and release-id must be path-safe" >&2
    exit 1
    ;;
  /*:/*:*) ;;
  *)
    echo "Install paths must be absolute and release-id must be path-safe" >&2
    exit 1
    ;;
esac

if [ ! -f "$agent_bundle/dist/cli.js" ]; then
  echo "Agent bundle does not contain dist/cli.js: $agent_bundle" >&2
  exit 1
fi
if [ ! -x "$runtime_directory/bin/node" ]; then
  echo "Shared Node.js runtime is missing: $runtime_directory/bin/node" >&2
  exit 1
fi
if [ -e "$release_directory" ] || [ -e "$staging_directory" ]; then
  echo "Release already exists: $release_id" >&2
  exit 1
fi

mkdir -p "$install_root/releases" /usr/local/bin /usr/local/libexec /etc/sudoers.d
mkdir "$staging_directory"

wrapper=$(mktemp /usr/local/bin/.ce.XXXXXX)
helper=$(mktemp /usr/local/libexec/.ce-self-provision.XXXXXX)
sudoers=$(mktemp /etc/sudoers.d/.codex-everywhere-self-provision.XXXXXX)
trap 'rm -f "$wrapper" "$helper" "$sudoers"; rm -rf "$staging_directory"' EXIT HUP INT TERM
cat >"$wrapper" <<EOF
#!/bin/sh
PATH='$runtime_directory/bin':"\$PATH"
export PATH
exec '$runtime_directory/bin/node' '$install_root/current/dist/cli.js' "\$@"
EOF
cat >"$helper" <<EOF
#!/bin/sh
set -eu
if [ "\$#" -ne 0 ]; then
  echo "ce-self-provision does not accept arguments" >&2
  exit 2
fi
exec /usr/bin/env -i \
  HOME=/root \
  LOGNAME=root \
  PATH='/usr/bin:/bin' \
  SUDO_UID="\${SUDO_UID-}" \
  SUDO_USER="\${SUDO_USER-}" \
  USER=root \
  '$runtime_directory/bin/node' '$install_root/current/dist/cli.js' admin self-provision
EOF
cat >"$sudoers" <<'EOF'
ALL ALL=(root) NOPASSWD: /usr/local/libexec/ce-self-provision
EOF

if [ ! -x /usr/sbin/visudo ]; then
  echo "visudo is required to install the self-service provisioner" >&2
  exit 1
fi
/usr/sbin/visudo -cf "$sudoers" >/dev/null

rsync -a "$agent_bundle/" "$staging_directory/"
chown -R root:root "$staging_directory"
chmod -R u+rwX,go+rX,go-w "$staging_directory"
chown root:root "$wrapper"
chmod 0755 "$wrapper"
chown root:root "$helper"
chmod 0755 "$helper"
chown root:root "$sudoers"
chmod 0440 "$sudoers"

mv "$staging_directory" "$release_directory"
mv "$wrapper" /usr/local/bin/ce
mv "$helper" /usr/local/libexec/ce-self-provision
mv "$sudoers" /etc/sudoers.d/codex-everywhere-self-provision
ln -sfn "releases/$release_id" "$install_root/current"
trap - EXIT HUP INT TERM

echo "Shared Agent installed: $release_directory"
echo "CLI: /usr/local/bin/ce"
echo "Self-service helper: /usr/local/libexec/ce-self-provision"

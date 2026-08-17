#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "install-shared-agent.sh must run as root" >&2
  exit 1
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 <agent-bundle> <release-id> [install-root] [runtime-directory] [development|verified]" >&2
  exit 1
fi

agent_bundle=$1
release_id=$2
install_root=${3:-/public/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
release_kind=${5:-development}
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
case "$release_kind" in
  development) inventory_requirement=any ;;
  verified) inventory_requirement=verified ;;
  *)
    echo "Release kind must be development or verified" >&2
    exit 1
    ;;
esac
script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
inventory_tool=$script_directory/verify-rootless-release.mjs
script_path=$(readlink -f "$0")
if [ "$(stat -c %u "$script_path")" -ne 0 ] ||
  find "$script_path" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Privileged installer must be a root-owned, non-writable file: $script_path" >&2
  exit 1
fi
trusted_directory=$script_directory
while :; do
  if [ "$(stat -c %u "$trusted_directory")" -ne 0 ] ||
    find "$trusted_directory" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
    echo "Privileged installer path is not trusted: $trusted_directory" >&2
    exit 1
  fi
  if [ "$trusted_directory" = / ]; then break; fi
  trusted_directory=$(dirname "$trusted_directory")
done
if [ ! -f "$inventory_tool" ] || [ -L "$inventory_tool" ] ||
  [ "$(stat -c %u "$inventory_tool")" -ne 0 ] ||
  find "$inventory_tool" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Missing release inventory verifier: $inventory_tool" >&2
  exit 1
fi
if [ "$release_kind" = verified ]; then
  "$runtime_directory/bin/node" "$inventory_tool" \
    verify "$agent_bundle" "$release_id" verified
fi
if [ -e "$release_directory" ] || [ -e "$staging_directory" ]; then
  echo "Release already exists: $release_id" >&2
  exit 1
fi

mkdir -p "$install_root/releases" "$install_root/bin" /usr/local/bin /usr/local/libexec /etc/sudoers.d
mkdir "$staging_directory"

root_cli=$(mktemp "$install_root/bin/.ce.XXXXXX")
wrapper=$(mktemp /usr/local/bin/.ce.XXXXXX)
helper=$(mktemp /usr/local/libexec/.ce-self-provision.XXXXXX)
sudoers=$(mktemp /etc/sudoers.d/.codex-everywhere-self-provision.XXXXXX)
development_inventory=
trap 'rm -f "$root_cli" "$wrapper" "$helper" "$sudoers"; if [ -n "$development_inventory" ]; then rm -f "$development_inventory"; fi; rm -rf "$staging_directory"' EXIT HUP INT TERM
cat >"$root_cli" <<EOF
#!/bin/sh
PATH='$runtime_directory/bin':"\$PATH"
export PATH
exec '$runtime_directory/bin/node' '$install_root/current/dist/cli.js' "\$@"
EOF
cat >"$wrapper" <<EOF
#!/bin/sh
exec '$install_root/bin/ce' "\$@"
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
if [ "$release_kind" = development ]; then
  rm -f "$staging_directory/release-inventory.json"
  printf '%s\n' "$release_id" >"$staging_directory/release-id"
  chmod 0644 "$staging_directory/release-id"
  development_inventory=$install_root/releases/.$release_id.inventory.$$
  "$runtime_directory/bin/node" "$inventory_tool" \
    create "$staging_directory" "$release_id" development "$development_inventory"
  mv "$development_inventory" "$staging_directory/release-inventory.json"
  development_inventory=
fi
"$runtime_directory/bin/node" "$inventory_tool" \
  verify "$staging_directory" "$release_id" "$inventory_requirement"
chown root:root "$root_cli"
chmod 0755 "$root_cli"
chown root:root "$wrapper"
chmod 0755 "$wrapper"
chown root:root "$helper"
chmod 0755 "$helper"
chown root:root "$sudoers"
chmod 0440 "$sudoers"

mv "$staging_directory" "$release_directory"
mv "$root_cli" "$install_root/bin/ce"
mv "$wrapper" /usr/local/bin/ce
mv "$helper" /usr/local/libexec/ce-self-provision
mv "$sudoers" /etc/sudoers.d/codex-everywhere-self-provision
ln -sfn "releases/$release_id" "$install_root/current"
trap - EXIT HUP INT TERM

echo "Shared Agent installed: $release_directory"
echo "Release kind: $release_kind"
echo "CLI: /usr/local/bin/ce"
echo "Root-owned CLI: $install_root/bin/ce"
echo "Self-service helper: /usr/local/libexec/ce-self-provision"

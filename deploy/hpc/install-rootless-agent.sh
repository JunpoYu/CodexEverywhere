#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "install-rootless-agent.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <agent-bundle> <release-id> [install-root] [runtime-directory]" >&2
  exit 1
fi

agent_bundle=$1
release_id=$2
install_root=${3:-$HOME/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
release_directory=$install_root/releases/$release_id
staging_directory=$install_root/releases/.$release_id.staging

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
case "$install_root:$runtime_directory" in
  *[!A-Za-z0-9_./:-]*)
    echo "Install and runtime paths contain unsupported characters" >&2
    exit 1
    ;;
esac

if [ ! -d "$agent_bundle" ] || [ -L "$agent_bundle" ] || [ ! -f "$agent_bundle/dist/cli.js" ]; then
  echo "Agent bundle does not contain dist/cli.js: $agent_bundle" >&2
  exit 1
fi
if [ "$(stat -c %u "$agent_bundle")" -ne "$(id -u)" ]; then
  echo "Agent bundle must be owned by the deployment user" >&2
  exit 1
fi
if [ ! -x "$runtime_directory/bin/node" ] || [ ! -x "$runtime_directory/bin/tmux" ]; then
  echo "Rootless shared runtime is missing: $runtime_directory" >&2
  exit 1
fi

case "$install_root" in
  "$HOME"/*) chmod 0711 "$HOME" ;;
esac
mkdir -p "$install_root/releases" "$install_root/bin"
chmod 0755 "$install_root" "$install_root/releases" "$install_root/bin"
for owned_path in "$install_root" "$install_root/releases" "$install_root/bin"; do
  if [ "$(stat -c %u "$owned_path")" -ne "$(id -u)" ]; then
    echo "Install path must be owned by the deployment user: $owned_path" >&2
    exit 1
  fi
done
if [ -e "$release_directory" ] || [ -e "$staging_directory" ]; then
  echo "Release already exists: $release_id" >&2
  exit 1
fi

bundle_real=$(readlink -f "$agent_bundle")
find "$agent_bundle" -type l -print | while IFS= read -r link_path; do
  resolved=$(readlink -f "$link_path")
  case "$resolved" in
    "$bundle_real"/*) ;;
    *)
      echo "Release symlink escapes the release root: $link_path" >&2
      exit 1
      ;;
  esac
done

unsafe_path=$(find "$agent_bundle" -xdev \( -perm -002 -o -perm -020 \) -print -quit)
if [ -n "$unsafe_path" ]; then
  echo "Release contains a group/world-writable path: $unsafe_path" >&2
  exit 1
fi

mv "$agent_bundle" "$staging_directory"
trap 'rm -rf "$staging_directory"' EXIT HUP INT TERM
chmod -R u+rwX,go+rX,go-w "$staging_directory"
chmod 0755 "$staging_directory/dist/cli.js"
mv "$staging_directory" "$release_directory"
ln -sfn "releases/$release_id" "$install_root/current"

wrapper=$install_root/bin/.ce.$$
cat >"$wrapper" <<EOF
#!/bin/sh
PATH='$runtime_directory/bin':"\$PATH"
export PATH
exec '$runtime_directory/bin/node' '$install_root/current/dist/cli.js' "\$@"
EOF
chmod 0755 "$wrapper"
mv "$wrapper" "$install_root/bin/ce"
trap - EXIT HUP INT TERM

echo "Rootless Agent installed: $release_directory"
echo "Shared CLI: $install_root/bin/ce"

#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "install-rootless-agent.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 6 ]; then
  echo "Usage: $0 <agent-bundle> <release-id> [install-root] [runtime-directory] [release-manifest] [development|verified]" >&2
  exit 1
fi

agent_bundle=$1
release_id=$2
install_root=${3:-$HOME/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
release_manifest=${5:-}
release_kind=${6:-development}
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
case "$release_id" in
  . | ..)
    echo "Release ID must not be . or .." >&2
    exit 1
    ;;
esac
case "$install_root:$runtime_directory" in
  *[!A-Za-z0-9_./:-]*)
    echo "Install and runtime paths contain unsupported characters" >&2
    exit 1
    ;;
esac
case "$release_kind" in
  development | verified) ;;
  *)
    echo "Release kind must be development or verified" >&2
    exit 1
    ;;
esac
if [ "$release_kind" = verified ]; then
  inventory_requirement=verified
else
  inventory_requirement=any
fi
if [ "$release_kind" = verified ] && [ -z "$release_manifest" ]; then
  echo "A verified release requires its authenticated manifest" >&2
  exit 1
fi

if [ ! -d "$agent_bundle" ] || [ -L "$agent_bundle" ] || [ ! -f "$agent_bundle/dist/cli.js" ]; then
  echo "Agent bundle does not contain dist/cli.js: $agent_bundle" >&2
  exit 1
fi
for reserved_name in release-id release-manifest.json release-inventory.json; do
  if [ -e "$agent_bundle/$reserved_name" ] || [ -L "$agent_bundle/$reserved_name" ]; then
    echo "Agent bundle contains reserved release metadata: $reserved_name" >&2
    exit 1
  fi
done
if [ -n "$release_manifest" ] && {
  [ ! -f "$release_manifest" ] || [ -L "$release_manifest" ];
}; then
  echo "Release manifest must be a regular file: $release_manifest" >&2
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
script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
inventory_tool=$script_directory/verify-rootless-release.mjs
if [ ! -f "$inventory_tool" ] || [ -L "$inventory_tool" ]; then
  echo "Missing release inventory verifier: $inventory_tool" >&2
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
if [ -e "$staging_directory" ] || [ -L "$staging_directory" ]; then
  echo "Incomplete release staging directory exists: $staging_directory" >&2
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

# Symlink mode bits are not meaningful on Linux and normally appear as 0777.
# Their resolved targets were already constrained to the bundle above; the
# target files and directories are still visited and checked here.
unsafe_path=$(
  find "$agent_bundle" -xdev ! -type l \( -perm -002 -o -perm -020 \) -print -quit
)
if [ -n "$unsafe_path" ]; then
  echo "Release contains a group/world-writable path: $unsafe_path" >&2
  exit 1
fi

inventory_record=$install_root/releases/.$release_id.inventory.$$
manifest_copy=$install_root/releases/.$release_id.manifest.$$
cleanup_release_staging() {
  rm -f "$inventory_record"
  if [ -n "$release_manifest" ]; then rm -f "$manifest_copy"; fi
  if [ -e "$staging_directory" ]; then rm -rf "$staging_directory"; fi
}
trap cleanup_release_staging EXIT HUP INT TERM
if [ -n "$release_manifest" ]; then cp "$release_manifest" "$manifest_copy"; fi
mv "$agent_bundle" "$staging_directory"
if [ -n "$release_manifest" ]; then
  cp "$manifest_copy" "$staging_directory/release-manifest.json"
  chmod 0644 "$staging_directory/release-manifest.json"
fi
printf '%s\n' "$release_id" >"$staging_directory/release-id"
chmod 0644 "$staging_directory/release-id"
chmod -R u+rwX,go+rX,go-w "$staging_directory"
chmod 0755 "$staging_directory/dist/cli.js"
"$runtime_directory/bin/node" "$inventory_tool" \
  create "$staging_directory" "$release_id" "$release_kind" "$inventory_record"
mv "$inventory_record" "$staging_directory/release-inventory.json"
"$runtime_directory/bin/node" "$inventory_tool" \
  verify "$staging_directory" "$release_id" "$inventory_requirement"

if [ ! -e "$release_directory" ] && [ ! -L "$release_directory" ]; then
  mv "$staging_directory" "$release_directory"
else
  if [ ! -d "$release_directory" ] || [ -L "$release_directory" ] ||
    [ "$(stat -c %u "$release_directory" 2>/dev/null || true)" != "$(id -u)" ]; then
    echo "Existing release directory is unsafe: $release_directory" >&2
    exit 1
  fi
  "$runtime_directory/bin/node" "$inventory_tool" \
    verify "$release_directory" "$release_id" "$inventory_requirement"
  if ! cmp -s \
    "$staging_directory/release-inventory.json" \
    "$release_directory/release-inventory.json"; then
    echo "Existing release content does not match the incoming bundle: $release_id" >&2
    exit 1
  fi
  rm -rf "$staging_directory"
fi
rm -f "$manifest_copy"
trap - EXIT HUP INT TERM

wrapper=$install_root/bin/.ce.$$
cat >"$wrapper" <<EOF
#!/bin/sh
PATH='$runtime_directory/bin':"\$PATH"
export PATH
exec '$runtime_directory/bin/node' '$install_root/current/dist/cli.js' "\$@"
EOF
chmod 0755 "$wrapper"
mv "$wrapper" "$install_root/bin/ce"

# active-release follows the authoritative current pointer. Legacy directories
# are never mutated into inventoried releases by an install or activation.
active_release=$install_root/.active-release.$$
ln -s "current/release-id" "$active_release"
mv -Tf "$active_release" "$install_root/active-release"
current_link=$install_root/.current.$$
ln -s "releases/$release_id" "$current_link"
mv -Tf "$current_link" "$install_root/current"

echo "Rootless Agent installed: $release_directory"
echo "Shared CLI: $install_root/bin/ce"

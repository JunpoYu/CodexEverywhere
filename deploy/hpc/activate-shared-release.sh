#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "activate-shared-release.sh must run as root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <release-id> [install-root] [runtime-directory] [--allow-development]" >&2
  exit 1
fi

release_id=$1
install_root=${2:-/public/software/codex-everywhere}
runtime_directory=${3:-$install_root/runtime}
activation_mode=${4:-verified}
case "$install_root:$runtime_directory:$release_id" in
  /*:/*:*[!A-Za-z0-9._-]*)
    echo "Install paths must be absolute and release-id must be path-safe" >&2
    exit 1
    ;;
  /*:/*:*) ;;
  *)
    echo "Install root and runtime directory must be absolute" >&2
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
case "$activation_mode" in
  verified) inventory_requirement=verified ;;
  --allow-development) inventory_requirement=any ;;
  *)
    echo "Activation mode must be --allow-development when selecting a development release" >&2
    exit 1
    ;;
esac

release_directory=$install_root/releases/$release_id
if [ ! -d "$release_directory" ] || [ -L "$release_directory" ] ||
  [ ! -f "$release_directory/dist/cli.js" ]; then
  echo "Release is incomplete: $release_directory" >&2
  exit 1
fi
if [ "$(stat -c %u "$install_root")" -ne 0 ] ||
  [ "$(stat -c %u "$release_directory")" -ne 0 ]; then
  echo "Shared install root and release must be owned by root" >&2
  exit 1
fi
if find "$install_root" "$release_directory" -maxdepth 0 \
  \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Shared install root and release must not be group/world writable" >&2
  exit 1
fi
if [ ! -x "$runtime_directory/bin/node" ] ||
  [ "$(stat -c %u "$runtime_directory/bin/node")" -ne 0 ]; then
  echo "Root-owned shared Node.js runtime is missing: $runtime_directory" >&2
  exit 1
fi
script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
inventory_tool=$script_directory/verify-rootless-release.mjs
script_path=$(readlink -f "$0")
if [ "$(stat -c %u "$script_path")" -ne 0 ] ||
  find "$script_path" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Privileged activator must be a root-owned, non-writable file: $script_path" >&2
  exit 1
fi
trusted_directory=$script_directory
while :; do
  if [ "$(stat -c %u "$trusted_directory")" -ne 0 ] ||
    find "$trusted_directory" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
    echo "Privileged activator path is not trusted: $trusted_directory" >&2
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
"$runtime_directory/bin/node" "$inventory_tool" \
  verify "$release_directory" "$release_id" "$inventory_requirement"

active_release=$install_root/.active-release.$$
ln -s "current/release-id" "$active_release"
mv -Tf "$active_release" "$install_root/active-release"
current_link=$install_root/.current.$$
ln -s "releases/$release_id" "$current_link"
mv -Tf "$current_link" "$install_root/current"
echo "Activated shared root-owned Agent release: $release_id"

#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "activate-rootless-release.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <release-id> [install-root] [runtime-directory] [--allow-development]" >&2
  exit 1
fi

release_id=$1
install_root=${2:-$HOME/software/codex-everywhere}
runtime_directory=${3:-$install_root/runtime}
activation_mode=${4:-verified}
case "$install_root:$runtime_directory:$release_id" in
  /*:/*:*[!A-Za-z0-9._-]*)
    echo "Install root or release ID is invalid" >&2
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
    echo "Activation mode must be --allow-development when explicitly selecting a development release" >&2
    exit 1
    ;;
esac

release_directory=$install_root/releases/$release_id
if [ ! -d "$release_directory" ] || [ -L "$release_directory" ] ||
  [ ! -f "$release_directory/dist/cli.js" ]; then
  echo "Release is incomplete: $release_directory" >&2
  exit 1
fi
if [ "$(stat -c %u "$install_root")" -ne "$(id -u)" ]; then
  echo "Install root must be owned by the deployment user" >&2
  exit 1
fi
if [ "$(stat -c %u "$release_directory")" -ne "$(id -u)" ]; then
  echo "Release directory must be owned by the deployment user" >&2
  exit 1
fi
if [ ! -x "$runtime_directory/bin/node" ]; then
  echo "Rootless shared Node.js runtime is missing: $runtime_directory" >&2
  exit 1
fi
script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
inventory_tool=$script_directory/verify-rootless-release.mjs
if [ ! -f "$inventory_tool" ] || [ -L "$inventory_tool" ]; then
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
echo "Activated rootless Agent release: $release_id"

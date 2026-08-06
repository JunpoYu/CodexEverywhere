#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "activate-rootless-release.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <release-id> [install-root]" >&2
  exit 1
fi

release_id=$1
install_root=${2:-$HOME/software/codex-everywhere}
case "$install_root:$release_id" in
  /*:*[!A-Za-z0-9._-]*)
    echo "Install root or release ID is invalid" >&2
    exit 1
    ;;
  /*:*) ;;
  *)
    echo "Install root must be absolute" >&2
    exit 1
    ;;
esac

release_directory=$install_root/releases/$release_id
if [ ! -f "$release_directory/dist/cli.js" ]; then
  echo "Release is incomplete: $release_directory" >&2
  exit 1
fi
if [ "$(stat -c %u "$install_root")" -ne "$(id -u)" ]; then
  echo "Install root must be owned by the deployment user" >&2
  exit 1
fi

ln -sfn "releases/$release_id" "$install_root/current"
echo "Activated rootless Agent release: $release_id"

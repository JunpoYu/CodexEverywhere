#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "create-shared-runtime.sh must run as root" >&2
  exit 1
fi
script_path=$(readlink -f "$0")
script_parent=$(dirname "$script_path")
if [ "$(stat -c %u "$script_path")" -ne 0 ] ||
  find "$script_path" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Shared runtime installer must be a root-owned, non-writable file: $script_path" >&2
  exit 1
fi
while :; do
  if [ "$(stat -c %u "$script_parent")" -ne 0 ] ||
    find "$script_parent" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
    echo "Shared runtime installer path is not trusted: $script_parent" >&2
    exit 1
  fi
  if [ "$script_parent" = / ]; then break; fi
  script_parent=$(dirname "$script_parent")
done

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <conda-binary> [runtime-directory]" >&2
  exit 1
fi

conda_binary=$1
runtime_directory=${2:-/public/software/codex-everywhere/runtime}

case "$runtime_directory" in
  /*) ;;
  *)
    echo "Runtime directory must be absolute" >&2
    exit 1
    ;;
esac

conda_binary=$(readlink -f "$conda_binary")
if [ ! -f "$conda_binary" ] || [ -L "$conda_binary" ] || [ ! -x "$conda_binary" ]; then
  echo "Conda is not executable: $conda_binary" >&2
  exit 1
fi
if [ "$(stat -c %u "$conda_binary")" -ne 0 ] ||
  find "$conda_binary" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
  echo "Root must only execute a root-owned, non-writable Conda binary: $conda_binary" >&2
  exit 1
fi
conda_parent=$(dirname "$conda_binary")
while :; do
  if [ "$(stat -c %u "$conda_parent")" -ne 0 ] ||
    find "$conda_parent" -prune \( -perm -002 -o -perm -020 \) -print -quit | grep -q .; then
    echo "Conda path must not cross a non-root or writable directory: $conda_parent" >&2
    exit 1
  fi
  if [ "$conda_parent" = / ]; then break; fi
  conda_parent=$(dirname "$conda_parent")
done

if [ -e "$runtime_directory" ]; then
  if [ ! -x "$runtime_directory/bin/node" ] || [ ! -x "$runtime_directory/bin/tmux" ]; then
    echo "Existing runtime is incomplete: $runtime_directory" >&2
    exit 1
  fi
else
  mkdir -p "$(dirname "$runtime_directory")"
  "$conda_binary" create --yes --prefix "$runtime_directory" \
    nodejs=20.20.2 tmux
fi

chown -R root:root "$runtime_directory"
chmod -R go-w "$runtime_directory"

node_version=$($runtime_directory/bin/node --version)
case "$node_version" in
  v20.20.*) ;;
  *)
    echo "Unexpected shared Node.js version: $node_version" >&2
    exit 1
    ;;
esac

echo "Shared runtime ready: $runtime_directory ($node_version)"

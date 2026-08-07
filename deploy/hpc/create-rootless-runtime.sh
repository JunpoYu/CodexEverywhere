#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "create-rootless-runtime.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <conda-binary> [runtime-directory]" >&2
  exit 1
fi

conda_binary=$1
runtime_directory=${2:-$HOME/software/codex-everywhere/runtime}

case "$runtime_directory" in
  /*) ;;
  *)
    echo "Runtime directory must be absolute" >&2
    exit 1
    ;;
esac

if [ ! -x "$conda_binary" ]; then
  echo "Conda is not executable: $conda_binary" >&2
  exit 1
fi

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

if [ "$(stat -c %u "$runtime_directory")" -ne "$(id -u)" ]; then
  echo "Runtime must be owned by the deployment user: $runtime_directory" >&2
  exit 1
fi
chmod -R u+rwX,go+rX,go-w "$runtime_directory"

node_version=$($runtime_directory/bin/node --version)
case "$node_version" in
  v20.20.*) ;;
  *)
    echo "Unexpected shared Node.js version: $node_version" >&2
    exit 1
    ;;
esac

echo "Rootless shared runtime ready: $runtime_directory ($node_version)"

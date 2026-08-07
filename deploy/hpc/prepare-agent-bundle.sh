#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <absolute-output-directory>" >&2
  exit 1
fi

output_directory=$1
case "$output_directory" in
  /*) ;;
  *)
    echo "Output directory must be absolute" >&2
    exit 1
    ;;
esac
if [ -e "$output_directory" ]; then
  echo "Output directory already exists: $output_directory" >&2
  exit 1
fi

script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd)
cd "$repository_root"

if [ "${CE_SKIP_BUILD:-0}" != "1" ]; then
  pnpm --filter @codex-everywhere/agent... build
fi
pnpm --config.inject-workspace-packages=true \
  --filter @codex-everywhere/agent \
  deploy --prod "$output_directory"

find "$output_directory/dist" -type f -name '*.test.*' -delete
rm -rf "$output_directory/node_modules/.bin"
rm -f \
  "$output_directory/node_modules/.modules.yaml" \
  "$output_directory/node_modules/.pnpm-workspace-state-v1.json" \
  "$output_directory/pnpm-lock.yaml" \
  "$output_directory/pnpm-workspace.yaml"

# The virtual store must never leak a local developer path into a release.
self_reference=$output_directory/node_modules/.pnpm/node_modules/@codex-everywhere/agent
if [ -L "$self_reference" ]; then
  rm "$self_reference"
fi

broken_link=$(find "$output_directory" -type l ! -exec test -e {} \; -print -quit)
if [ -n "$broken_link" ]; then
  echo "Agent bundle contains a broken symlink: $broken_link" >&2
  exit 1
fi
if [ ! -x "$output_directory/dist/cli.js" ]; then
  echo "Agent bundle is missing executable dist/cli.js" >&2
  exit 1
fi

echo "Production Agent bundle ready: $output_directory"

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

pnpm --filter @codex-everywhere/agent... build
pnpm --filter @codex-everywhere/agent deploy --prod --legacy "$output_directory"

# pnpm's virtual store can contain a development-only self-reference back to
# the source checkout. It is never needed at runtime and must not leak a local
# developer path into a release artifact.
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

#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <absolute-output-directory> <version-tag> [commit]" >&2
  exit 1
fi

output_directory=$1
version=$2
commit=${3:-$(git rev-parse HEAD)}
case "$output_directory" in
  /*) ;;
  *)
    echo "Output directory must be absolute" >&2
    exit 1
    ;;
esac
case "$version" in
  v[0-9]*[!A-Za-z0-9._-]* | *[!A-Za-z0-9._-]*)
    echo "Version must be a path-safe semantic tag beginning with v" >&2
    exit 1
    ;;
  v[0-9]*) ;;
  *)
    echo "Version must be a path-safe semantic tag beginning with v" >&2
    exit 1
    ;;
esac
case "$commit" in
  *[!0-9a-f]*)
    echo "Release commit must be lowercase hexadecimal" >&2
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

head_commit=$(git rev-parse HEAD)
if [ "$head_commit" != "$commit" ]; then
  echo "Release commit $commit does not match checked-out HEAD $head_commit" >&2
  exit 1
fi
tag_commit=$(git rev-parse "$version^{commit}" 2>/dev/null || true)
if [ "$tag_commit" != "$commit" ]; then
  echo "Release tag $version does not resolve to commit $commit" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "Release assets require a completely clean checkout" >&2
  exit 1
fi

package_version=$(node -p "require('./package.json').version")
if [ "$version" != "v$package_version" ]; then
  echo "Tag $version does not match package version $package_version" >&2
  exit 1
fi
for package_file in \
  apps/agent/package.json \
  apps/relay/package.json \
  apps/web/package.json \
  packages/crypto/package.json \
  packages/kernel/package.json \
  packages/protocol/package.json \
  packages/testing/package.json
do
  component_version=$(node -p "require('./$package_file').version")
  if [ "$component_version" != "$package_version" ]; then
    echo "$package_file version $component_version does not match $package_version" >&2
    exit 1
  fi
done
if [ "$(printf %s "$commit" | wc -c | tr -d ' ')" -ne 40 ]; then
  echo "Release commit must be a full 40-character SHA" >&2
  exit 1
fi

mkdir -p "$output_directory"
staging_directory=$output_directory/.staging
mkdir "$staging_directory"
trap 'rm -rf "$staging_directory"' EXIT HUP INT TERM

pnpm build
protocol_version=$(node -e "import('./packages/protocol/dist/index.js').then((module) => process.stdout.write(String(module.PROTOCOL_VERSION)))")

mkdir "$staging_directory/web"
cp -R apps/web/dist/. "$staging_directory/web/"
CE_SKIP_BUILD=1 deploy/release/prepare-relay-bundle.sh "$staging_directory/relay"
CE_SKIP_BUILD=1 deploy/hpc/prepare-agent-bundle.sh "$staging_directory/agent"
for component_directory in \
  "$staging_directory/web" \
  "$staging_directory/relay" \
  "$staging_directory/agent"
do
  cp LICENSE NOTICE "$component_directory/"
done
node -e '
  const fs = require("fs");
  const [path, version, commit, protocolVersion] = process.argv.slice(1);
  fs.writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, version, commit, protocolVersion: Number(protocolVersion) }, null, 2)}\n`);
' "$staging_directory/build-info.json" "$version" "$commit" "$protocol_version"
for component_directory in \
  "$staging_directory/web" \
  "$staging_directory/relay" \
  "$staging_directory/agent"
do
  cp "$staging_directory/build-info.json" "$component_directory/"
done

web_archive=$output_directory/codex-everywhere-web-$version.tar.gz
relay_archive=$output_directory/codex-everywhere-relay-$version.tar.gz
agent_archive=$output_directory/codex-everywhere-agent-$version.tar.gz
hpc_tools_archive=$output_directory/codex-everywhere-hpc-tools-$version.tar.gz

source_date_epoch=$(git show -s --format=%ct "$commit")
mkdir "$staging_directory/hpc-tools"
cp \
  deploy/hpc/create-rootless-runtime.sh \
  deploy/hpc/create-shared-runtime.sh \
  deploy/hpc/activate-shared-release.sh \
  deploy/hpc/install-release.sh \
  deploy/hpc/install-rootless-agent.sh \
  deploy/hpc/install-rootless-global-shim.sh \
  deploy/hpc/install-shared-agent.sh \
  deploy/hpc/activate-rootless-release.sh \
  deploy/hpc/verify-rootless-release.mjs \
  "$staging_directory/hpc-tools/"
cp LICENSE NOTICE "$staging_directory/hpc-tools/"
cp "$staging_directory/build-info.json" "$staging_directory/hpc-tools/"
node -e '
  const fs = require("fs");
  const path = require("path");
  const [root, epoch] = process.argv.slice(1);
  const timestamp = new Date(Number(epoch) * 1000);
  function normalize(target) {
    const metadata = fs.lstatSync(target);
    if (metadata.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) normalize(path.join(target, entry));
    }
    if (metadata.isSymbolicLink()) fs.lutimesSync(target, timestamp, timestamp);
    else fs.utimesSync(target, timestamp, timestamp);
  }
  normalize(root);
' "$staging_directory" "$source_date_epoch"
create_archive() {
  archive_path=$1
  component=$2
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar -C "$staging_directory" \
      --sort=name \
      --mtime="@$source_date_epoch" \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      -cf - "$component" | gzip -n > "$archive_path"
  else
    COPYFILE_DISABLE=1 tar -C "$staging_directory" -cf - "$component" | gzip -n > "$archive_path"
  fi
}

create_archive "$web_archive" web
create_archive "$relay_archive" relay
create_archive "$agent_archive" agent
create_archive "$hpc_tools_archive" hpc-tools

node deploy/release/write-manifest.mjs \
  "$output_directory" "$version" "$commit" "$protocol_version" \
  "web=$web_archive" \
  "relay=$relay_archive" \
  "agent=$agent_archive" \
  "hpcTools=$hpc_tools_archive"

rm -rf "$staging_directory"
trap - EXIT HUP INT TERM
echo "Release assets ready: $output_directory"

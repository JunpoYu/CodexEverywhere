#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "install-release.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <version> [repository] [install-root] [runtime-directory]" >&2
  exit 1
fi

version=$1
repository=${2:-JunpoYu/CodexEverywhere}
install_root=${3:-$HOME/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
case "$version" in
  v[0-9]*[!A-Za-z0-9._-]* | *[!A-Za-z0-9._-]*)
    echo "Invalid release version" >&2
    exit 1
    ;;
  v[0-9]*) ;;
  *)
    echo "Invalid release version" >&2
    exit 1
    ;;
esac
case "$repository" in
  *[!A-Za-z0-9_./-]* | /* | */*/* | */)
    echo "Invalid GitHub repository" >&2
    exit 1
    ;;
  */*) ;;
  *)
    echo "Invalid GitHub repository" >&2
    exit 1
    ;;
esac
case "$install_root:$runtime_directory" in
  /*:/*) ;;
  *)
    echo "Install root and runtime directory must be absolute" >&2
    exit 1
    ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
installer=$script_directory/install-rootless-agent.sh
if [ ! -x "$installer" ]; then
  echo "Missing sibling installer: $installer" >&2
  exit 1
fi
for command in curl tar sha256sum awk grep mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/ce-release.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
asset=codex-everywhere-agent-$version.tar.gz
base_url=https://github.com/$repository/releases/download/$version

curl --fail --location --silent --show-error \
  "$base_url/SHA256SUMS" --output "$temporary_directory/SHA256SUMS"
curl --fail --location --silent --show-error \
  "$base_url/manifest.json" --output "$temporary_directory/manifest.json"
curl --fail --location --silent --show-error \
  "$base_url/$asset" --output "$temporary_directory/$asset"

expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$temporary_directory/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "Release checksum does not contain $asset" >&2
  exit 1
fi
actual=$(sha256sum "$temporary_directory/$asset" | awk '{ print $1 }')
if [ "$actual" != "$expected" ]; then
  echo "Release checksum mismatch for $asset" >&2
  exit 1
fi

"$runtime_directory/bin/node" -e '
  const fs = require("fs");
  const [manifestPath, expectedVersion, expectedFile, expectedHash] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.version !== expectedVersion ||
      manifest.artifacts?.agent?.file !== expectedFile ||
      manifest.artifacts?.agent?.sha256 !== expectedHash) process.exit(1);
' "$temporary_directory/manifest.json" "$version" "$asset" "$actual" || {
  echo "Release manifest does not match the requested Agent artifact" >&2
  exit 1
}

if tar -tzf "$temporary_directory/$asset" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Release archive contains an unsafe path" >&2
  exit 1
fi
tar -xzf "$temporary_directory/$asset" -C "$temporary_directory"
if [ ! -d "$temporary_directory/agent" ]; then
  echo "Release archive does not contain an Agent bundle" >&2
  exit 1
fi

"$installer" \
  "$temporary_directory/agent" \
  "$version" \
  "$install_root" \
  "$runtime_directory"

echo "Installed verified CodexEverywhere release $version from $repository"

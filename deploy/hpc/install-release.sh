#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "install-release.sh must run as the dedicated deployment user, not root" >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 <version> [repository] [install-root] [runtime-directory] [approved-manifest-sha256]" >&2
  exit 1
fi

version=$1
repository=${2:-JunpoYu/CodexEverywhere}
install_root=${3:-$HOME/software/codex-everywhere}
runtime_directory=${4:-$install_root/runtime}
approved_manifest_sha256=${5:-${CE_APPROVED_MANIFEST_SHA256:-}}
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
if [ -n "$approved_manifest_sha256" ]; then
  case "$approved_manifest_sha256" in
    *[!0-9a-f]* | "")
      echo "Approved manifest SHA-256 must be lowercase hexadecimal" >&2
      exit 1
      ;;
  esac
  if [ "$(printf %s "$approved_manifest_sha256" | wc -c | tr -d ' ')" -ne 64 ]; then
    echo "Approved manifest SHA-256 must contain 64 characters" >&2
    exit 1
  fi
fi

script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
installer=$script_directory/install-rootless-agent.sh
if [ ! -x "$installer" ]; then
  echo "Missing sibling installer: $installer" >&2
  exit 1
fi
if [ ! -x "$runtime_directory/bin/node" ]; then
  echo "Rootless shared Node.js runtime is missing: $runtime_directory" >&2
  exit 1
fi
for command in curl tar sha256sum awk grep mktemp wc; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/ce-release.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
asset=codex-everywhere-agent-$version.tar.gz
base_url=https://github.com/$repository/releases/download/$version

download_release_file() {
  source_url=$1
  destination=$2
  partial=$destination.partial
  attempt=1
  while [ "$attempt" -le 5 ]; do
    rm -f "$partial"
    if curl --fail --location --silent --show-error --connect-timeout 20 \
      "$source_url" --output "$partial"; then
      mv "$partial" "$destination"
      return 0
    fi
    rm -f "$partial"
    if [ "$attempt" -lt 5 ]; then
      echo "Release download failed; retrying ($attempt/5): $source_url" >&2
      sleep $((attempt * 2))
    fi
    attempt=$((attempt + 1))
  done
  echo "Release download failed after 5 attempts: $source_url" >&2
  return 1
}

download_release_file "$base_url/SHA256SUMS" "$temporary_directory/SHA256SUMS"
download_release_file "$base_url/manifest.json" "$temporary_directory/manifest.json"
download_release_file "$base_url/$asset" "$temporary_directory/$asset"

manifest_expected=$(awk '$2 == "manifest.json" { print $1 }' "$temporary_directory/SHA256SUMS")
manifest_actual=$(sha256sum "$temporary_directory/manifest.json" | awk '{ print $1 }')
if [ -z "$manifest_expected" ] || [ "$manifest_actual" != "$manifest_expected" ]; then
  echo "Release checksum mismatch for manifest.json" >&2
  exit 1
fi
manifest_commit=$(
  "$runtime_directory/bin/node" -e '
    const fs = require("fs");
    const [manifestPath, expectedVersion, expectedFile] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const agent = manifest.artifacts?.agent;
    if (manifest.schemaVersion !== 1 || manifest.project !== "CodexEverywhere" ||
        manifest.version !== expectedVersion || !/^[0-9a-f]{40}$/.test(manifest.commit) ||
        manifest.protocolVersion !== 1 || manifest.node !== ">=20.20.0" ||
        agent?.file !== expectedFile || !/^[0-9a-f]{64}$/.test(agent.sha256) ||
        !Number.isSafeInteger(agent.bytes) || agent.bytes <= 0) process.exit(1);
    process.stdout.write(manifest.commit);
  ' "$temporary_directory/manifest.json" "$version" "$asset"
) || {
  echo "Release manifest identity is invalid" >&2
  exit 1
}
if [ -n "$approved_manifest_sha256" ]; then
  if [ "$manifest_actual" != "$approved_manifest_sha256" ]; then
    echo "Release manifest does not match the approved staging digest" >&2
    exit 1
  fi
elif command -v gh >/dev/null 2>&1; then
  attestation_help=$(gh attestation verify --help 2>&1) || {
    echo "GitHub CLI cannot describe attestation verification capabilities" >&2
    exit 1
  }
  for required_flag in \
    --signer-workflow \
    --source-ref \
    --source-digest \
    --deny-self-hosted-runners
  do
    if ! printf '%s\n' "$attestation_help" | grep -q -- "$required_flag"; then
      echo "GitHub CLI lacks required attestation identity constraint: $required_flag" >&2
      exit 1
    fi
  done
  trusted_workflow=$repository/.github/workflows/release.yml
  for attested_file in SHA256SUMS manifest.json "$asset"; do
    gh attestation verify "$temporary_directory/$attested_file" \
      --repo "$repository" \
      --signer-workflow "$trusted_workflow" \
      --source-ref "refs/tags/$version" \
      --source-digest "$manifest_commit" \
      --deny-self-hosted-runners >/dev/null || {
      echo "GitHub provenance verification failed for $attested_file" >&2
      exit 1
    }
  done
else
  echo "Release authenticity requires gh attestation verification or an approved manifest SHA-256" >&2
  echo "Pass the staging-approved digest as argument 5 or CE_APPROVED_MANIFEST_SHA256" >&2
  exit 1
fi

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
actual_bytes=$(wc -c <"$temporary_directory/$asset" | tr -d ' ')

"$runtime_directory/bin/node" -e '
  const fs = require("fs");
  const [manifestPath, expectedVersion, expectedFile, expectedHash, expectedBytes] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.project !== "CodexEverywhere" ||
      manifest.version !== expectedVersion ||
      !/^[0-9a-f]{40}$/.test(manifest.commit) ||
      manifest.protocolVersion !== 1 || manifest.node !== ">=20.20.0" ||
      manifest.artifacts?.agent?.file !== expectedFile ||
      manifest.artifacts?.agent?.sha256 !== expectedHash ||
      manifest.artifacts?.agent?.bytes !== Number(expectedBytes)) process.exit(1);
' "$temporary_directory/manifest.json" "$version" "$asset" "$actual" "$actual_bytes" || {
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

"$runtime_directory/bin/node" -e '
  const fs = require("fs");
  const [manifestPath, buildInfoPath] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const build = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 20) ||
      build.schemaVersion !== 1 || build.version !== manifest.version ||
      build.commit !== manifest.commit ||
      build.protocolVersion !== manifest.protocolVersion) process.exit(1);
' "$temporary_directory/manifest.json" "$temporary_directory/agent/build-info.json" || {
  echo "Agent build metadata does not match the verified release manifest" >&2
  exit 1
}

"$installer" \
  "$temporary_directory/agent" \
  "$version" \
  "$install_root" \
  "$runtime_directory" \
  "$temporary_directory/manifest.json" \
  verified

echo "Installed verified CodexEverywhere release $version from $repository"

export type ArtifactMetadata = {
  file: string;
  sha256: string;
  bytes: number;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  project: "CodexEverywhere";
  version: string;
  commit: string;
  protocolVersion: number;
  node: string;
  artifacts: Record<string, ArtifactMetadata>;
};

export function sha256File(path: string): Promise<string>;

export function writeReleaseManifest(options: {
  outputDirectory: string;
  version: string;
  commit: string;
  protocolVersion: number;
  artifactPaths: Record<string, string>;
}): Promise<ReleaseManifest>;

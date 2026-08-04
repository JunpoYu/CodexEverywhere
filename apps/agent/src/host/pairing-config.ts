import type { HostPaths } from "./paths.js";
import { readHostConfig, type HostConfig } from "./config.js";

export class HostProvisioningRequiredError extends Error {}

export async function readPairingHostConfig(
  paths: HostPaths,
  username: string,
): Promise<HostConfig> {
  let config: HostConfig;
  try {
    config = await readHostConfig(paths);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new HostProvisioningRequiredError(notProvisionedMessage(username));
    }
    throw error;
  }
  if (config.transport.mode === "unconfigured") {
    throw new HostProvisioningRequiredError(notProvisionedMessage(username));
  }
  if (!config.webAuthn) {
    throw new HostProvisioningRequiredError(
      `CodexEverywhere Web authentication is not configured for ${username}. Run "ce device pair" again to complete self-service initialization.`,
    );
  }
  return config;
}

function notProvisionedMessage(username: string): string {
  return `CodexEverywhere is not initialized for ${username}. Existing SSH users can initialize automatically with "ce device pair" once the administrator has installed the host provisioner.`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

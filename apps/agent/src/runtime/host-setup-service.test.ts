import { describe, expect, it, vi } from "vitest";

import type { RequestEnvelope } from "@codex-everywhere/protocol";

import { createHostConfig, type HostConfig } from "../host/config.js";
import { resolveHostPaths } from "../host/paths.js";
import { HostSetupService } from "./host-setup-service.js";

describe("HostSetupService", () => {
  it("returns only the proxy mode and never returns proxy credentials", async () => {
    let config: HostConfig = {
      ...createHostConfig(),
      network: {
        mode: "proxy",
        httpsProxy: "http://alice:secret@proxy.example:7890",
      },
    };
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        readConfig: vi.fn(async () => config),
        writeConfig: vi.fn(async (_paths, next) => {
          config = next;
        }),
        probeCodex: vi.fn(async () => ({
          installed: false,
          binary: "/home/alice/.local/bin/codex",
        })),
        probeAppServer: vi.fn(async () => false),
      },
    });

    const result = await service.request(envelope("setup/status", {}));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).toEqual({
      handled: true,
      value: {
        networkConfigured: true,
        networkMode: "proxy",
        codex: { installed: false },
        appServerRunning: false,
      },
    });
  });

  it("distinguishes an unconfigured network from an explicit direct choice", async () => {
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        readConfig: vi.fn(async () => createHostConfig()),
        probeCodex: vi.fn(async () => ({
          installed: true,
          binary: "codex",
          version: "codex-cli 1.2.3",
        })),
        probeAppServer: vi.fn(async () => false),
      },
    });

    await expect(
      service.request(envelope("setup/status", {})),
    ).resolves.toEqual({
      handled: true,
      value: {
        networkConfigured: false,
        networkMode: "direct",
        codex: {
          installed: true,
          binary: "codex",
          version: "codex-cli 1.2.3",
        },
        appServerRunning: false,
      },
    });
  });

  it("reports installed and npm latest Codex versions separately", async () => {
    const probeLatestCodexVersion = vi.fn(async ({ env }) =>
      env.HTTPS_PROXY ? "0.152.0" : undefined,
    );
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        readConfig: vi.fn(async (): Promise<HostConfig> => ({
          ...createHostConfig(),
          network: {
            mode: "proxy",
            httpsProxy: "http://proxy:7890",
          },
        })),
        probeCodex: vi.fn(async () => ({
          installed: true,
          binary: "/home/alice/.local/bin/codex",
          version: "codex-cli 0.151.0",
        })),
        probeLatestCodexVersion,
      },
    });

    await expect(
      service.request(envelope("setup/codex/version/read", {})),
    ).resolves.toEqual({
      handled: true,
      value: {
        version: 1,
        installed: true,
        installedVersion: "0.151.0",
        binary: "/home/alice/.local/bin/codex",
        latestVersion: "0.152.0",
        relation: "older",
      },
    });
    expect(probeLatestCodexVersion).toHaveBeenCalledWith({
      env: expect.objectContaining({ HTTPS_PROXY: "http://proxy:7890" }),
    });
  });

  it("returns the installed Codex version when npm cannot be reached", async () => {
    const service = new HostSetupService(resolveHostPaths(), {
      dependencies: {
        readConfig: vi.fn(async () => createHostConfig()),
        probeCodex: vi.fn(async () => ({
          installed: true,
          binary: "codex",
          version: "codex-cli 0.151.0",
        })),
        probeLatestCodexVersion: vi.fn(async () => undefined),
      },
    });

    await expect(
      service.request(envelope("setup/codex/version/read", {})),
    ).resolves.toMatchObject({
      value: {
        installed: true,
        installedVersion: "0.151.0",
        relation: "unknown",
      },
    });
  });

  it("uses the configured proxy for a serialized user installation", async () => {
    const installCodex = vi.fn(async ({ env, onProgress }) => {
      onProgress?.("installing");
      onProgress?.("verifying");
      return {
        installed: true,
        binary: "/home/alice/.local/bin/codex",
        version: env.HTTPS_PROXY ? "proxied" : "direct",
      };
    });
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        readConfig: vi.fn(async (): Promise<HostConfig> => ({
          ...createHostConfig(),
          network: {
            mode: "proxy",
            httpsProxy: "http://proxy:7890",
          },
        })),
        installCodex,
        probeAppServer: vi.fn(async () => true),
      },
    });

    const phases: unknown[] = [];
    const [first, second] = await Promise.all([
      service.request(envelope("setup/codex/install", {}), (event) =>
        phases.push((event.payload as { phase?: unknown }).phase),
      ),
      service.request(envelope("setup/codex/install", {})),
    ]);
    expect(first).toEqual(second);
    expect(installCodex).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      value: {
        installed: true,
        binary: "/home/alice/.local/bin/codex",
        restartRequired: true,
      },
    });
    expect(phases).toEqual([
      "preparing",
      "installing",
      "verifying",
      "completed",
    ]);
  });

  it("restarts app-server with the configured Codex binary and proxy", async () => {
    const restart = vi.fn(async () => undefined);
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        readConfig: vi.fn(async (): Promise<HostConfig> => ({
          ...createHostConfig(),
          network: {
            mode: "proxy",
            httpsProxy: "http://proxy:7890",
          },
        })),
        probeCodex: vi.fn(async () => ({
          installed: true,
          binary: "/home/alice/.local/bin/codex",
          version: "codex-cli 1.2.3",
        })),
        restartAppServer: restart,
      },
    });

    await expect(
      service.request(envelope("setup/app-server/restart", { force: true })),
    ).resolves.toEqual({
      handled: true,
      value: { running: true, version: "codex-cli 1.2.3" },
    });
    expect(restart).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        codexBinary: "/home/alice/.local/bin/codex",
        env: expect.objectContaining({ HTTPS_PROXY: "http://proxy:7890" }),
        force: true,
      }),
    );
  });

  it("rejects an app-server restart without an explicit force decision", async () => {
    const restart = vi.fn(async () => undefined);
    const service = new HostSetupService(resolveHostPaths(), {
      dependencies: { restartAppServer: restart },
    });

    await expect(
      service.request(envelope("setup/app-server/restart", {})),
    ).rejects.toThrow("force: true");
    expect(restart).not.toHaveBeenCalled();
  });

  it("imports a versioned Codex auth file without returning its contents", async () => {
    const importCodexAuth = vi.fn(async () => ({ replacedExisting: true }));
    const service = new HostSetupService(resolveHostPaths(), {
      userHome: "/home/alice",
      dependencies: {
        importCodexAuth,
        probeAppServer: vi.fn(async () => true),
      },
    });

    const result = await service.request(
      envelope("setup/codex/auth/import", {
        version: 1,
        content: '{"tokens":{"access_token":"secret"}}',
      }),
    );
    expect(result).toEqual({
      handled: true,
      value: {
        version: 1,
        imported: true,
        replacedExisting: true,
        restartRequired: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(importCodexAuth).toHaveBeenCalledWith({
      userHome: "/home/alice",
      content: '{"tokens":{"access_token":"secret"}}',
    });
  });

  it("handles host preferences without starting or probing Codex", async () => {
    const readSessionPermissionDefaults = vi.fn(async () => ({
      version: 1 as const,
      sandbox: "workspace-write" as const,
      approvalPolicy: "on-request" as const,
    }));
    const updateSessionPermissionDefaults = vi.fn(async () => ({
      version: 1 as const,
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      updatedAt: "2026-08-08T00:00:00.000Z",
    }));
    const probeCodex = vi.fn();
    const service = new HostSetupService(resolveHostPaths(), {
      dependencies: { probeCodex },
      preferences: {
        readSessionPermissionDefaults,
        updateSessionPermissionDefaults,
      },
    });

    await expect(
      service.request(envelope("preferences/read", {})),
    ).resolves.toEqual({
      handled: true,
      value: {
        version: 1,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
    });
    await expect(
      service.request(
        envelope("preferences/session-permissions/update", {
          sandbox: "read-only",
          approvalPolicy: "never",
        }),
      ),
    ).resolves.toMatchObject({
      handled: true,
      value: { sandbox: "read-only", approvalPolicy: "never" },
    });
    expect(updateSessionPermissionDefaults).toHaveBeenCalledWith({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(probeCodex).not.toHaveBeenCalled();
  });

  it("rejects unversioned Codex auth imports", async () => {
    const importCodexAuth = vi.fn(async () => ({ replacedExisting: false }));
    const service = new HostSetupService(resolveHostPaths(), {
      dependencies: { importCodexAuth },
    });

    await expect(
      service.request(
        envelope("setup/codex/auth/import", { content: '{"tokens":{}}' }),
      ),
    ).rejects.toThrow("Unsupported Codex auth import version");
    expect(importCodexAuth).not.toHaveBeenCalled();
  });
});

function envelope(method: string, payload: unknown): RequestEnvelope {
  return {
    version: 1,
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    method,
    payload,
  };
}

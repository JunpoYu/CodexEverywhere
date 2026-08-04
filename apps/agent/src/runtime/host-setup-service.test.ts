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
        codex: { installed: true, version: "codex-cli 1.2.3" },
        appServerRunning: false,
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
      service.request(envelope("setup/app-server/restart", {})),
    ).resolves.toEqual({
      handled: true,
      value: { running: true, version: "codex-cli 1.2.3" },
    });
    expect(restart).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        codexBinary: "/home/alice/.local/bin/codex",
        env: expect.objectContaining({ HTTPS_PROXY: "http://proxy:7890" }),
      }),
    );
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

import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostConfig } from "../../host/config.js";
import { resolveHostPaths } from "../../host/paths.js";
import type { CodexAppServerClient } from "../../runtime/codex-app-server-client.js";
import { CodexSupervisor } from "./codex-supervisor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
});

describe("CodexSupervisor", () => {
  it("opts production clients into the experimental API used by thread settings", async () => {
    const scope = new Scope("codex-supervisor-test");
    scopes.push(scope);
    const paths = resolveHostPaths({
      CE_HOME: "/tmp/ce-v4-supervisor-test",
      CE_RUNTIME_DIR: "/tmp/ce-v4-supervisor-runtime-test",
    });
    const config: HostConfig = {
      version: 1,
      nodeId: "host-test",
      transport: { mode: "unconfigured" },
      network: { mode: "direct" },
    };
    const client = {} as CodexAppServerClient;
    const connect = vi.fn(async () => client);
    const supervisor = new CodexSupervisor({
      scope,
      paths,
      userHome: "/home/alice",
      dependencies: {
        readConfig: async () => config,
        probeInstallation: async () => ({
          installed: true,
          binary: "/home/alice/.local/bin/codex",
          version: "codex-cli 0.144.1",
        }),
        ensure: async () => ({ started: false }),
        connect,
      },
    });

    await expect(supervisor.connect()).resolves.toBe(client);
    expect(connect).toHaveBeenCalledWith(paths.appServerSocket, {
      experimentalApi: true,
    });
  });
});

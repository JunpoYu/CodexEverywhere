import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializeHost,
  readHostConfig,
  withDirectTransport,
  withRelayTransport,
  writeHostConfig,
} from "./config.js";
import { resolveHostPaths } from "./paths.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("host config", () => {
  it("initializes private host and runtime directories", async () => {
    const base = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(base, "home"),
      CE_RUNTIME_DIR: join(base, "runtime"),
    });

    const config = await initializeHost(paths);

    expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect((await readHostConfig(paths)).nodeId).toBe(config.nodeId);
  });

  it("atomically persists updates", async () => {
    const base = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(base, "home"),
      CE_RUNTIME_DIR: join(base, "runtime"),
    });
    const config = await initializeHost(paths);
    const updated = {
      ...config,
      transport: {
        mode: "direct" as const,
        endpoint: "wss://host.example/ws",
        listenHost: "127.0.0.1",
        listenPort: 7345,
      },
    };

    await writeHostConfig(paths, updated);

    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual(
      updated,
    );
  });

  it("keeps Direct and Relay configured together", () => {
    const relay = withRelayTransport(
      { mode: "unconfigured" },
      {
        endpoint: "wss://relay.example/relay",
        routeId: "route-1",
        routeCapability: "capability",
      },
    );
    expect(
      withDirectTransport(relay, {
        endpoint: "wss://hpc.example/gateway",
        listenHost: "127.0.0.1",
        listenPort: 7345,
      }),
    ).toEqual({
      mode: "hybrid",
      direct: {
        endpoint: "wss://hpc.example/gateway",
        listenHost: "127.0.0.1",
        listenPort: 7345,
      },
      relay: {
        endpoint: "wss://relay.example/relay",
        routeId: "route-1",
        routeCapability: "capability",
      },
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-config-test-"));
  temporaryDirectories.push(path);
  return path;
}

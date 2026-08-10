import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializeHost,
  readHostConfig,
  updateHostConfig,
  withDirectTransport,
  withRelayTransport,
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

    await updateHostConfig(paths, () => updated);

    expect(JSON.parse(await readFile(paths.configFile, "utf8"))).toEqual(
      updated,
    );
  });

  it("serializes concurrent field updates across host config writers", async () => {
    const base = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(base, "home"),
      CE_RUNTIME_DIR: join(base, "runtime"),
    });
    await initializeHost(paths);
    const firstRead = deferred<void>();
    const releaseFirst = deferred<void>();

    const networkUpdate = updateHostConfig(paths, async (config) => {
      firstRead.resolve();
      await releaseFirst.promise;
      return {
        ...config,
        network: {
          mode: "proxy" as const,
          httpsProxy: "http://proxy.example:7890",
        },
      };
    });
    await firstRead.promise;
    const relayUpdate = updateHostConfig(paths, (config) => ({
      ...config,
      transport: withRelayTransport(config.transport, {
        endpoint: "wss://relay.example/relay",
        routeId: "route-1",
        routeCapability: "capability-2",
      }),
    }));
    releaseFirst.resolve();
    await Promise.all([networkUpdate, relayUpdate]);

    expect(await readHostConfig(paths)).toMatchObject({
      network: {
        mode: "proxy",
        httpsProxy: "http://proxy.example:7890",
      },
      transport: {
        mode: "relay",
        endpoint: "wss://relay.example/relay",
        routeId: "route-1",
        routeCapability: "capability-2",
      },
    });
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

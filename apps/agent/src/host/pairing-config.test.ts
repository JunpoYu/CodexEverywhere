import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializeHost,
  withRelayTransport,
  writeHostConfig,
} from "./config.js";
import { readPairingHostConfig } from "./pairing-config.js";
import { resolveHostPaths } from "./paths.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("pairing host configuration", () => {
  it("requests self-service without creating partial user state", async () => {
    const paths = await temporaryPaths();

    await expect(readPairingHostConfig(paths, "alice")).rejects.toThrow(
      "initialize automatically",
    );
    await expect(access(paths.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an initialized host whose transport was never provisioned", async () => {
    const paths = await temporaryPaths();
    await initializeHost(paths);

    await expect(readPairingHostConfig(paths, "alice")).rejects.toThrow(
      "ce device pair",
    );
  });

  it("accepts a fully provisioned host", async () => {
    const paths = await temporaryPaths();
    const config = await initializeHost(paths);
    await writeHostConfig(paths, {
      ...config,
      transport: withRelayTransport(config.transport, {
        endpoint: "wss://relay.example.com/relay",
        routeId: "route-1",
        routeCapability: "capability",
      }),
      webAuthn: {
        origin: "https://codex.example.com",
        rpId: "codex.example.com",
      },
    });

    await expect(readPairingHostConfig(paths, "alice")).resolves.toMatchObject({
      transport: { mode: "relay" },
      webAuthn: { origin: "https://codex.example.com" },
    });
  });
});

async function temporaryPaths() {
  const base = await mkdtemp(join(tmpdir(), "ce-pairing-config-test-"));
  temporaryDirectories.push(base);
  return resolveHostPaths({
    CE_HOME: join(base, "home"),
    CE_RUNTIME_DIR: join(base, "runtime"),
  });
}

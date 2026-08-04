import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapUnixUser,
  userBootstrapInvocations,
  validateExistingUserState,
} from "./user-bootstrap.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const options = {
  account: {
    username: "alice",
    uid: 1001,
    gid: 100,
    home: "/public/home/alice",
    shell: "/bin/bash",
  },
  nodePath: "/public/software/codex-everywhere/runtime/bin/node",
  cliPath: "/public/software/codex-everywhere/current/dist/cli.js",
  origin: "https://codex.example.com",
  relayEndpoint: "wss://codex.example.com/relay",
  routeCapability: "private-route-capability",
};

describe("userBootstrapInvocations", () => {
  it("runs every setup step as the target Unix account with a clean HOME", () => {
    const invocations = userBootstrapInvocations(options);

    expect(invocations.map((item) => item.label)).toEqual([
      "Initialize user state",
      "Configure Passkey origin",
      "Configure Relay",
      "Install user watchdog",
      "Start user Agent",
    ]);
    for (const invocation of invocations) {
      expect(invocation.file).toBe("/sbin/runuser");
      expect(invocation.args.slice(0, 4)).toEqual([
        "-u",
        "alice",
        "--",
        "/usr/bin/env",
      ]);
      expect(invocation.args).toContain("HOME=/public/home/alice");
      expect(invocation.args).toContain("USER=alice");
    }
  });

  it("passes the Relay capability only over stdin", () => {
    const invocations = userBootstrapInvocations(options);
    const relay = invocations.find((item) => item.label === "Configure Relay");

    expect(relay?.args).toContain("--capability-stdin");
    expect(relay?.args.join(" ")).not.toContain("private-route-capability");
    expect(relay?.input).toBe("private-route-capability\n");
  });

  it("stops at the first failed user-scoped operation", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("failed"));

    await expect(bootstrapUnixUser(options, run)).rejects.toThrow("failed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("allows safe bootstrap recovery from an existing user-owned directory", async () => {
    const account = await temporaryAccount();
    await mkdir(join(account.home, ".codex-everywhere"));

    await expect(validateExistingUserState(account)).resolves.toBe(true);
  });

  it("rejects an existing state path that is not a real directory", async () => {
    const account = await temporaryAccount();
    const outside = join(account.home, "outside");
    await writeFile(outside, "not state");
    await symlink(outside, join(account.home, ".codex-everywhere"));

    await expect(validateExistingUserState(account)).rejects.toThrow(
      "target-user-owned directory",
    );
  });
});

async function temporaryAccount() {
  const home = await mkdtemp(join(tmpdir(), "ce-user-bootstrap-test-"));
  temporaryDirectories.push(home);
  return {
    username: "alice",
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    home,
    shell: "/bin/bash",
  };
}

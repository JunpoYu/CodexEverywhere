import { describe, expect, it, vi } from "vitest";

import { inspectSshUnixAccount, parsePasswdEntry } from "./unix-accounts.js";

describe("Unix account eligibility", () => {
  it("accepts an existing NSS account with a home and login shell", async () => {
    await expect(
      inspectSshUnixAccount(
        "alice",
        async () => "alice:x:1003:1003:Alice:/public/home/alice:/bin/bash\n",
      ),
    ).resolves.toEqual({
      eligible: true,
      account: {
        username: "alice",
        uid: 1003,
        gid: 1003,
        home: "/public/home/alice",
        shell: "/bin/bash",
      },
    });
  });

  it("rejects missing, root, and non-login accounts", async () => {
    await expect(
      inspectSshUnixAccount("missing", async () => undefined),
    ).resolves.toMatchObject({
      eligible: false,
      reason: "Unix account not found in NSS",
    });
    await expect(
      inspectSshUnixAccount(
        "root",
        async () => "root:x:0:0:root:/root:/bin/bash\n",
      ),
    ).resolves.toMatchObject({
      eligible: false,
      reason: "root cannot use CodexEverywhere",
    });
    await expect(
      inspectSshUnixAccount(
        "service",
        async () => "service:x:997:997::/var/lib/service:/sbin/nologin\n",
      ),
    ).resolves.toMatchObject({
      eligible: false,
      reason: "Unix account has no login shell",
    });
  });

  it("rejects unsafe names before invoking getent", async () => {
    const runGetent = vi.fn(async () => undefined);
    await expect(
      inspectSshUnixAccount("--help", runGetent),
    ).resolves.toMatchObject({
      eligible: false,
      reason: "invalid Unix username",
    });
    expect(runGetent).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous or malformed NSS output", () => {
    expect(() =>
      parsePasswdEntry(
        "alice:x:1001:1001::/home/alice:/bin/bash\nbob:x:1002:1002::/home/bob:/bin/bash\n",
      ),
    ).toThrow("Ambiguous");
    expect(() => parsePasswdEntry("alice:x:not-a-uid")).toThrow("Invalid");
  });
});

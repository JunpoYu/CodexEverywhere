import { describe, expect, it } from "vitest";

import { savedHostDisplayName, savedHostLoginName } from "./saved-host-view.js";

describe("saved host display", () => {
  it("shows the user-defined device name instead of the host identifier", () => {
    expect(
      savedHostDisplayName({
        name: "node-64f2d8c1",
        deviceName: "Alice 的 MacBook",
      }),
    ).toBe("Alice 的 MacBook");
  });

  it("falls back to the legacy host name when the device name is missing", () => {
    expect(savedHostDisplayName({ name: "node-64f2d8c1" })).toBe(
      "node-64f2d8c1",
    );
  });

  it("shows the Linux login name independently from the device name", () => {
    expect(
      savedHostLoginName({
        name: "alice",
        loginName: "alice",
        nodeId: "node-64f2d8c1",
        userId: "unix:1003",
      }),
    ).toBe("alice");
  });

  it("uses the saved login label for records created before loginName", () => {
    expect(
      savedHostLoginName({
        name: "alice",
        nodeId: "node-64f2d8c1",
        userId: "unix:1003",
      }),
    ).toBe("alice");
  });

  it("does not present a legacy node ID as a username", () => {
    expect(
      savedHostLoginName({
        name: "node-64f2d8c1",
        nodeId: "node-64f2d8c1",
        userId: "unix:1003",
      }),
    ).toBe("UID 1003");
  });
});

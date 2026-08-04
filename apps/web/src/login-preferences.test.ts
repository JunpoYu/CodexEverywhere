import { describe, expect, it } from "vitest";

import {
  devicePersistenceMode,
  rememberDeviceForLogin,
} from "./login-preferences.js";

describe("login device persistence defaults", () => {
  it("remembers the primary Passkey flow by default", () => {
    expect(
      rememberDeviceForLogin("passkey", {
        alternativeLoginOpen: false,
        checkboxChecked: false,
      }),
    ).toBe(true);
  });

  it("keeps password login temporary until the user opts in", () => {
    expect(
      rememberDeviceForLogin("password", {
        alternativeLoginOpen: true,
        checkboxChecked: false,
      }),
    ).toBe(false);
  });

  it("honors an explicit remember-device choice for password login", () => {
    expect(
      rememberDeviceForLogin("password", {
        alternativeLoginOpen: true,
        checkboxChecked: true,
      }),
    ).toBe(true);
  });
});

describe("login device naming", () => {
  it("does not ask for a name during temporary login", () => {
    expect(devicePersistenceMode(false)).toBe("temporary");
  });

  it("reuses the saved name for an existing browser device", () => {
    expect(devicePersistenceMode(true, "Alice 的 MacBook")).toBe("existing");
  });

  it("asks for a name only when remembering a new device", () => {
    expect(devicePersistenceMode(true)).toBe("new");
  });
});

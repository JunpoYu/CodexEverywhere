import { describe, expect, it } from "vitest";

import { rememberDeviceForLogin } from "./login-preferences.js";

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

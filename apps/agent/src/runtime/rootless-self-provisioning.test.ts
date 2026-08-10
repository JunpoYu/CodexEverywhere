import { describe, expect, it } from "vitest";

import {
  ROOTLESS_ADMIN_RELAY_RENEWAL_FEATURE,
  ROOTLESS_RELAY_RENEWAL_FEATURE,
} from "./rootless-provisioning-protocol.js";
import {
  RootlessProvisionerUnavailableError,
  assertRootlessProvisionerSupportsAdminRelayRenewal,
  assertRootlessProvisionerSupportsRelayRenewal,
} from "./rootless-self-provisioning.js";

describe("rootless self-provisioning feature negotiation", () => {
  it("fails closed instead of letting an old provisioner issue a new route", () => {
    for (const features of [undefined, [], ["future-feature"]]) {
      expect(() =>
        assertRootlessProvisionerSupportsRelayRenewal(features),
      ).toThrow(RootlessProvisionerUnavailableError);
    }
    expect(() =>
      assertRootlessProvisionerSupportsRelayRenewal([
        ROOTLESS_RELAY_RENEWAL_FEATURE,
        "future-feature",
      ]),
    ).not.toThrow();
  });

  it("negotiates administrator renewal separately from ordinary user renewal", () => {
    expect(() =>
      assertRootlessProvisionerSupportsAdminRelayRenewal([
        ROOTLESS_RELAY_RENEWAL_FEATURE,
      ]),
    ).toThrow(RootlessProvisionerUnavailableError);
    expect(() =>
      assertRootlessProvisionerSupportsAdminRelayRenewal([
        ROOTLESS_ADMIN_RELAY_RENEWAL_FEATURE,
      ]),
    ).not.toThrow();
  });
});

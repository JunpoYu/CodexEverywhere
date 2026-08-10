import { describe, expect, it } from "vitest";

import { ROOTLESS_RELAY_RENEWAL_FEATURE } from "./rootless-provisioning-protocol.js";
import {
  RootlessProvisionerUnavailableError,
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
});

import { describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
  issueProvisionedRouteCapability,
  issueRouteCapability,
  normalizeLoginName,
  relayLoginId,
  relayPrincipalLoginId,
  routeCapabilityLoginId,
  verifyRouteCapability,
} from "./capability.js";

describe("route capability", () => {
  it("is self-contained and detects tampering", () => {
    const key = generateRelaySigningKey();
    const issued = issueRouteCapability(key);
    expect(verifyRouteCapability(issued.capability, key)).toEqual(
      issued.payload,
    );
    const [body, signature] = issued.capability.split(".") as [string, string];
    const tampered = `${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(() => verifyRouteCapability(tampered, key)).toThrow();
  });

  it("rejects expiration", () => {
    const key = generateRelaySigningKey();
    const issued = issueRouteCapability(key, { expiresAt: new Date(1_000) });
    expect(() =>
      verifyRouteCapability(issued.capability, key, new Date(2_000)),
    ).toThrow("expired");
  });

  it("binds an exact Unix login name without exposing it", () => {
    const key = generateRelaySigningKey();
    const issued = issueRouteCapability(key, {
      loginName: "  alice  ",
    });
    expect(issued.payload.loginId).toBe(relayLoginId(key, "alice"));
    expect(issued.capability).not.toContain("alice");
    expect(normalizeLoginName(" alice ")).toBe("alice");
    expect(normalizeLoginName("Alice")).toBe("Alice");
    expect(() => normalizeLoginName("alice@hpc-cluster-1")).toThrow("Invalid");
    expect(() => normalizeLoginName("../alice")).toThrow("Invalid");
  });

  it("reissues an existing route while adding login discovery", () => {
    const key = generateRelaySigningKey();
    const original = issueRouteCapability(key);
    const reissued = issueRouteCapability(key, {
      routeId: original.payload.routeId,
      loginName: "alice",
    });
    expect(reissued.payload.routeId).toBe(original.payload.routeId);
    expect(reissued.payload.loginId).toBeDefined();
  });

  it("lets one host provision existing Unix users without the Relay master key", () => {
    const key = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const route = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "bob" },
      new Date("2029-01-01T00:00:00.000Z"),
    );

    const verified = verifyRouteCapability(
      route.capability,
      key,
      new Date("2029-01-02T00:00:00.000Z"),
    );
    expect(verified).toEqual(route.payload);
    expect(routeCapabilityLoginId(verified, key)).toBe(
      relayLoginId(key, "bob"),
    );
    expect(provisioner.signingKey).not.toBe(
      Buffer.from(key).toString("base64url"),
    );
  });

  it("scopes provisioner signatures to one installation and expiration", () => {
    const key = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const route = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "alice" },
      new Date("2029-01-01T00:00:00.000Z"),
    );
    const [body, signature] = route.capability.split(".") as [string, string];
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload.installationId = "another-host";
    const changedBody = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );

    expect(() =>
      verifyRouteCapability(
        `${changedBody}.${signature}`,
        key,
        new Date("2029-01-02T00:00:00.000Z"),
      ),
    ).toThrow("signature");
    expect(() =>
      verifyRouteCapability(
        route.capability,
        key,
        new Date("2030-01-02T00:00:00.000Z"),
      ),
    ).toThrow("provisioner credential has expired");
  });

  it("separates administrator discovery from an identical Unix login name", () => {
    const key = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const user = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "admin" },
      new Date("2029-01-01T00:00:00.000Z"),
    );
    const administrator = issueProvisionedAdminRouteCapability(
      provisioner,
      { adminHandle: "admin" },
      new Date("2029-01-01T00:00:00.000Z"),
    );

    expect(user.payload.principal).toBe("user");
    expect(administrator.payload.principal).toBe("host-admin");
    expect(routeCapabilityLoginId(user.payload, key)).toBe(
      relayLoginId(key, "admin"),
    );
    expect(routeCapabilityLoginId(administrator.payload, key)).toBe(
      relayPrincipalLoginId(key, "host-admin", "admin"),
    );
    expect(routeCapabilityLoginId(administrator.payload, key)).not.toBe(
      routeCapabilityLoginId(user.payload, key),
    );
  });
});

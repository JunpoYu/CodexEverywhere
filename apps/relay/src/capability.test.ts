import { describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
  issueProvisionedRouteCapability,
  issueRouteCapability,
  normalizeLoginName,
  relayInstallationPrincipalLoginId,
  relayLoginId,
  routeCapabilityLoginId,
  routeCapabilityOwnerId,
  routeCapabilityPrincipal,
  verifyRouteCapability,
  verifyProvisionedUserRouteForRenewal,
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
      relayInstallationPrincipalLoginId(key, "hpc-cluster-1", "user", "bob"),
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
    expect(routeCapabilityPrincipal(administrator.payload)).toBe("host-admin");
    expect(routeCapabilityLoginId(user.payload, key)).toBe(
      relayInstallationPrincipalLoginId(key, "hpc-cluster-1", "user", "admin"),
    );
    expect(routeCapabilityLoginId(administrator.payload, key)).toBe(
      relayInstallationPrincipalLoginId(
        key,
        "hpc-cluster-1",
        "host-admin",
        "admin",
      ),
    );
    expect(routeCapabilityLoginId(administrator.payload, key)).not.toBe(
      routeCapabilityLoginId(user.payload, key),
    );
  });

  it("scopes provisioned discovery and owner IDs to one installation", () => {
    const key = generateRelaySigningKey();
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    const now = new Date("2029-01-01T00:00:00.000Z");
    const victimProvisioner = issueHostProvisionerCredential(key, {
      installationId: "victim-cluster",
      expiresAt,
    });
    const attackerProvisioner = issueHostProvisionerCredential(key, {
      installationId: "attacker-cluster",
      expiresAt,
    });
    const victim = issueProvisionedRouteCapability(
      victimProvisioner,
      { loginName: "alice", routeId: "A".repeat(32) },
      now,
    );
    const attacker = issueProvisionedRouteCapability(
      attackerProvisioner,
      { loginName: "alice", routeId: victim.payload.routeId },
      now,
    );

    expect(attacker.payload.routeId).toBe(victim.payload.routeId);
    expect(routeCapabilityLoginId(attacker.payload, key)).not.toBe(
      routeCapabilityLoginId(victim.payload, key),
    );
    expect(routeCapabilityOwnerId(attacker.payload, key)).not.toBe(
      routeCapabilityOwnerId(victim.payload, key),
    );
    expect(verifyRouteCapability(victim.capability, key, now)).toEqual(
      victim.payload,
    );
    expect(verifyRouteCapability(attacker.capability, key, now)).toEqual(
      attacker.payload,
    );
  });

  it("renews an existing v4 route without changing its persisted route ID", () => {
    const key = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const current = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "alice" },
      new Date("2029-01-01T00:00:00.000Z"),
    );
    const renewed = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "alice", routeId: current.payload.routeId },
      new Date("2029-01-02T00:00:00.000Z"),
    );

    expect(renewed.payload.version).toBe(4);
    expect(renewed.payload.routeId).toBe(current.payload.routeId);
    expect(
      verifyRouteCapability(
        renewed.capability,
        key,
        new Date("2029-01-03T00:00:00.000Z"),
      ),
    ).toEqual(renewed.payload);
  });

  it("accepts a renewal proof only for its exact live credential and user", () => {
    const key = generateRelaySigningKey();
    const oldCredential = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const nextCredential = issueHostProvisionerCredential(key, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    });
    const route = issueProvisionedRouteCapability(
      oldCredential,
      { loginName: "alice" },
      new Date("2029-01-01T00:00:00.000Z"),
    );

    expect(
      verifyProvisionedUserRouteForRenewal(
        route.capability,
        oldCredential,
        { loginName: "alice" },
        new Date("2029-12-01T00:00:00.000Z"),
      ),
    ).toEqual(route.payload);
    expect(() =>
      verifyProvisionedUserRouteForRenewal(
        route.capability,
        nextCredential,
        { loginName: "alice" },
        new Date("2029-12-01T00:00:00.000Z"),
      ),
    ).toThrow("does not belong");
    expect(() =>
      verifyProvisionedUserRouteForRenewal(
        route.capability,
        oldCredential,
        { loginName: "bob" },
        new Date("2029-12-01T00:00:00.000Z"),
      ),
    ).toThrow("does not belong");
    expect(() =>
      verifyProvisionedUserRouteForRenewal(
        route.capability,
        oldCredential,
        { loginName: "alice" },
        new Date("2030-01-01T00:00:00.001Z"),
      ),
    ).toThrow("expired");
  });
});

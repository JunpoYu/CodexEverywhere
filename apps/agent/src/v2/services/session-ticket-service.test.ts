import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionTicketService } from "./session-ticket-service.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  vi.useRealTimers();
});

describe("SessionTicketService", () => {
  it("binds an in-memory ticket to the Noise device key", () => {
    const scope = new Scope("tickets-test");
    scopes.push(scope);
    const tickets = new SessionTicketService({ scope });
    const key = new Uint8Array(32).fill(1);
    const token = tickets.issue({
      deviceId: "browser-1",
      devicePublicKey: key,
      principalId: "user:alice",
      temporary: true,
    });

    expect(tickets.verify(token, { id: "browser-1", publicKey: key })).toEqual(
      expect.objectContaining({ principalId: "user:alice", temporary: true }),
    );
    expect(
      tickets.verify(token, {
        id: "browser-1",
        publicKey: new Uint8Array(32).fill(2),
      }),
    ).toBeUndefined();
    expect(
      tickets.verify(token, { id: "browser-2", publicKey: key }),
    ).toBeUndefined();
  });

  it("expires and revokes tickets without persistence", () => {
    vi.useFakeTimers();
    const scope = new Scope("tickets-test");
    scopes.push(scope);
    const tickets = new SessionTicketService({ scope, ttlMs: 1_000 });
    const key = new Uint8Array(32).fill(1);
    const binding = {
      deviceId: "browser-1",
      devicePublicKey: key,
      principalId: "user:alice",
      temporary: false,
    } as const;
    const revoked = tickets.issue(binding);
    tickets.revokeDevice("browser-1");
    expect(
      tickets.verify(revoked, { id: "browser-1", publicKey: key }),
    ).toBeUndefined();

    const expired = tickets.issue(binding);
    vi.advanceTimersByTime(1_001);
    expect(
      tickets.verify(expired, { id: "browser-1", publicKey: key }),
    ).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isKnownCodexNotification } from "./notification-schema.js";

const fixtures = readFileSync(
  new URL("./fixtures/app-server-synthetic.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Fixture);

describe("synthetic Codex app-server protocol fixtures", () => {
  it("replays generated notification classification", () => {
    const notifications = fixtures.filter(
      (fixture): fixture is NotificationFixture =>
        fixture.kind === "notification",
    );
    expect(notifications.length).toBeGreaterThan(0);
    for (const fixture of notifications) {
      expect(isKnownCodexNotification(fixture.message)).toBe(fixture.known);
    }
  });

  it("contains versioned notification, server-request, and error samples only", () => {
    expect(new Set(fixtures.map((fixture) => fixture.kind))).toEqual(
      new Set(["notification", "server-request", "error-response"]),
    );
    for (const fixture of fixtures) expect(fixture.version).toBe(1);
    const serialized = JSON.stringify(fixtures);
    expect(serialized).not.toMatch(/recovery.?code|auth\.json|\/home\//iu);
  });
});

type Fixture = NotificationFixture | ServerRequestFixture | ErrorFixture;

interface NotificationFixture {
  readonly version: 1;
  readonly kind: "notification";
  readonly known: boolean;
  readonly message: { readonly method: string; readonly params: unknown };
}

interface ServerRequestFixture {
  readonly version: 1;
  readonly kind: "server-request";
  readonly message: {
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
  };
}

interface ErrorFixture {
  readonly version: 1;
  readonly kind: "error-response";
  readonly message: {
    readonly id: string;
    readonly error: { readonly code: number; readonly message: string };
  };
}

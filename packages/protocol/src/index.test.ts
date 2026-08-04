import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, requestEnvelope } from "./index.js";

describe("requestEnvelope", () => {
  it("creates a versioned idempotent request", () => {
    expect(
      requestEnvelope(
        "thread.list",
        { limit: 20 },
        { requestId: "r1", idempotencyKey: "i1" },
      ),
    ).toEqual({
      version: PROTOCOL_VERSION,
      requestId: "r1",
      idempotencyKey: "i1",
      method: "thread.list",
      payload: { limit: 20 },
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  RetryableClientPreparationError,
  prepareClientForBinding,
} from "./client-activation.js";

describe("prepareClientForBinding", () => {
  it("negotiates continuity acknowledgements before returning the client", async () => {
    const client = {
      enableSideContinuityAcknowledgements: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    };

    await expect(prepareClientForBinding(client)).resolves.toBe(client);
    expect(client.enableSideContinuityAcknowledgements).toHaveBeenCalledOnce();
    expect(client.close).not.toHaveBeenCalled();
  });

  it("closes an unbound client when negotiation fails", async () => {
    const error = new Error("negotiation failed");
    const client = {
      enableSideContinuityAcknowledgements: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
    };

    await expect(prepareClientForBinding(client)).rejects.toBe(error);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("classifies silent-resume negotiation failures for another attempt", async () => {
    const cause = new Error("transient state-store failure");
    const client = {
      enableSideContinuityAcknowledgements: vi.fn().mockRejectedValue(cause),
      close: vi.fn(),
    };

    const failure = await prepareClientForBinding(client, {
      retryOnFailure: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryableClientPreparationError);
    expect((failure as Error).cause).toBe(cause);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

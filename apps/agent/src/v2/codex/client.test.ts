import { GatewayV2Error } from "@codex-everywhere/protocol/v2";
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerClient,
  CodexRpcError,
} from "../../runtime/codex-app-server-client.js";
import { CodexClientAdapter } from "./client.js";

describe("CodexClientAdapter", () => {
  it("classifies an explicit app-server rejection as a definitive Gateway error", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValue(
          new CodexRpcError({ code: -32_602, message: "bad" }),
        ),
    } as unknown as CodexAppServerClient;
    const adapter = new CodexClientAdapter(client);

    const error = await adapter
      .request("thread/settings/update", { threadId: "thread-1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayV2Error);
    expect(error).toMatchObject({
      code: "CODEX_REQUEST_REJECTED",
      message: "Codex app-server rejected the request",
      cause: expect.objectContaining({
        name: "CodexRpcError",
        code: -32_602,
      }),
    });
  });

  it("preserves transport failures for mutation outcome reconciliation", async () => {
    const transportFailure = new Error("connection closed");
    const client = {
      request: vi.fn().mockRejectedValue(transportFailure),
    } as unknown as CodexAppServerClient;
    const adapter = new CodexClientAdapter(client);

    await expect(adapter.request("thread/read", {})).rejects.toBe(
      transportFailure,
    );
  });
});

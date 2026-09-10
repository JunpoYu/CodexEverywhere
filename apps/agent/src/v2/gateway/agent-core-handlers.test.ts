import {
  GatewayV2Error,
  GatewayV2Router,
  type GatewayHandler,
} from "@codex-everywhere/protocol/v2";
import { expect, it, vi } from "vitest";
import {
  registerAgentCoreHandlers,
  type AgentCoreHandlerServices,
} from "./agent-core-handlers.js";
import type { AgentGatewayContext } from "./agent-gateway-session.js";

it("keeps an opened task usable after its deletion is rejected", async () => {
  const router = new GatewayV2Router<AgentGatewayContext>({
    run: async (_invocation, execute) => execute(),
  });
  const registered = vi.spyOn(router, "register");
  const remove = vi
    .fn()
    .mockRejectedValueOnce(
      new GatewayV2Error("SIDE_UNAVAILABLE", "End the side first"),
    )
    .mockResolvedValue(true);
  const services = {
    threads: { delete: remove },
  } as unknown as AgentCoreHandlerServices;
  registerAgentCoreHandlers(router, services);
  const handler = registered.mock.calls.find(
    ([method]) => method === "thread/delete",
  )![1] as GatewayHandler<"thread/delete", AgentGatewayContext>;
  const closeThread = vi.fn(async () => undefined);
  const context = {
    session: { closeThread },
  } as unknown as AgentGatewayContext;
  const input = { version: 1 as const, threadId: "parent" };
  await expect(handler(input, context)).rejects.toMatchObject({
    code: "SIDE_UNAVAILABLE",
  });
  expect(closeThread).not.toHaveBeenCalled();
  await expect(handler(input, context)).resolves.toEqual({
    version: 1,
    deleted: true,
  });
  expect(closeThread).toHaveBeenCalledExactlyOnceWith("parent");
});

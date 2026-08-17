import { describe, expect, it, vi } from "vitest";

import type { CodexServerRequest } from "../../runtime/codex-app-server-client.js";
import { InteractionBroker } from "./interaction-broker.js";

describe("InteractionBroker", () => {
  it("adapts CE approval decisions to current and legacy Codex responses", async () => {
    const broker = new InteractionBroker();
    const current = request("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const legacy = request("execCommandApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const currentInteraction = broker.add(current.value, "thread-1");
    const legacyInteraction = broker.add(legacy.value, "thread-1");

    await broker.respond(currentInteraction.id, {
      version: 1,
      kind: "approval",
      decision: "accept",
    });
    await broker.respond(legacyInteraction.id, {
      version: 1,
      kind: "approval",
      decision: "decline",
    });

    expect(current.respond).toHaveBeenCalledWith({ decision: "accept" });
    expect(legacy.respond).toHaveBeenCalledWith({
      decision: { denied: { rejection: "Declined by user" } },
    });
  });

  it("rejects declined permission requests and grants only requested fields", async () => {
    const broker = new InteractionBroker();
    const declined = request("item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      permissions: { network: { enabled: true } },
    });
    const accepted = request("item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/public"] },
      },
    });

    const first = broker.add(declined.value, "thread-1");
    const second = broker.add(accepted.value, "thread-1");
    await broker.respond(first.id, {
      version: 1,
      kind: "approval",
      decision: "decline",
    });
    await broker.respond(second.id, {
      version: 1,
      kind: "approval",
      decision: "accept",
    });

    expect(declined.reject).toHaveBeenCalledWith({
      code: -32_000,
      message: "Declined by user",
    });
    expect(accepted.respond).toHaveBeenCalledWith({
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/public"] },
      },
      scope: "turn",
    });
  });

  it("adapts question answers and MCP elicitation content", async () => {
    const broker = new InteractionBroker();
    const question = request("item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [],
    });
    const mcp = request("mcpServer/elicitation/request", {
      threadId: "thread-1",
      turnId: "turn-1",
      mode: "form",
    });
    const questionInteraction = broker.add(question.value, "thread-1");
    const mcpInteraction = broker.add(mcp.value, "thread-1");

    await broker.respond(questionInteraction.id, {
      version: 1,
      kind: "user-input",
      answers: { target: ["GPU", "CPU"] },
    });
    await broker.respond(mcpInteraction.id, {
      version: 1,
      kind: "mcp-elicitation",
      action: "accept",
      content: { project: "CE" },
    });

    expect(question.respond).toHaveBeenCalledWith({
      answers: { target: { answers: ["GPU", "CPU"] } },
    });
    expect(mcp.respond).toHaveBeenCalledWith({
      action: "accept",
      content: { project: "CE" },
      _meta: null,
    });
  });
});

function request(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  const reject = vi.fn();
  return {
    value: {
      id: crypto.randomUUID(),
      method,
      params,
      respond,
      reject,
    } satisfies CodexServerRequest,
    respond,
    reject,
  };
}

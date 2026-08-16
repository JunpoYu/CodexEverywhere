import { TypedEventBus } from "@codex-everywhere/kernel";
import type {
  InteractionResponse,
  JsonValue,
} from "@codex-everywhere/protocol/v2";

import type { CodexServerRequest } from "../../runtime/codex-app-server-client.js";

export type InteractionKind = "approval" | "user-question" | "mcp-elicitation";

export interface PendingInteraction {
  readonly version: 1;
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly kind: InteractionKind;
  readonly requestMethod: string;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface InteractionBrokerEvents {
  readonly created: PendingInteraction;
  readonly resolved: { readonly interactionId: string };
  readonly failed: { readonly interactionId: string; readonly reason: string };
}

interface BrokerEntry {
  readonly interaction: PendingInteraction;
  readonly request: CodexServerRequest;
  state: "pending" | "responding";
}

export class InteractionAlreadyResolvedError extends Error {
  constructor(readonly interactionId: string) {
    super("Interaction is no longer pending");
    this.name = "InteractionAlreadyResolvedError";
  }
}

/** Owns only live callbacks from one app-server client; nothing is persisted. */
export class InteractionBroker {
  readonly #entries = new Map<string, BrokerEntry>();
  readonly events = new TypedEventBus<InteractionBrokerEvents>();

  add(
    request: CodexServerRequest,
    expectedThreadId: string,
  ): PendingInteraction {
    const payload = jsonObject(request.params);
    const threadId = requiredString(payload.threadId, "interaction threadId");
    if (threadId !== expectedThreadId) {
      request.reject({ code: -32_000, message: "Thread lease mismatch" });
      throw new Error(
        "App-server request does not belong to this thread lease",
      );
    }
    const id = interactionId(threadId, request.id);
    if (this.#entries.has(id)) {
      request.reject({ code: -32_000, message: "Duplicate interaction" });
      throw new Error("App-server sent a duplicate interaction ID");
    }
    const turnId = optionalString(payload.turnId);
    const interaction: PendingInteraction = {
      version: 1,
      id,
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      kind: interactionKind(request.method),
      requestMethod: request.method,
      createdAt: new Date().toISOString(),
      payload,
    };
    this.#entries.set(id, { interaction, request, state: "pending" });
    this.events.emit("created", interaction);
    return interaction;
  }

  list(): PendingInteraction[] {
    return [...this.#entries.values()].map((entry) => entry.interaction);
  }

  get size(): number {
    return this.#entries.size;
  }

  async respond(
    interactionIdValue: string,
    response: InteractionResponse,
  ): Promise<void> {
    const entry = this.#entries.get(interactionIdValue);
    if (entry === undefined || entry.state !== "pending") {
      throw new InteractionAlreadyResolvedError(interactionIdValue);
    }
    const adapted = adaptInteractionResponse(entry, response);
    // Claim synchronously before touching the callback. Concurrent devices can
    // observe only one successful transition.
    entry.state = "responding";
    this.#entries.delete(interactionIdValue);
    try {
      if ("error" in adapted) entry.request.reject(adapted.error);
      else entry.request.respond(adapted.result);
      this.events.emit("resolved", { interactionId: interactionIdValue });
    } catch (error) {
      this.events.emit("failed", {
        interactionId: interactionIdValue,
        reason: "response-failed",
      });
      throw error;
    }
  }

  failAll(reason: string): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      if (entry.state !== "pending") continue;
      try {
        entry.request.reject({ code: -32_000, message: reason });
      } catch {
        // The client may already be gone. The broker state still resolves as failed.
      }
      this.events.emit("failed", {
        interactionId: entry.interaction.id,
        reason,
      });
    }
  }
}

function adaptInteractionResponse(
  entry: BrokerEntry,
  response: InteractionResponse,
):
  | { readonly result: JsonValue }
  | { readonly error: { readonly code: number; readonly message: string } } {
  const method = entry.request.method;
  if (entry.interaction.kind === "approval") {
    if (response.kind !== "approval") throw responseKindMismatch();
    if (method === "item/permissions/requestApproval") {
      if (response.decision === "decline") {
        return {
          error: { code: -32_000, message: "Declined by user" },
        };
      }
      return { result: permissionGrant(entry.interaction.payload) };
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      return {
        result: {
          decision:
            response.decision === "accept"
              ? "approved"
              : { denied: { rejection: "Declined by user" } },
        },
      };
    }
    return {
      result: {
        decision: response.decision === "accept" ? "accept" : "decline",
      },
    };
  }
  if (entry.interaction.kind === "user-question") {
    if (response.kind !== "user-input") throw responseKindMismatch();
    return {
      result: {
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([id, answers]) => [
            id,
            { answers },
          ]),
        ),
      },
    };
  }
  if (response.kind !== "mcp-elicitation") throw responseKindMismatch();
  return {
    result: {
      action: response.action,
      content: response.content ?? null,
      _meta: null,
    },
  };
}

function permissionGrant(
  payload: Readonly<Record<string, JsonValue>>,
): JsonValue {
  const source = jsonRecord(payload.permissions);
  const permissions: Record<string, JsonValue> = {};
  if (source.network !== undefined && source.network !== null) {
    permissions.network = source.network;
  }
  if (source.fileSystem !== undefined && source.fileSystem !== null) {
    permissions.fileSystem = source.fileSystem;
  }
  return { permissions, scope: "turn" };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, JsonValue>;
}

function responseKindMismatch(): Error {
  return new Error(
    "Interaction response kind does not match the pending request",
  );
}

function interactionKind(method: string): InteractionKind {
  if (method === "item/tool/requestUserInput") return "user-question";
  if (method === "mcpServer/elicitation/request") return "mcp-elicitation";
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval"
  ) {
    return "approval";
  }
  throw new Error(`Unsupported interactive server request: ${method}`);
}

function interactionId(threadId: string, requestId: string | number): string {
  return `interaction:${threadId}:${String(requestId)}`;
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Interaction params must be a JSON object");
  }
  assertJsonValue(value);
  return value as Record<string, JsonValue>;
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry);
    }
    return;
  }
  throw new Error("Interaction params are not JSON-compatible");
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

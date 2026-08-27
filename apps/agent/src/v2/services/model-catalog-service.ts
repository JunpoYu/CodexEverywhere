import { randomUUID } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  type InputOf,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { parseCodexObject } from "../codex/codex-json.js";

type ModelCatalogItem = OutputOf<"model/list">["models"][number];

/** Projects the app-server model catalog into CE's stable, versioned contract. */
export class ModelCatalogService {
  readonly #scope: Scope;
  readonly #clients: CodexClientFactoryPort;

  constructor(options: {
    readonly scope: Scope;
    readonly clients: CodexClientFactoryPort;
  }) {
    this.#scope = options.scope.fork("model-catalog");
    this.#clients = options.clients;
  }

  async list(input: InputOf<"model/list">): Promise<OutputOf<"model/list">> {
    const scope = this.#scope.fork(`page-${randomUUID()}`);
    try {
      const client = await this.#clients.create(scope);
      const response = parseCodexObject(
        await client.request("model/list", {
          limit: input.limit,
          includeHidden: false,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
        "model/list response",
      );
      if (!Array.isArray(response.data)) {
        throw invalidCatalog();
      }
      const models = response.data.map((value) => projectModel(value));
      const nextCursor = optionalString(response.nextCursor);
      return {
        version: 1,
        models,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        hasMore: nextCursor !== undefined,
      };
    } finally {
      await scope.close("model-catalog-page-complete");
    }
  }
}

function projectModel(value: JsonValue): ModelCatalogItem {
  const model = parseCodexObject(value, "model catalog entry");
  if (!Array.isArray(model.supportedReasoningEfforts)) {
    throw invalidCatalog();
  }
  const supportedEfforts = model.supportedReasoningEfforts.map((value) => {
    const option = parseCodexObject(value, "reasoning effort option");
    return {
      effort: requiredString(option.reasoningEffort),
      description: optionalString(option.description) ?? "",
    };
  });
  return {
    version: 1,
    id: requiredString(model.id),
    model: requiredString(model.model),
    displayName: requiredString(model.displayName),
    description: optionalString(model.description) ?? "",
    isDefault: model.isDefault === true,
    defaultEffort: requiredString(model.defaultReasoningEffort),
    supportedEfforts,
  };
}

function requiredString(value: JsonValue | undefined): string {
  const parsed = optionalString(value);
  if (parsed === undefined) throw invalidCatalog();
  return parsed;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidCatalog(): GatewayV2Error {
  return new GatewayV2Error(
    "CODEX_INVALID_RESPONSE",
    "Codex app-server returned an invalid model catalog",
  );
}

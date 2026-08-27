import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { ModelCatalogService } from "./model-catalog-service.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
});

describe("ModelCatalogService", () => {
  it("projects only stable model picker fields", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          id: "model-id",
          model: "gpt-example",
          displayName: "GPT Example",
          description: "Example model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
          ],
          futureField: { ignored: true },
        },
      ],
      nextCursor: "next-page",
    });
    const client = fakeClient(request);
    const service = createService(client);

    await expect(service.list({ version: 1, limit: 50 })).resolves.toEqual({
      version: 1,
      models: [
        {
          version: 1,
          id: "model-id",
          model: "gpt-example",
          displayName: "GPT Example",
          description: "Example model",
          isDefault: true,
          defaultEffort: "medium",
          supportedEfforts: [
            { effort: "low", description: "Fast" },
            { effort: "medium", description: "Balanced" },
          ],
        },
      ],
      nextCursor: "next-page",
      hasMore: true,
    });
    expect(request).toHaveBeenCalledWith("model/list", {
      limit: 50,
      includeHidden: false,
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("fails closed when app-server omits required catalog fields", async () => {
    const service = createService(
      fakeClient(
        vi.fn().mockResolvedValue({
          data: [{ id: "incomplete" }],
          nextCursor: null,
        }),
      ),
    );

    await expect(service.list({ version: 1, limit: 50 })).rejects.toMatchObject(
      { code: "CODEX_INVALID_RESPONSE" },
    );
  });
});

function createService(client: CodexClient): ModelCatalogService {
  const scope = new Scope("model-catalog-test");
  scopes.push(scope);
  const factory: CodexClientFactoryPort = {
    create: async (owner) => {
      owner.defer(() => client.close());
      return client;
    },
  };
  return new ModelCatalogService({ scope, clients: factory });
}

function fakeClient(request: ReturnType<typeof vi.fn>): CodexClient {
  return {
    request: request as unknown as CodexClient["request"],
    onNotification: () => () => undefined,
    onServerRequest: () => () => undefined,
    onClose: () => () => undefined,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

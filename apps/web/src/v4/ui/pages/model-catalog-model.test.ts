import { describe, expect, it } from "vitest";

import {
  catalogModel,
  effortAfterModelChange,
  effortSupported,
} from "./model-catalog-model.js";

const models = [
  {
    version: 1 as const,
    id: "sol-id",
    model: "gpt-sol",
    displayName: "Sol",
    description: "",
    isDefault: true,
    defaultEffort: "low",
    supportedEfforts: [
      { effort: "low", description: "" },
      { effort: "ultra", description: "" },
    ],
  },
  {
    version: 1 as const,
    id: "luna-id",
    model: "gpt-luna",
    displayName: "Luna",
    description: "",
    isDefault: false,
    defaultEffort: "medium",
    supportedEfforts: [{ effort: "medium", description: "" }],
  },
];

describe("model catalog form projection", () => {
  it("uses the catalog default for an omitted model", () => {
    expect(catalogModel(models, "")?.model).toBe("gpt-sol");
    expect(effortSupported(models, "", "ultra")).toBe(true);
  });

  it("reconciles an unsupported effort according to the form boundary", () => {
    expect(effortAfterModelChange(models, "gpt-luna", "ultra", "omit")).toBe(
      "",
    );
    expect(effortAfterModelChange(models, "gpt-luna", "ultra", "default")).toBe(
      "medium",
    );
  });
});

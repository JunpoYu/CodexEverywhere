import type { ModelCatalogItem } from "../../actors/model-catalog-actor.js";

export function catalogModel(
  models: readonly ModelCatalogItem[],
  value: string,
): ModelCatalogItem | undefined {
  if (value.length === 0) return defaultCatalogModel(models);
  return models.find((model) => model.model === value || model.id === value);
}

export function defaultCatalogModel(
  models: readonly ModelCatalogItem[],
): ModelCatalogItem | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

export function supportedEfforts(
  models: readonly ModelCatalogItem[],
  model: string,
): readonly ModelCatalogItem["supportedEfforts"][number][] {
  return catalogModel(models, model)?.supportedEfforts ?? [];
}

export function effortSupported(
  models: readonly ModelCatalogItem[],
  model: string,
  effort: string,
): boolean {
  return (
    effort.length === 0 ||
    supportedEfforts(models, model).some((option) => option.effort === effort)
  );
}

export function effortAfterModelChange(
  models: readonly ModelCatalogItem[],
  model: string,
  effort: string,
  fallback: "default" | "omit",
): string {
  if (effortSupported(models, model, effort)) return effort;
  if (fallback === "omit") return "";
  return catalogModel(models, model)?.defaultEffort ?? "";
}

import type { ModelCatalogState } from "../../actors/model-catalog-actor.js";
import { reasoningEffortLabel } from "../formatters/thread-settings.js";
import { catalogModel, supportedEfforts } from "./model-catalog-model.js";
import styles from "./ModelEffortFields.module.css";

export function ModelEffortFields(input: {
  readonly catalog: ModelCatalogState;
  readonly model: string;
  readonly effort: string;
  readonly disabled?: boolean;
  readonly defaultModelLabel: string;
  readonly showDefaultModelOption?: boolean;
  readonly showDefaultEffortOption?: boolean;
  readonly modelAriaLabel: string;
  readonly effortAriaLabel: string;
  readonly onModelChange: (model: string) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly onRetry: () => void;
}) {
  const selected = catalogModel(input.catalog.models, input.model);
  const efforts = supportedEfforts(input.catalog.models, input.model);
  const modelIsUnknown =
    input.model.length > 0 &&
    !input.catalog.models.some(
      (model) => model.model === input.model || model.id === input.model,
    );
  const effortIsUnknown =
    input.effort.length > 0 &&
    !efforts.some((option) => option.effort === input.effort);
  const defaultEffort = selected?.defaultEffort;

  return (
    <div className={styles.fields}>
      <label>
        <span>模型</span>
        <select
          aria-label={input.modelAriaLabel}
          disabled={input.disabled}
          value={input.model}
          onChange={(event) => input.onModelChange(event.target.value)}
        >
          {input.showDefaultModelOption === false ? null : (
            <option value="">{input.defaultModelLabel}</option>
          )}
          {modelIsUnknown ? (
            <option value={input.model}>{input.model}（当前）</option>
          ) : null}
          {input.catalog.models.map((model) => (
            <option key={model.id} value={model.model}>
              {model.displayName}
              {model.isDefault ? "（Codex 默认）" : ""}
            </option>
          ))}
        </select>
        <small>
          {input.catalog.status === "loading"
            ? "正在读取 Codex 可用模型…"
            : selected?.description || "由 Codex 根据当前账号与版本选择模型。"}
        </small>
      </label>
      <label>
        <span>推理强度</span>
        <select
          aria-label={input.effortAriaLabel}
          disabled={input.disabled}
          value={input.effort}
          onChange={(event) => input.onEffortChange(event.target.value)}
        >
          {input.showDefaultEffortOption === false ? null : (
            <option value="">
              模型默认
              {defaultEffort === undefined
                ? ""
                : `（${reasoningEffortLabel(defaultEffort)}）`}
            </option>
          )}
          {effortIsUnknown ? (
            <option value={input.effort}>
              {reasoningEffortLabel(input.effort)}（当前）
            </option>
          ) : null}
          {efforts.map((option) => (
            <option key={option.effort} value={option.effort}>
              {reasoningEffortLabel(option.effort)}
            </option>
          ))}
        </select>
        <small>
          {input.effort.length === 0
            ? "使用所选模型的推荐强度。"
            : efforts.find((option) => option.effort === input.effort)
                ?.description || "当前任务使用这个推理强度。"}
        </small>
      </label>
      {input.catalog.status === "failed" ? (
        <div className={styles.catalogStatus} role="status">
          <span>
            模型目录读取失败；仍可使用 Codex 默认值。
            {input.catalog.error === undefined ? "" : ` ${input.catalog.error}`}
          </span>
          <button
            disabled={input.disabled}
            type="button"
            onClick={input.onRetry}
          >
            重新读取
          </button>
        </div>
      ) : null}
    </div>
  );
}

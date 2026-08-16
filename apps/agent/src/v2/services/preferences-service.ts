import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

import {
  type PreferencesPatch,
  type PreferencesRecord,
  type PreferencesRepository,
  PreferencesRevisionConflictError,
} from "../repositories/preferences-repository.js";

export interface PreferencesView {
  readonly version: 1;
  readonly revision: number;
  readonly theme: "system" | "light" | "dark";
  readonly locale: string;
  readonly defaultWorkspaceId?: string;
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
}

export class PreferencesService {
  readonly #repository: PreferencesRepository;

  constructor(repository: PreferencesRepository) {
    this.#repository = repository;
  }

  async read(): Promise<PreferencesView> {
    return preferencesView(await this.#repository.read());
  }

  async update(
    expectedRevision: number,
    patch: PreferencesPatch,
  ): Promise<PreferencesView> {
    try {
      return preferencesView(
        await this.#repository.update(expectedRevision, patch),
      );
    } catch (error) {
      if (error instanceof PreferencesRevisionConflictError) {
        throw new GatewayV2Error(
          "REVISION_CONFLICT",
          "Preferences changed; refresh before saving",
        );
      }
      throw error;
    }
  }
}

function preferencesView(record: PreferencesRecord): PreferencesView {
  return {
    version: 1,
    revision: record.revision,
    theme: record.theme,
    locale: record.locale,
    ...(record.defaultWorkspaceId === undefined
      ? {}
      : { defaultWorkspaceId: record.defaultWorkspaceId }),
    sandbox: record.sandbox,
    approvalPolicy: record.approvalPolicy,
  };
}

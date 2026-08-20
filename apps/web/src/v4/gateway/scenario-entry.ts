import type { SavedHost } from "../../storage.js";

import { ScenarioGateway } from "./scenario-gateway.js";

/** Development-only composition boundary for deterministic browser scenarios. */
export function createScenarioConnection(kind: "user" | "admin"): {
  readonly gateway: ScenarioGateway;
  readonly host: SavedHost;
} {
  const search = new URLSearchParams(window.location.search);
  return {
    gateway: new ScenarioGateway({
      changePreferencesAfterInitialRead: search.has("scenarioDefaultsChange"),
      delaySecondPreferencesReadOnce: search.has(
        "scenarioPreferenceValidationDelay",
      ),
      failFirstPreferencesReadOnce: search.has(
        "scenarioTaskPrerequisiteFailure",
      ),
      failWorkspaceListAfterMutationOnce: search.has(
        "scenarioWorkspaceRefreshFailure",
      ),
      preferencesAlreadyAppliedConflictOnce: search.has(
        "scenarioPreferencesAlreadyApplied",
      ),
      preferencesConflictRefreshFailureOnce: search.has(
        "scenarioPreferenceConflictRefreshFailure",
      ),
      threadSettingsConflictOnce: search.has("scenarioSettingsConflict"),
    }),
    host: scenarioHost(kind),
  };
}

function scenarioHost(kind: "user" | "admin"): SavedHost {
  return {
    id: `scenario-${kind}`,
    kind,
    name: kind === "admin" ? "Scenario 管理端" : "Scenario HPC",
    endpoint: "ws://scenario.invalid",
    transport: "direct",
    nodeId: `scenario-${kind}`,
    userId: kind === "admin" ? "admin:scenario" : "unix:scenario",
    hostPublicKey: "A".repeat(43),
    hostFingerprint: "scenario",
    deviceId: `scenario-${kind}`,
    deviceName: "Scenario",
    devicePublicKey: "A".repeat(43),
    deviceSecretKey: "A".repeat(43),
  };
}

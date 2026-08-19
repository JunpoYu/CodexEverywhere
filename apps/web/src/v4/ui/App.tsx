import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import type { SavedHost } from "../../storage.js";
import { AdminWebRuntime } from "../admin-runtime.js";
import { ScenarioGateway } from "../gateway/scenario-gateway.js";
import type { GatewayPort } from "../gateway/gateway-port.js";
import { UserWebRuntime } from "../runtime.js";
import { AdminPage } from "./pages/AdminPage.js";
import { HostPage } from "./pages/HostPage.js";
import { ModalDialog } from "./components/ModalDialog.js";
import { QueuePage } from "./pages/QueuePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { TasksPage } from "./pages/TasksPage.js";
import { WorkspacesPage } from "./pages/WorkspacesPage.js";
import { AppShell } from "./shell/AppShell.js";
import { AdminRuntimeContext, RuntimeContext } from "./runtime-context.js";
import { useActorState } from "../actors/use-actor.js";

type ActiveRuntime =
  | { readonly kind: "user"; readonly runtime: UserWebRuntime }
  | { readonly kind: "admin"; readonly runtime: AdminWebRuntime };

export function App() {
  const [active, setActive] = useState<ActiveRuntime>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);

  useEffect(
    () => () => {
      void active?.runtime.close();
    },
    [active],
  );

  const activate = (
    gateway: GatewayPort,
    host: SavedHost,
    codes: readonly string[] = [],
  ) => {
    const next: ActiveRuntime =
      host.kind === "admin"
        ? { kind: "admin", runtime: new AdminWebRuntime({ gateway, host }) }
        : { kind: "user", runtime: new UserWebRuntime({ gateway, host }) };
    next.runtime.start();
    setActive(next);
    setRecoveryCodes(codes);
  };

  const scenario = (kind: "user" | "admin") => {
    const host = scenarioHost(kind);
    activate(new ScenarioGateway(), host);
  };

  return (
    <BrowserRouter>
      {active === undefined ? (
        <Routes>
          <Route
            path="*"
            element={<HostPage onConnected={activate} onScenario={scenario} />}
          />
        </Routes>
      ) : active.kind === "admin" ? (
        <AdminRuntimeContext.Provider value={active.runtime}>
          <Routes>
            <Route path="/admin/*" element={<AdminPage />} />
            <Route path="*" element={<Navigate replace to="/admin" />} />
          </Routes>
          {recoveryCodes.length > 0 ? (
            <RecoveryCodesDialog
              codes={recoveryCodes}
              onClose={() => setRecoveryCodes([])}
            />
          ) : null}
        </AdminRuntimeContext.Provider>
      ) : (
        <RuntimeContext.Provider value={active.runtime}>
          <Routes>
            <Route
              element={<AppShell onDisconnect={() => setActive(undefined)} />}
            >
              <Route element={<UserRouteGate runtime={active.runtime} />}>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/tasks/:threadId" element={<TaskPage />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/workspaces" element={<WorkspacesPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate replace to="/tasks" />} />
              </Route>
            </Route>
          </Routes>
          {recoveryCodes.length > 0 ? (
            <RecoveryCodesDialog
              codes={recoveryCodes}
              onClose={() => setRecoveryCodes([])}
            />
          ) : null}
        </RuntimeContext.Provider>
      )}
    </BrowserRouter>
  );
}

function UserRouteGate(input: { readonly runtime: UserWebRuntime }) {
  const onboarding = useActorState(input.runtime.onboarding);
  const location = useLocation();
  if (onboarding.loading && onboarding.status === undefined) {
    return (
      <main className="page loading-page">
        <span className="spinner" />
        正在检查宿主机…
      </main>
    );
  }
  if (onboarding.step !== "ready" && location.pathname !== "/setup") {
    return <Navigate replace to="/setup" />;
  }
  return <Outlet />;
}

function RecoveryCodesDialog(input: {
  readonly codes: readonly string[];
  readonly onClose: () => void;
}) {
  return (
    <ModalDialog className="ce-dialog" aria-labelledby="recovery-title">
      <h2 id="recovery-title">请立即保存恢复码</h2>
      <p>恢复码只显示这一次。宿主机仅保存不可逆哈希。</p>
      <pre data-one-time-secret>{input.codes.join("\n")}</pre>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(input.codes.join("\n"))
          }
        >
          复制
        </button>
        <button type="button" className="primary" onClick={input.onClose}>
          我已安全保存
        </button>
      </div>
    </ModalDialog>
  );
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

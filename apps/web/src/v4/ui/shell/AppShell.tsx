import { NavLink, Outlet } from "react-router-dom";

import {
  pwaUpdateBlockedReason,
  readPwaUpdateSafetyState,
} from "../../../pwa-update.js";
import { useActorState } from "../../actors/use-actor.js";
import { useRuntime } from "../runtime-context.js";
import styles from "./AppShell.module.css";

const navigation = [
  ["/tasks", "任务", "◫"],
  ["/queue", "Queue", "≡"],
  ["/workspaces", "工作区", "⌂"],
  ["/settings", "设置", "⚙"],
] as const;

export function AppShell(input: { readonly onDisconnect: () => void }) {
  const runtime = useRuntime();
  const connection = useActorState(runtime.connection);
  const tasks = useActorState(runtime.tasks);

  return (
    <div>
      <header className={styles.topbar}>
        <NavLink className={styles.brand ?? ""} to="/tasks">
          <span className={styles.brandMark}>CE</span>
          <div>
            <strong>CodexEverywhere</strong>
            <small>{runtime.host.name}</small>
          </div>
        </NavLink>
        <div
          className={`${styles.connection} ${connection.status === "online" ? styles.online : ""}`}
          role="status"
        >
          <i />
          {connection.status === "online" ? "已连接" : connection.status}
        </div>
        <button className="ghost" type="button" onClick={input.onDisconnect}>
          切换宿主机
        </button>
      </header>
      {connection.error === undefined ||
      connection.status === "online" ||
      connection.status === "reconnecting" ? null : (
        <aside className={styles.statusBanner} role="alert">
          <span>{connection.error}</span>
          {connection.status === "upgrade-required" ? (
            <button type="button" onClick={() => void applyUpgrade()}>
              安全刷新 Web
            </button>
          ) : (
            <button type="button" onClick={input.onDisconnect}>
              重新登录
            </button>
          )}
        </aside>
      )}
      <aside className={styles.sidebar}>
        <nav>
          {navigation.map(([to, label, icon]) => (
            <NavLink
              className={({ isActive }) =>
                `${styles.navLink} ${isActive ? styles.active : ""}`
              }
              key={to}
              to={to}
            >
              <span>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.recentTasks}>
          <div className={styles.recentHeading}>
            <span>最近任务</span>
            <NavLink to="/tasks">全部</NavLink>
          </div>
          {tasks.tasks.slice(0, 12).map((task) => (
            <NavLink
              className={({ isActive }) =>
                `${styles.taskLink} ${isActive ? styles.active : ""}`
              }
              key={task.id}
              to={`/tasks/${encodeURIComponent(task.id)}`}
            >
              <i
                className={`${styles.taskDot} ${taskStateClass(task.state)}`}
              />
              <span className={styles.taskTitle}>
                {task.title || "未命名任务"}
              </span>
            </NavLink>
          ))}
        </div>
      </aside>
      <div className={styles.content}>
        <Outlet />
      </div>
      <nav className={styles.mobileNav} aria-label="主导航">
        {navigation.map(([to, label, icon]) => (
          <NavLink
            className={({ isActive }) => (isActive ? styles.active : undefined)}
            key={to}
            to={to}
          >
            <span>{icon}</span>
            <small>{label}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

async function applyUpgrade(): Promise<void> {
  const blocked = pwaUpdateBlockedReason(readPwaUpdateSafetyState());
  if (blocked !== undefined) {
    window.alert(blocked);
    return;
  }
  const registration = await navigator.serviceWorker?.getRegistration();
  const waiting = registration?.waiting;
  if (waiting == null) {
    window.location.reload();
    return;
  }
  const activated = () => {
    if (waiting.state !== "activated") return;
    waiting.removeEventListener("statechange", activated);
    window.location.reload();
  };
  waiting.addEventListener("statechange", activated);
  waiting.postMessage({ type: "SKIP_WAITING" });
}

function taskStateClass(state: string): string {
  if (state === "running") return styles.running ?? "";
  if (state === "waiting-input") return styles.waitingInput ?? "";
  if (state === "failed") return styles.failed ?? "";
  return "";
}

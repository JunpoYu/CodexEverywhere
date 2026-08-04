import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type HostPaths = {
  home: string;
  configFile: string;
  stateFile: string;
  keysDir: string;
  logsDir: string;
  runtimeDir: string;
  appServerSocket: string;
  appServerPidFile: string;
  agentPidFile: string;
  agentLockFile: string;
};

export function resolveHostPaths(
  env: NodeJS.ProcessEnv = process.env,
): HostPaths {
  const home = resolve(env.CE_HOME ?? join(homedir(), ".codex-everywhere"));
  const runtimeDir = resolve(
    env.CE_RUNTIME_DIR ??
      join(tmpdir(), `codex-everywhere-${process.getuid?.() ?? "unknown"}`),
  );

  return {
    home,
    configFile: join(home, "config.json"),
    stateFile: join(home, "state.sqlite"),
    keysDir: join(home, "keys"),
    logsDir: join(home, "logs"),
    runtimeDir,
    appServerSocket: join(runtimeDir, "app-server.sock"),
    appServerPidFile: join(runtimeDir, "app-server.pid"),
    agentPidFile: join(runtimeDir, "agent.pid"),
    agentLockFile: join(runtimeDir, "agent.lock"),
  };
}

import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHostPaths } from "../host/paths.js";
import {
  isProcessAlive,
  processRecordMatches,
  readProcessRecord,
  writeProcessRecord,
} from "../host/process-files.js";
import { ensureAppServer, restartAppServer } from "./app-server-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("app-server supervisor", () => {
  it("requires an explicit force decision before restarting", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(directory, "home"),
      CE_RUNTIME_DIR: join(directory, "run"),
    });

    await expect(restartAppServer(paths)).rejects.toThrow("force: true");
  });

  it("refuses to replace a live recorded owner whose protocol probe times out", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(directory, "home"),
      CE_RUNTIME_DIR: join(directory, "run"),
    });
    await mkdir(paths.runtimeDir, { recursive: true });
    const serverScript = join(directory, "unresponsive-server.mjs");
    await writeFile(
      serverScript,
      `import { createHash } from "node:crypto";
import net from "node:net";
const server = net.createServer((socket) => {
  let request = "";
  socket.on("data", (chunk) => {
    request += chunk.toString("utf8");
    const match = /Sec-WebSocket-Key:\\s*([^\\r\\n]+)/iu.exec(request);
    if (!match) return;
    const accept = createHash("sha1")
      .update(match[1].trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\\r\\n" +
        "Upgrade: websocket\\r\\n" +
        "Connection: Upgrade\\r\\n" +
        "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n",
    );
    socket.removeAllListeners("data");
  });
});
server.listen(${JSON.stringify(paths.appServerSocket)});
`,
      { mode: 0o600 },
    );
    const owner = spawn(process.execPath, [serverScript], {
      stdio: "ignore",
    });
    if (!owner.pid) throw new Error("Failed to start test socket owner");
    const replacementMarker = join(directory, "replacement-spawned");
    const fakeCodex = join(directory, "replacement-codex");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nprintf spawned > ${JSON.stringify(replacementMarker)}\n`,
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);

    try {
      await vi.waitFor(async () => {
        await expect(stat(paths.appServerSocket)).resolves.toMatchObject({});
      });
      await writeProcessRecord(paths.appServerPidFile, owner.pid);

      await expect(
        ensureAppServer(paths, { codexBinary: fakeCodex, timeoutMs: 100 }),
      ).rejects.toThrow("refusing to start a second instance");
      await expect(readFile(replacementMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(isProcessAlive(owner.pid)).toBe(true);
    } finally {
      owner.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        owner.once("close", () => resolve()),
      );
    }
  }, 10_000);

  it("publishes the child identity before readiness and reaps a timed-out child", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(directory, "home"),
      CE_RUNTIME_DIR: join(directory, "run"),
    });
    await mkdir(paths.runtimeDir, { recursive: true });
    const childPidFile = join(directory, "spawned.pid");
    const fakeCodex = join(directory, "fake-codex");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(
        childPidFile,
      )}\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);

    const starting = ensureAppServer(paths, {
      codexBinary: fakeCodex,
      timeoutMs: 5_000,
    });
    const outcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(
      async () => {
        await expect(readFile(childPidFile, "utf8")).resolves.toMatch(/^\d+$/u);
      },
      { timeout: 4_000 },
    );
    const childPid = Number(await readFile(childPidFile, "utf8"));
    await vi.waitFor(async () => {
      const record = await readProcessRecord(paths.appServerPidFile);
      expect(record).toMatchObject({ pid: childPid });
      if (process.platform === "linux") {
        expect(record).not.toHaveProperty("executable");
        expect(record).not.toHaveProperty("cmdline");
      }
      await expect(processRecordMatches(record!)).resolves.toBe(true);
    });

    expect(await outcome).toMatchObject({
      message: expect.stringMatching(/Timed out/u),
    });
    expect(isProcessAlive(childPid)).toBe(false);
    await expect(readProcessRecord(paths.appServerPidFile)).resolves.toBe(
      undefined,
    );
    await expect(
      readProcessRecord(`${paths.appServerPidFile}.starting`),
    ).resolves.toBe(undefined);
  }, 10_000);

  it("does not remove a successor record or socket while cleaning up", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(directory, "home"),
      CE_RUNTIME_DIR: join(directory, "run"),
    });
    await mkdir(paths.runtimeDir, { recursive: true });
    const fakeCodex = join(directory, "timed-out-codex");
    await writeFile(
      fakeCodex,
      "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);

    const starting = ensureAppServer(paths, {
      codexBinary: fakeCodex,
      timeoutMs: 500,
    });
    const outcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(async () => {
      const record = await readProcessRecord(paths.appServerPidFile);
      expect(record).toBeDefined();
      expect(record?.pid).not.toBe(process.pid);
    });

    const successorRecord = await writeProcessRecord(
      paths.appServerPidFile,
      process.pid,
    );
    await writeFile(paths.appServerSocket, "successor-socket", {
      mode: 0o600,
    });

    expect(await outcome).toMatchObject({
      message: expect.stringMatching(/Timed out/u),
    });
    await expect(readProcessRecord(paths.appServerPidFile)).resolves.toEqual(
      successorRecord,
    );
    await expect(readFile(paths.appServerSocket, "utf8")).resolves.toBe(
      "successor-socket",
    );
  }, 10_000);

  it("refuses a second spawn when the supervisor crashes before owner publication", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveHostPaths({
      CE_HOME: join(directory, "home"),
      CE_RUNTIME_DIR: join(directory, "run"),
    });
    await mkdir(paths.runtimeDir, { recursive: true });
    const childPidFile = join(directory, "startup-child.pid");
    const fakeCodex = join(directory, "startup-codex");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(
        childPidFile,
      )}\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);

    const supervisorModule = new URL(
      "./app-server-supervisor.ts",
      import.meta.url,
    ).href;
    const pathsModule = new URL("../host/paths.ts", import.meta.url).href;
    const supervisorScript = join(directory, "startup-supervisor.mjs");
    const publishPauseMarker = join(directory, "owner-publication-paused");
    await writeFile(
      supervisorScript,
      `import { writeFile } from "node:fs/promises";
import { resolveHostPaths } from ${JSON.stringify(pathsModule)};
import { ensureAppServer } from ${JSON.stringify(supervisorModule)};
const paths = resolveHostPaths(${JSON.stringify({
        CE_HOME: join(directory, "home"),
        CE_RUNTIME_DIR: join(directory, "run"),
      })});
await ensureAppServer(paths, {
  codexBinary: ${JSON.stringify(fakeCodex)},
  timeoutMs: 60_000,
  hooks: {
    afterSpawnBeforeOwnerPublish: async () => {
      await writeFile(${JSON.stringify(publishPauseMarker)}, "paused");
      await new Promise(() => {});
    },
  },
});
`,
      { mode: 0o600 },
    );
    const supervisor = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), supervisorScript],
      { stdio: "ignore" },
    );
    const replacementMarker = join(directory, "replacement-spawned");
    const replacementCodex = join(directory, "replacement-codex");
    await writeFile(
      replacementCodex,
      `#!/bin/sh\nprintf spawned > ${JSON.stringify(replacementMarker)}\n`,
      { mode: 0o700 },
    );
    await chmod(replacementCodex, 0o700);

    let startupOwnerPid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          await expect(readFile(publishPauseMarker, "utf8")).resolves.toBe(
            "paused",
          );
          startupOwnerPid = Number(await readFile(childPidFile, "utf8"));
          expect(isProcessAlive(startupOwnerPid)).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(startupOwnerPid).not.toBe(supervisor.pid);
      await expect(readProcessRecord(paths.appServerPidFile)).resolves.toBe(
        undefined,
      );
      const startupReservation = await readProcessRecord(
        `${paths.appServerPidFile}.starting`,
      );
      expect(startupReservation).toMatchObject({ pid: supervisor.pid });
      await expect(processRecordMatches(startupReservation!)).resolves.toBe(
        true,
      );

      supervisor.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        supervisor.once("close", () => resolve()),
      );
      const supervisorOwner = await readProcessRecord(
        `${paths.appServerPidFile}.supervisor.lock`,
      );
      expect(supervisorOwner).toMatchObject({ pid: supervisor.pid });
      await expect(processRecordMatches(supervisorOwner!)).resolves.toBe(false);
      await expect(processRecordMatches(startupReservation!)).resolves.toBe(
        false,
      );

      await expect(
        ensureAppServer(paths, {
          codexBinary: replacementCodex,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("refusing to start a second instance");
      await expect(readFile(replacementMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(isProcessAlive(startupOwnerPid!)).toBe(true);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGKILL");
        await new Promise<void>((resolve) =>
          supervisor.once("close", () => resolve()),
        );
      }
      if (startupOwnerPid && isProcessAlive(startupOwnerPid)) {
        await stopTestProcess(startupOwnerPid);
      }
    }
  }, 20_000);
});

async function stopTestProcess(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  const gracefulDeadline = Date.now() + 2_000;
  while (Date.now() < gracefulDeadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!isProcessAlive(pid)) return;

  process.kill(pid, "SIGKILL");
  const forcedDeadline = Date.now() + 2_000;
  while (Date.now() < forcedDeadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(isProcessAlive(pid)).toBe(false);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-app-supervisor-test-"));
  temporaryDirectories.push(path);
  return path;
}

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

  it("publishes no PID before readiness and reaps a timed-out child", async () => {
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
    await expect(readProcessRecord(paths.appServerPidFile)).resolves.toBe(
      undefined,
    );

    expect(await outcome).toMatchObject({
      message: expect.stringMatching(/Timed out/u),
    });
    const childPid = Number(await readFile(childPidFile, "utf8"));
    expect(isProcessAlive(childPid)).toBe(false);
    await expect(readProcessRecord(paths.appServerPidFile)).resolves.toBe(
      undefined,
    );
  }, 10_000);
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-app-supervisor-test-"));
  temporaryDirectories.push(path);
  return path;
}

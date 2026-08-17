#!/usr/bin/env node

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

try {
  await listenAndClose({ host: "127.0.0.1", port: 0 });
  if (process.platform !== "win32") {
    const directory = await mkdtemp(join(tmpdir(), "ce-runtime-check-"));
    try {
      await listenAndClose(join(directory, "listener.sock"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    "Test runtime capabilities passed (loopback TCP and Unix sockets).\n",
  );
} catch (error) {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
  process.stderr.write(
    `Test runtime capabilities failed (${code}). Full v0.4 verification requires loopback TCP and Unix socket listeners; run it on a normal CI or staging host, not inside a network-restricted sandbox.\n`,
  );
  process.exitCode = 1;
}

function listenAndClose(address) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    const onError = (error) => {
      server.removeAllListeners();
      reject(error);
    };
    server.once("error", onError);
    server.listen(address, () => {
      server.off("error", onError);
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
  });
}

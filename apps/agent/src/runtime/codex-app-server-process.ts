import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type CodexAppServerProcessOptions = {
  socketPath: string;
  codexBinary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
};

export class CodexAppServerProcess {
  readonly socketPath: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stderr: string[] = [];
  #stopped = false;

  private constructor(
    socketPath: string,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.socketPath = socketPath;
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      if (this.#stderr.length > 100) this.#stderr.shift();
    });
  }

  static async start(
    options: CodexAppServerProcessOptions,
  ): Promise<CodexAppServerProcess> {
    await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });

    const child = spawn(
      options.codexBinary ?? "codex",
      ["app-server", "--listen", `unix://${options.socketPath}`],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const processHandle = new CodexAppServerProcess(options.socketPath, child);

    try {
      await processHandle.#waitUntilReady(options.startupTimeoutMs ?? 15_000);
      return processHandle;
    } catch (error) {
      await processHandle.stop();
      const detail = processHandle.stderr.trim();
      throw new Error(
        `Codex app-server did not become ready${detail ? `: ${detail}` : ""}`,
        { cause: error },
      );
    }
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stderr(): string {
    return this.#stderr.join("");
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    if (this.#child.exitCode !== null || this.#child.signalCode !== null)
      return;
    this.#child.kill("SIGTERM");

    const exited = new Promise<void>((resolve) =>
      this.#child.once("exit", () => resolve()),
    );
    const timedOut = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    if (
      (await Promise.race([exited.then(() => "exited" as const), timedOut])) ===
      "timeout"
    ) {
      this.#child.kill("SIGKILL");
      await exited;
    }
  }

  async #waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.#child.exitCode !== null) {
        throw new Error(
          `Codex app-server exited with code ${this.#child.exitCode}`,
        );
      }
      try {
        const metadata = await stat(this.socketPath);
        if (metadata.isSocket()) return;
      } catch {
        // The socket is created asynchronously by app-server.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for Unix socket ${this.socketPath}`);
  }
}

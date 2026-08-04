import { describe, expect, it } from "vitest";

import type { HostPaths } from "./paths.js";
import {
  removeManagedBlock,
  renderWatchdogScript,
  resolveExecutable,
} from "./watchdog.js";

describe("watchdog crontab management", () => {
  it("removes only the managed block", () => {
    expect(
      removeManagedBlock(`MAILTO=user@example.com
# BEGIN CODEXEVERYWHERE WATCHDOG
* * * * * /old/watchdog
# END CODEXEVERYWHERE WATCHDOG
15 2 * * * /user/job
`),
    ).toContain("MAILTO=user@example.com\n15 2 * * * /user/job");
  });

  it("uses an absolute tmux path so cron does not depend on login PATH", () => {
    const paths = {
      home: "/home/user/.codex-everywhere",
      logsDir: "/home/user/.codex-everywhere/logs",
    } as HostPaths;
    const script = renderWatchdogScript(
      paths,
      { nodePath: "/opt/node/bin/node", cliPath: "/home/user/.local/bin/ce" },
      "/home/user/local/bin/tmux",
    );

    expect(script).toContain("TMUX='/home/user/local/bin/tmux'");
    expect(script).toContain('"$TMUX" has-session');
    expect(script).toContain('"$TMUX" new-session');
  });

  it("resolves executables from the supplied PATH", async () => {
    await expect(
      resolveExecutable("sh", { PATH: "/definitely-missing:/bin" }),
    ).resolves.toBe("/bin/sh");
  });
});

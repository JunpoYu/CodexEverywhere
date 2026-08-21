import { afterEach, describe, expect, it, vi } from "vitest";

import { mutationOptions, queryOptions } from "./gateway-port.js";
import { ScenarioGateway } from "./scenario-gateway.js";

const gateways: ScenarioGateway[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe("ScenarioGateway", () => {
  it("holds a turn for approval and resumes it after the first response", async () => {
    vi.useFakeTimers();
    const gateway = createGateway();
    const events: string[] = [];
    gateway.onEvent((event) => events.push(event.type));
    const operationKey = crypto.randomUUID();

    const started = await gateway.request(
      "thread/start",
      {
        version: 2,
        workspaceId: "workspace-demo",
        prompt: "[approval] 执行合成命令",
        expectedPreferencesRevision: 0,
      },
      mutationOptions(operationKey),
    );
    const opened = await gateway.request(
      "thread/open",
      { version: 1, threadId: started.thread.id, historyLimit: 50 },
      queryOptions(),
    );

    expect(opened.state).toBe("waiting-input");
    expect(opened.interactions).toHaveLength(1);
    expect(events).toContain("interaction/created");

    const interaction = opened.interactions[0]!;
    await expect(
      gateway.request(
        "interaction/respond",
        {
          version: 1,
          threadId: started.thread.id,
          interactionId: interaction.id,
          response: { version: 1, kind: "approval", decision: "accept" },
        },
        mutationOptions(),
      ),
    ).resolves.toEqual({
      version: 1,
      interactionId: interaction.id,
      resolved: true,
    });

    await vi.advanceTimersByTimeAsync(300);
    const completed = await gateway.request(
      "thread/open",
      { version: 1, threadId: started.thread.id, historyLimit: 50 },
      queryOptions(),
    );
    expect(completed.state).toBe("idle");
    expect(completed.interactions).toEqual([]);
    expect(completed.items.at(-1)?.data.text).toContain("Scenario 回复已完成");
    expect(events).toContain("codex/notification");

    const receipt = await gateway.request(
      "mutation/status",
      { version: 1, operationKey },
      queryOptions(),
    );
    expect(receipt).toMatchObject({
      version: 1,
      status: "completed",
      method: "thread/start",
      outcome: { version: 1, kind: "success" },
    });
  });

  it("supports the administrator lifecycle with revisions and audit", async () => {
    const gateway = createGateway();
    const username = "scenario-user";

    await expect(
      gateway.request(
        "admin/user/inspect",
        { version: 1, username },
        queryOptions(),
      ),
    ).resolves.toEqual({ version: 1, eligible: true });

    const registered = await gateway.request(
      "admin/user/register",
      { version: 1, username },
      mutationOptions(),
    );
    const disabled = await gateway.request(
      "admin/user/disable",
      {
        version: 1,
        username,
        expectedRevision: registered.user.revision,
      },
      mutationOptions(),
    );
    const enabled = await gateway.request(
      "admin/user/enable",
      {
        version: 1,
        username,
        expectedRevision: disabled.user.revision,
      },
      mutationOptions(),
    );
    const recovery = await gateway.request(
      "admin/user/recovery/start",
      {
        version: 1,
        username,
        expectedRevision: enabled.user.revision,
      },
      mutationOptions(),
    );
    const host = await gateway.request(
      "admin/host/status",
      { version: 1 },
      queryOptions(),
    );
    const audit = await gateway.request(
      "admin/audit/list",
      { version: 1, username, limit: 50 },
      queryOptions(),
    );

    expect(enabled.user.status).toBe("enabled");
    expect(recovery.handoffCode).toBe("SCENARIO-HANDOFF-CODE");
    expect(host).toMatchObject({ managedUsers: 1, enabledUsers: 1 });
    expect(audit.events.map((event) => event.action)).toEqual([
      "admin/user/recovery/start",
      "admin/user/enabled",
      "admin/user/disabled",
      "admin/user/register",
    ]);
  });

  it("implements the authentication and setup contract without a model", async () => {
    vi.useFakeTimers();
    const gateway = createGateway();
    const events: string[] = [];
    gateway.onEvent((event) => events.push(event.type));

    const passkey = await gateway.request(
      "auth/register/options",
      { version: 1, deviceName: "Browser" },
      mutationOptions(),
    );
    const authenticated = await gateway.request(
      "auth/register/verify",
      {
        version: 1,
        challengeId: passkey.challengeId,
        deviceName: "Browser",
        response: {},
        rememberDevice: true,
      },
      mutationOptions(),
    );
    const install = await gateway.request(
      "setup/codex/install",
      { version: 1 },
      mutationOptions(),
    );
    const login = await gateway.request(
      "setup/codex/login/start",
      { version: 1 },
      mutationOptions(),
    );

    expect(authenticated).toMatchObject({
      authenticated: true,
      rememberedDevice: true,
    });
    expect(install.accepted).toBe(true);
    expect(login.verificationUri).toBe("https://example.com/device");
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toContain("setup/codex/install/progress");
    expect(events).toContain("setup/codex/login/completed");
  });

  it("paginates a long conversation at stable item boundaries", async () => {
    const gateway = new ScenarioGateway({ longConversation: true });
    gateways.push(gateway);

    const latest = await gateway.request(
      "thread/open",
      {
        version: 1,
        threadId: "thread-long-conversation",
        historyLimit: 50,
      },
      queryOptions(),
    );

    expect(latest.items).toHaveLength(50);
    expect(latest.items.at(-1)?.id).toBe("long-command-output");
    expect(latest.hasEarlierHistory).toBe(true);
    expect(latest.historyCursor).toBe("long-assistant-46");

    const earlier = await gateway.request(
      "thread/history",
      {
        version: 1,
        threadId: "thread-long-conversation",
        cursor: latest.historyCursor!,
        limit: 50,
      },
      queryOptions(),
    );

    expect(earlier.items).toHaveLength(50);
    expect(earlier.items.at(-1)?.id).toBe("long-user-46");
    expect(earlier.nextCursor).toBe("long-assistant-21");
    expect(earlier.hasMore).toBe(true);
  });
});

function createGateway(): ScenarioGateway {
  const gateway = new ScenarioGateway();
  gateways.push(gateway);
  return gateway;
}

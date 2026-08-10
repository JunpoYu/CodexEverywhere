import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStateStore } from "../host/state-store.js";
import {
  AdminControlService,
  type AdminHelperRequest,
} from "./control-service.js";
import { AdminUserRegistry } from "./registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AdminControlService identity safety", () => {
  it.each([
    ["admin/user/disable", "uid"],
    ["admin/recovery/start", "home"],
  ] as const)(
    "rejects %s before side effects when the NSS %s has drifted",
    async (action, drift) => {
      const directory = await temporaryDirectory();
      const home = join(directory, "alice");
      const otherHome = join(directory, "replacement-alice");
      await Promise.all([mkdir(home), mkdir(otherHome)]);
      const state = await HostStateStore.open(join(directory, "state.sqlite"));
      const uid = process.getuid?.() ?? 501;
      const account = {
        username: "alice",
        uid,
        gid: process.getgid?.() ?? 20,
        home,
        shell: "/bin/bash",
      };
      const registered = await new AdminUserRegistry(state).register(account);
      const inspectUnixAccount = vi.fn(async () => ({
        eligible: true as const,
        account: {
          ...account,
          ...(drift === "uid" ? { uid: uid + 1 } : { home: otherHome }),
        },
      }));
      const service = createService(state, inspectUnixAccount);

      await expect(
        service.execute(
          mutationRequest(action, registered.username, registered.revision),
        ),
      ).rejects.toThrow("identity changed");
      await expect(new AdminUserRegistry(state).get("alice")).resolves.toEqual(
        registered,
      );
      expect(inspectUnixAccount).toHaveBeenCalledOnce();
      await state.close();
    },
  );

  it("coalesces concurrent requests with the same request ID", async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, "alice");
    await mkdir(home);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const account = {
      username: "alice",
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      home,
      shell: "/bin/bash",
    };
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspectUnixAccount = vi.fn(async () => {
      await inspectionGate;
      return { eligible: true as const, account };
    });
    const service = createService(state, inspectUnixAccount);
    const request: AdminHelperRequest = {
      version: 1,
      requestId: "00000000-0000-0000-0000-000000000003",
      actor: "device:admin",
      action: "admin/user/register",
      payload: { username: "alice" },
    };

    const first = service.execute(request);
    const second = service.execute(request);
    releaseInspection?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(inspectUnixAccount).toHaveBeenCalledOnce();
    await expect(
      new AdminUserRegistry(state).listAudit(),
    ).resolves.toHaveLength(1);
    await expect(
      service.execute({ ...request, payload: { username: "bob" } }),
    ).rejects.toThrow("request ID was reused with different input");
    expect(inspectUnixAccount).toHaveBeenCalledOnce();
    await state.close();
  });

  it("coalesces the same request across process-like service instances", async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, "alice");
    await mkdir(home);
    const statePath = join(directory, "state.sqlite");
    const firstState = await HostStateStore.open(statePath);
    const secondState = await HostStateStore.open(statePath);
    const account = {
      username: "alice",
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      home,
      shell: "/bin/bash",
    };
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspectUnixAccount = vi.fn(async () => {
      await inspectionGate;
      return { eligible: true as const, account };
    });
    const firstService = createService(firstState, inspectUnixAccount);
    const secondService = createService(secondState, inspectUnixAccount);
    const request: AdminHelperRequest = {
      version: 1,
      requestId: "00000000-0000-0000-0000-000000000004",
      actor: "device:admin",
      action: "admin/user/register",
      payload: { username: "alice" },
    };

    const first = firstService.execute(request);
    await vi.waitFor(() => expect(inspectUnixAccount).toHaveBeenCalledOnce());
    const second = secondService.execute(request);
    releaseInspection?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(inspectUnixAccount).toHaveBeenCalledOnce();
    await expect(
      new AdminUserRegistry(secondState).listAudit(),
    ).resolves.toHaveLength(1);
    await expect(
      secondService.execute({ ...request, payload: { username: "bob" } }),
    ).rejects.toThrow("request ID was reused with different input");
    await secondState.close();
    await firstState.close();
  });

  it("replays the same failure across process-like service instances", async () => {
    const directory = await temporaryDirectory();
    const statePath = join(directory, "state.sqlite");
    const firstState = await HostStateStore.open(statePath);
    const secondState = await HostStateStore.open(statePath);
    const inspectUnixAccount = vi.fn(async () => {
      throw new Error("NSS lookup failed");
    });
    const firstService = createService(firstState, inspectUnixAccount);
    const secondService = createService(secondState, inspectUnixAccount);
    const request: AdminHelperRequest = {
      version: 1,
      requestId: "00000000-0000-0000-0000-000000000006",
      actor: "device:admin",
      action: "admin/user/register",
      payload: { username: "alice" },
    };

    await expect(firstService.execute(request)).rejects.toThrow(
      "NSS lookup failed",
    );
    await expect(secondService.execute(request)).rejects.toThrow(
      "NSS lookup failed",
    );
    expect(inspectUnixAccount).toHaveBeenCalledOnce();
    await expect(
      new AdminUserRegistry(secondState).listAudit(),
    ).resolves.toHaveLength(1);
    await secondState.close();
    await firstState.close();
  });
});

function createService(
  state: HostStateStore,
  inspectUnixAccount: NonNullable<
    ConstructorParameters<typeof AdminControlService>[1]["inspectUnixAccount"]
  >,
): AdminControlService {
  return new AdminControlService(state, {
    installationId: "installation-1",
    serverName: "test-host",
    nodePath: process.execPath,
    cliPath: "/opt/codex-everywhere/cli.js",
    inspectUnixAccount,
  });
}

function mutationRequest(
  action: string,
  username: string,
  expectedRevision: number,
): AdminHelperRequest {
  return {
    version: 1,
    requestId:
      action === "admin/user/disable"
        ? "00000000-0000-0000-0000-000000000001"
        : "00000000-0000-0000-0000-000000000002",
    actor: "device:admin",
    action,
    payload: { version: 1, username, expectedRevision },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-admin-control-test-"));
  temporaryDirectories.push(path);
  return path;
}

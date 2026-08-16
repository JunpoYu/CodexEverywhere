import { randomUUID } from "node:crypto";

import { GatewayV2Error, type OutputOf } from "@codex-everywhere/protocol/v2";

import type { UnixAccountEligibility } from "../../admin/unix-accounts.js";
import type { AdminGatewayContext } from "../gateway/admin-gateway-session.js";
import type { AdminHandlerMap } from "../gateway/handler-types.js";
import {
  AdminAuditCursorError,
  ManagedUserConflictError,
  ManagedUserRevisionConflictError,
  type AdminRepository,
  type ManagedUserRecord,
} from "../repositories/admin-repository.js";

type AdminUserView = OutputOf<"admin/user/register">["user"];

export interface AdminSystemPort {
  inspectAccount(username: string): Promise<UnixAccountEligibility>;
  assertCurrentAccount(user: ManagedUserRecord): Promise<{
    readonly username: string;
    readonly uid: number;
    readonly home: string;
    readonly shell: string;
  }>;
  agentOnline(uid: number): Promise<boolean>;
  setAccessDisabled(uid: number, disabled: boolean): Promise<void>;
  stopAgent(uid: number): Promise<void>;
  issueRecoveryHandoff(user: ManagedUserRecord): Promise<{
    readonly handoffCode: string;
    readonly expiresAt: string;
  }>;
  removeUserState(user: ManagedUserRecord): Promise<void>;
}

export interface AdminServiceOptions {
  readonly repository: AdminRepository;
  readonly system: AdminSystemPort;
  readonly installationId: string;
  readonly serverName: string;
  readonly startedAt?: string;
}

/** Administrator domain logic; it has no imports from user task services. */
export class AdminService {
  readonly handlers: AdminHandlerMap<AdminGatewayContext>;
  readonly #repository: AdminRepository;
  readonly #system: AdminSystemPort;
  readonly #installationId: string;
  readonly #serverName: string;
  readonly #startedAt: string;

  constructor(options: AdminServiceOptions) {
    this.#repository = options.repository;
    this.#system = options.system;
    this.#installationId = options.installationId;
    this.#serverName = options.serverName;
    this.#startedAt = options.startedAt ?? new Date().toISOString();
    this.handlers = {
      "admin/host/status": () => this.#hostStatus(),
      "admin/user/inspect": (input) => this.#inspect(input.username),
      "admin/user/register": (input) => this.#register(input.username),
      "admin/user/disable": (input) =>
        this.#disable(input.username, input.expectedRevision),
      "admin/user/enable": (input) =>
        this.#enable(input.username, input.expectedRevision),
      "admin/user/removal/schedule": (input) =>
        this.#scheduleRemoval(
          input.username,
          input.expectedRevision,
          input.removeAfter,
        ),
      "admin/user/removal/cancel": (input) =>
        this.#cancelRemoval(input.username, input.expectedRevision),
      "admin/user/recovery/start": (input) =>
        this.#startRecovery(input.username, input.expectedRevision),
      "admin/audit/list": (input) => this.#auditList(input),
    };
  }

  async maintenance(now = new Date().toISOString()): Promise<number> {
    const due = await this.#repository.dueRemovals(now);
    const failures: Error[] = [];
    for (const candidate of due) {
      const requestId = randomUUID();
      try {
        await this.#applyRemoval(candidate);
        await this.#repository.appendAudit({
          requestId,
          actor: "system:maintenance",
          action: "admin/user/removal/apply",
          targetUsername: candidate.username,
          result: "succeeded",
        });
      } catch (error) {
        await this.#repository.appendAudit({
          requestId,
          actor: "system:maintenance",
          action: "admin/user/removal/apply",
          targetUsername: candidate.username,
          result: "failed",
        });
        failures.push(
          error instanceof Error ? error : new Error("Removal failed"),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} managed user removal operation(s) failed`,
      );
    }
    return due.length;
  }

  async #hostStatus(): Promise<OutputOf<"admin/host/status">> {
    return {
      version: 1,
      installationId: this.#installationId,
      serverName: this.#serverName,
      controllerStartedAt: this.#startedAt,
      ...(await this.#repository.counts()),
    };
  }

  async #inspect(username: string): Promise<OutputOf<"admin/user/inspect">> {
    const eligibility = await this.#system.inspectAccount(username);
    if (!eligibility.eligible) {
      return { version: 1, eligible: false, reason: eligibility.reason };
    }
    const stored = await this.#repository.get(username);
    if (stored === undefined) return { version: 1, eligible: true };
    if (
      stored.uid !== eligibility.account.uid ||
      stored.home !== eligibility.account.home
    ) {
      return {
        version: 1,
        eligible: false,
        reason: "The registered Unix identity no longer matches NSS",
      };
    }
    return {
      version: 1,
      eligible: true,
      user: await this.#view(stored, eligibility.account.shell),
    };
  }

  async #register(username: string): Promise<OutputOf<"admin/user/register">> {
    const eligibility = await this.#system.inspectAccount(username);
    if (!eligibility.eligible) {
      throw new GatewayV2Error(
        "USER_INELIGIBLE",
        `Unix account is not eligible: ${eligibility.reason}`,
      );
    }
    try {
      const user = await this.#repository.register(eligibility.account);
      return {
        version: 1,
        user: await this.#view(user, eligibility.account.shell),
      };
    } catch (error) {
      if (error instanceof ManagedUserConflictError) {
        throw new GatewayV2Error("USER_IDENTITY_CONFLICT", error.message);
      }
      throw error;
    }
  }

  async #disable(
    username: string,
    expectedRevision: number,
  ): Promise<OutputOf<"admin/user/disable">> {
    const { user, account } = await this.#requiredCurrent(
      username,
      expectedRevision,
    );
    if (user.status !== "enabled") {
      throw invalidUserState("Only an enabled user can be disabled");
    }
    await this.#system.setAccessDisabled(user.uid, true);
    await this.#system.stopAgent(user.uid);
    const updated = await this.#setStatus(user, "disabled");
    return { version: 1, user: await this.#view(updated, account.shell) };
  }

  async #enable(
    username: string,
    expectedRevision: number,
  ): Promise<OutputOf<"admin/user/enable">> {
    const { user, account } = await this.#requiredCurrent(
      username,
      expectedRevision,
    );
    if (user.status !== "disabled" && user.status !== "removed") {
      throw invalidUserState("Only a disabled or removed user can be enabled");
    }
    const updated = await this.#setStatus(user, "enabled");
    await this.#system.setAccessDisabled(user.uid, false);
    return { version: 1, user: await this.#view(updated, account.shell) };
  }

  async #scheduleRemoval(
    username: string,
    expectedRevision: number,
    removeAfter: string,
  ): Promise<OutputOf<"admin/user/removal/schedule">> {
    const { user, account } = await this.#requiredCurrent(
      username,
      expectedRevision,
    );
    if (user.status !== "enabled") {
      throw invalidUserState(
        "Only an enabled user can be scheduled for removal",
      );
    }
    await this.#system.setAccessDisabled(user.uid, true);
    await this.#system.stopAgent(user.uid);
    const updated = await this.#setStatus(user, "removal_pending", removeAfter);
    return { version: 1, user: await this.#view(updated, account.shell) };
  }

  async #cancelRemoval(
    username: string,
    expectedRevision: number,
  ): Promise<OutputOf<"admin/user/removal/cancel">> {
    const { user, account } = await this.#requiredCurrent(
      username,
      expectedRevision,
    );
    if (user.status !== "removal_pending") {
      throw invalidUserState("The user is not pending removal");
    }
    const updated = await this.#setStatus(user, "enabled");
    await this.#system.setAccessDisabled(user.uid, false);
    return { version: 1, user: await this.#view(updated, account.shell) };
  }

  async #startRecovery(
    username: string,
    expectedRevision: number,
  ): Promise<OutputOf<"admin/user/recovery/start">> {
    const { user } = await this.#requiredCurrent(username, expectedRevision);
    if (user.status !== "enabled") {
      throw invalidUserState(
        "Enable the user before starting Web credential recovery",
      );
    }
    await this.#system.stopAgent(user.uid);
    const result = await this.#system.issueRecoveryHandoff(user);
    return { version: 1, username: user.username, ...result };
  }

  async #auditList(
    input: Parameters<
      AdminHandlerMap<AdminGatewayContext>["admin/audit/list"]
    >[0],
  ): Promise<OutputOf<"admin/audit/list">> {
    try {
      const page = await this.#repository.listAudit({
        limit: input.limit,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        version: 1,
        events: page.events.map((event) => ({ version: 1 as const, ...event })),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
        hasMore: page.hasMore,
      };
    } catch (error) {
      if (error instanceof AdminAuditCursorError) {
        throw new GatewayV2Error("INVALID_CURSOR", error.message);
      }
      throw error;
    }
  }

  async #requiredCurrent(username: string, expectedRevision: number) {
    const user = await this.#repository.get(username);
    if (user === undefined) {
      throw new GatewayV2Error(
        "USER_NOT_FOUND",
        "User is not registered for CodexEverywhere",
      );
    }
    if (user.revision !== expectedRevision) {
      throw revisionConflict(user.username);
    }
    return {
      user,
      account: await this.#system.assertCurrentAccount(user),
    };
  }

  async #setStatus(
    user: ManagedUserRecord,
    status: ManagedUserRecord["status"],
    removeAfter?: string,
  ): Promise<ManagedUserRecord> {
    try {
      return await this.#repository.setStatus({
        username: user.username,
        expectedRevision: user.revision,
        status,
        ...(removeAfter === undefined ? {} : { removeAfter }),
      });
    } catch (error) {
      if (error instanceof ManagedUserRevisionConflictError) {
        throw revisionConflict(user.username);
      }
      throw error;
    }
  }

  async #view(user: ManagedUserRecord, shell: string): Promise<AdminUserView> {
    return {
      version: 1,
      ...user,
      shell,
      agentOnline: await this.#system.agentOnline(user.uid),
    };
  }

  async #applyRemoval(candidate: ManagedUserRecord): Promise<void> {
    await this.#system.assertCurrentAccount(candidate);
    const claimed =
      candidate.status === "removing"
        ? candidate
        : await this.#setStatus(candidate, "removing", candidate.removeAfter);
    await this.#system.setAccessDisabled(claimed.uid, true);
    await this.#system.stopAgent(claimed.uid);
    await this.#system.removeUserState(claimed);
    await this.#setStatus(claimed, "removed");
  }
}

function invalidUserState(message: string): GatewayV2Error {
  return new GatewayV2Error("INVALID_USER_STATE", message);
}

function revisionConflict(username: string): GatewayV2Error {
  return new GatewayV2Error(
    "USER_STATE_CHANGED",
    `Managed user state changed for ${username}; refresh before retrying`,
  );
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  GATEWAY_API_VERSION,
  gatewayMethodDefinitions,
  parseGatewayResponseEnvelopeV2,
  uuidSchema,
  type GatewayMethodName,
  type GatewayRequestEnvelopeV2,
  type InputOf,
  type MutationInvocation,
  type MutationStatus,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

export const ADMIN_HELPER_V2_PROTOCOL_VERSION = 2 as const;

export type AdminHelperV2Request =
  | {
      readonly version: typeof ADMIN_HELPER_V2_PROTOCOL_VERSION;
      readonly kind: "route";
      readonly actor: string;
      readonly request: GatewayRequestEnvelopeV2;
    }
  | {
      readonly version: typeof ADMIN_HELPER_V2_PROTOCOL_VERSION;
      readonly kind: "mutation-status";
      readonly actor: string;
      readonly requestId: string;
      readonly operationKey: string;
    };

export class AdminHelperV2Client {
  readonly #helperPath: string;

  constructor(helperPath = "/usr/local/libexec/ce-admin-helper") {
    this.#helperPath = helperPath;
  }

  async query<Method extends AdminQueryMethod>(
    method: Method,
    input: InputOf<Method>,
    actor: string,
  ): Promise<OutputOf<Method>> {
    const requestId = randomUUID();
    const result = await this.#call({
      version: ADMIN_HELPER_V2_PROTOCOL_VERSION,
      kind: "route",
      actor,
      request: {
        version: GATEWAY_API_VERSION,
        requestId,
        method,
        input,
      } as GatewayRequestEnvelopeV2,
    });
    return unwrap(method, requestId, result);
  }

  async mutation<Method extends AdminMutationMethod>(
    method: Method,
    input: InputOf<Method>,
    invocation: MutationInvocation,
  ): Promise<OutputOf<Method>> {
    const result = await this.#call({
      version: ADMIN_HELPER_V2_PROTOCOL_VERSION,
      kind: "route",
      actor: invocation.principalId,
      request: {
        version: GATEWAY_API_VERSION,
        requestId: invocation.requestId,
        operationKey: invocation.operationKey,
        method,
        input,
      } as GatewayRequestEnvelopeV2,
    });
    return unwrap(method, invocation.requestId, result);
  }

  async mutationStatus(
    operationKey: string,
    actor: string,
  ): Promise<MutationStatus> {
    const requestId = randomUUID();
    const result = await this.#call({
      version: ADMIN_HELPER_V2_PROTOCOL_VERSION,
      kind: "mutation-status",
      actor,
      requestId,
      operationKey,
    });
    return unwrap("mutation/status", requestId, result);
  }

  #call(request: AdminHelperV2Request): Promise<unknown> {
    return runJsonHelper(this.#helperPath, request);
  }
}

export function parseAdminHelperV2Request(
  input: unknown,
): AdminHelperV2Request {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid administrator helper request");
  }
  const value = input as Record<string, unknown>;
  if (
    value.version !== ADMIN_HELPER_V2_PROTOCOL_VERSION ||
    (value.kind !== "route" && value.kind !== "mutation-status") ||
    typeof value.actor !== "string" ||
    value.actor.length < 1 ||
    value.actor.length > 512 ||
    !/^[A-Za-z0-9:_.@-]+$/u.test(value.actor)
  ) {
    throw new Error("Invalid administrator helper request");
  }
  if (value.kind === "mutation-status") {
    if (
      !uuidSchema.safeParse(value.requestId).success ||
      !uuidSchema.safeParse(value.operationKey).success
    ) {
      throw new Error("Invalid administrator helper status request");
    }
    return {
      version: ADMIN_HELPER_V2_PROTOCOL_VERSION,
      kind: "mutation-status",
      actor: value.actor,
      requestId: value.requestId as string,
      operationKey: value.operationKey as string,
    };
  }
  const request = value.request;
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request) ||
    typeof (request as Record<string, unknown>).method !== "string" ||
    !(request as Record<string, unknown>).method
      ?.toString()
      .startsWith("admin/")
  ) {
    throw new Error("Administrator helper only accepts admin routes");
  }
  return {
    version: ADMIN_HELPER_V2_PROTOCOL_VERSION,
    kind: "route",
    actor: value.actor,
    request: request as GatewayRequestEnvelopeV2,
  };
}

type AdminQueryMethod = {
  [Method in GatewayMethodName]: Method extends `admin/${string}`
    ? (typeof gatewayMethodDefinitions)[Method]["kind"] extends "query"
      ? Method
      : never
    : never;
}[GatewayMethodName];

type AdminMutationMethod = {
  [Method in GatewayMethodName]: Method extends `admin/${string}`
    ? (typeof gatewayMethodDefinitions)[Method]["kind"] extends "mutation"
      ? Method
      : never
    : never;
}[GatewayMethodName];

function unwrap<Method extends GatewayMethodName>(
  method: Method,
  requestId: string,
  value: unknown,
): OutputOf<Method> {
  const response = parseGatewayResponseEnvelopeV2(value, method, requestId);
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & {
      code?: string;
      retryable?: boolean;
    };
    error.code = response.error.code;
    if (response.error.retryable !== undefined) {
      error.retryable = response.error.retryable;
    }
    throw error;
  }
  return response.result;
}

function runJsonHelper(path: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= 1024 * 1024) stdout += chunk;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length <= 64 * 1024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Administrator helper failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch (error) {
        reject(
          new Error("Administrator helper returned invalid JSON", {
            cause: error,
          }),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}

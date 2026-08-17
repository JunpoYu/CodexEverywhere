import type { GatewayErrorPayload } from "./common.js";

export class GatewayV2Error extends Error {
  readonly code: string;
  readonly retryable: boolean | undefined;
  readonly details: GatewayErrorPayload["details"];
  readonly closeConnection: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      details?: GatewayErrorPayload["details"];
      closeConnection?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "GatewayV2Error";
    this.code = code;
    this.retryable = options.retryable;
    this.details = options.details;
    this.closeConnection = options.closeConnection ?? false;
  }

  toPayload(): GatewayErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class MutationOutcomeUnknownError extends Error {
  constructor(
    readonly method: string,
    readonly operationKey: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `Mutation outcome is unknown; reconcile operation ${operationKey}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MutationOutcomeUnknownError";
  }
}

export class GatewayRemoteError extends Error {
  readonly code: string;
  readonly retryable: boolean | undefined;
  readonly details: GatewayErrorPayload["details"];

  constructor(payload: GatewayErrorPayload) {
    super(payload.message);
    this.name = "GatewayRemoteError";
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.details = payload.details;
  }
}

import { Actor, type Scope } from "@codex-everywhere/kernel";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "online"
  | "reconnecting"
  | "upgrade-required";

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly hostName?: string;
  readonly error?: string;
}

export type ConnectionEvent =
  | { readonly type: "CONNECT"; readonly hostName?: string }
  | { readonly type: "AUTHENTICATING" }
  | { readonly type: "CONNECTED"; readonly hostName: string }
  | { readonly type: "LOST"; readonly message: string }
  | { readonly type: "RECONNECTING" }
  | { readonly type: "UPGRADE_REQUIRED"; readonly message: string }
  | { readonly type: "DISCONNECT" };

export function createConnectionActor(scope: Scope) {
  return new Actor<ConnectionState, ConnectionEvent, never>({
    name: "connection",
    scope,
    initialState: { status: "disconnected" },
    reducer: (state, event) => {
      switch (event.type) {
        case "CONNECT":
          return {
            state: {
              status: "connecting",
              ...(event.hostName === undefined
                ? {}
                : { hostName: event.hostName }),
            },
          };
        case "AUTHENTICATING":
          return { state: { ...state, status: "authenticating" } };
        case "CONNECTED":
          return {
            state: { status: "online", hostName: event.hostName },
          };
        case "LOST":
          return {
            state: {
              ...state,
              status: "disconnected",
              error: event.message,
            },
          };
        case "RECONNECTING":
          return { state: { ...state, status: "reconnecting" } };
        case "UPGRADE_REQUIRED":
          return {
            state: { status: "upgrade-required", error: event.message },
          };
        case "DISCONNECT":
          return { state: { status: "disconnected" } };
      }
    },
    runEffect: () => undefined,
    onEffectError: () => undefined,
  });
}

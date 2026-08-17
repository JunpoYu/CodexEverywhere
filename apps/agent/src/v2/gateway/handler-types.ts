import type {
  GatewayHandler,
  GatewayMethodName,
} from "@codex-everywhere/protocol/v2";

import type { AgentGatewayContext } from "./agent-gateway-session.js";
import type { IdentityGatewayContext } from "./identity-gateway-context.js";

export type AgentHandlerMap<Methods extends GatewayMethodName> = {
  readonly [Method in Methods]: GatewayHandler<Method, AgentGatewayContext>;
};

export const IDENTITY_METHODS = [
  "auth/status",
  "auth/register/options",
  "auth/register/verify",
  "auth/login/options",
  "auth/login/verify",
  "auth/password/register/start",
  "auth/password/register/finish",
  "auth/password/login/start",
  "auth/password/login/finish",
  "auth/recover",
  "auth/recovery/rotate",
] as const satisfies readonly GatewayMethodName[];

export type IdentityMethod = (typeof IDENTITY_METHODS)[number];
export type IdentityHandlerMap<
  Context extends IdentityGatewayContext = AgentGatewayContext,
> = {
  readonly [Method in IdentityMethod]: GatewayHandler<Method, Context>;
};

export const SETUP_METHODS = [
  "setup/status",
  "setup/network/configure",
  "setup/codex/install",
  "setup/codex/version",
  "setup/codex/login/start",
  "setup/codex/login/cancel",
  "setup/codex/logout",
  "setup/app-server/restart",
] as const satisfies readonly GatewayMethodName[];

export type SetupMethod = (typeof SETUP_METHODS)[number];
export type SetupHandlerMap = AgentHandlerMap<SetupMethod>;

export const ADMIN_METHODS = [
  "admin/host/status",
  "admin/user/inspect",
  "admin/user/register",
  "admin/user/disable",
  "admin/user/enable",
  "admin/user/removal/schedule",
  "admin/user/removal/cancel",
  "admin/user/recovery/start",
  "admin/audit/list",
] as const satisfies readonly GatewayMethodName[];

export type AdminMethod = (typeof ADMIN_METHODS)[number];

export type AdminHandlerMap<Context extends IdentityGatewayContext> = {
  readonly [Method in AdminMethod]: GatewayHandler<Method, Context>;
};

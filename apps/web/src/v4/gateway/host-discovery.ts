import {
  RELAY_MESSAGE_TYPES,
  RELAY_PROTOCOL_VERSION,
  parseRelayWireMessage,
} from "@codex-everywhere/protocol";

import type { PairingDocumentV1 } from "./connect-host.js";

export type HostProfileV1 = Omit<
  PairingDocumentV1,
  "pairingId" | "secret" | "expiresAt"
>;

export async function lookupHostProfile(input: {
  readonly loginName: string;
  readonly principal: "user" | "host-admin";
  readonly relayEndpoint?: string;
  readonly directAddress?: string;
}): Promise<HostProfileV1> {
  const directAddress = input.directAddress?.trim();
  if (directAddress !== undefined && directAddress.length > 0) {
    return discoverDirect(directAddress, input.principal);
  }
  const relayEndpoint = input.relayEndpoint?.trim();
  if (relayEndpoint === undefined || relayEndpoint.length === 0) {
    throw new Error("请输入 Relay 地址或 Direct 宿主机地址");
  }
  return lookupRelay(relayEndpoint, input.loginName, input.principal);
}

async function lookupRelay(
  endpoint: string,
  loginName: string,
  principal: "user" | "host-admin",
): Promise<HostProfileV1> {
  assertWebSocketEndpoint(endpoint, "Relay");
  const socket = new WebSocket(endpoint);
  try {
    await socketOpened(socket);
    const response = nextTextMessage(
      socket,
      "找不到在线的 CodexEverywhere Agent",
    );
    socket.send(
      JSON.stringify({
        type: RELAY_MESSAGE_TYPES.lookup,
        version: RELAY_PROTOCOL_VERSION,
        loginName,
        principal,
      }),
    );
    const profile = parseRelayWireMessage(
      await response,
      RELAY_MESSAGE_TYPES.profile,
    );
    if (
      !isRelayProfile(profile) ||
      (profile.principal ?? "user") !== principal
    ) {
      throw new Error("Relay 返回了无效或错误身份域的宿主机资料");
    }
    return {
      version: 1,
      principal,
      transport: "relay",
      endpoint,
      ...(profile.directEndpoint === undefined
        ? {}
        : { directEndpoint: profile.directEndpoint }),
      routeId: profile.routeId,
      nodeId: profile.nodeId,
      userId: profile.userId,
      hostPublicKey: profile.hostPublicKey,
      hostFingerprint: profile.hostFingerprint,
    };
  } finally {
    socket.close();
  }
}

async function discoverDirect(
  address: string,
  principal: "user" | "host-admin",
): Promise<HostProfileV1> {
  const target = new URL(address);
  const local =
    target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (target.protocol !== "https:" && !(target.protocol === "http:" && local)) {
    throw new Error("Direct 地址必须使用 https://（localhost 可使用 http://）");
  }
  target.pathname = "/.well-known/codex-everywhere";
  target.search = "";
  target.hash = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(target, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Direct 发现失败 (${response.status})`);
    const profile = (await response.json()) as unknown;
    if (!isDirectProfile(profile)) {
      throw new Error("Direct Agent 返回了无效的宿主机资料");
    }
    const endpoint =
      profile.directEndpoint ??
      `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}/gateway`;
    assertWebSocketEndpoint(endpoint, "Direct Gateway");
    return {
      version: 1,
      principal,
      transport: "direct",
      endpoint,
      directEndpoint: endpoint,
      ...(profile.relayEndpoint === undefined
        ? {}
        : { relayEndpoint: profile.relayEndpoint }),
      ...(profile.routeId === undefined ? {} : { routeId: profile.routeId }),
      nodeId: profile.nodeId,
      userId: profile.userId,
      hostPublicKey: profile.hostPublicKey,
      hostFingerprint: profile.hostFingerprint,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Direct 发现超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRelayProfile(value: unknown): value is {
  readonly principal?: "user" | "host-admin";
  readonly routeId: string;
  readonly nodeId: string;
  readonly userId: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
  readonly directEndpoint?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    (profile.principal === undefined ||
      profile.principal === "user" ||
      profile.principal === "host-admin") &&
    boundedString(profile.routeId) &&
    boundedString(profile.nodeId) &&
    boundedString(profile.userId) &&
    base64Key(profile.hostPublicKey) &&
    boundedString(profile.hostFingerprint) &&
    (profile.directEndpoint === undefined ||
      typeof profile.directEndpoint === "string")
  );
}

function isDirectProfile(value: unknown): value is {
  readonly nodeId: string;
  readonly userId: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
  readonly directEndpoint?: string;
  readonly relayEndpoint?: string;
  readonly routeId?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.type === "host/profile" &&
    profile.version === 1 &&
    boundedString(profile.nodeId) &&
    boundedString(profile.userId) &&
    base64Key(profile.hostPublicKey) &&
    boundedString(profile.hostFingerprint) &&
    optionalString(profile.directEndpoint) &&
    optionalString(profile.relayEndpoint) &&
    optionalString(profile.routeId)
  );
}

function assertWebSocketEndpoint(endpoint: string, label: string): void {
  const target = new URL(endpoint);
  if (target.protocol !== "wss:" && target.protocol !== "ws:") {
    throw new Error(`${label} 必须使用 wss:// 或 ws://`);
  }
  if (
    target.protocol === "ws:" &&
    target.hostname !== "localhost" &&
    target.hostname !== "127.0.0.1" &&
    target.hostname !== location.hostname
  ) {
    throw new Error(`${label} 的公网连接必须使用 wss://`);
  }
}

function socketOpened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("连接宿主机超时")),
      10_000,
    );
    const opened = () => finish();
    const failed = () => finish(new Error("无法连接宿主机"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

function nextTextMessage(
  socket: WebSocket,
  timeoutMessage: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(timeoutMessage)), 10_000);
    const received = (event: MessageEvent) =>
      finish(
        typeof event.data === "string"
          ? undefined
          : new Error("Relay 返回了意外的二进制消息"),
        typeof event.data === "string" ? event.data : undefined,
      );
    const closed = () => finish(new Error("Relay 在查找宿主机时关闭了连接"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", received);
      socket.removeEventListener("close", closed);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    socket.addEventListener("message", received);
    socket.addEventListener("close", closed, { once: true });
  });
}

function boundedString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 16_384
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || boundedString(value);
}

function base64Key(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

import type { SavedHost } from "./storage.js";

export function savedHostDisplayName(
  host: Pick<SavedHost, "name"> & Partial<Pick<SavedHost, "deviceName">>,
): string {
  return host.deviceName?.trim() || host.name;
}

export function savedHostLoginName(
  host: Pick<SavedHost, "name" | "nodeId" | "userId"> &
    Partial<Pick<SavedHost, "loginName">>,
): string {
  const loginName = host.loginName?.trim();
  if (loginName) return loginName;

  const legacyName = host.name.trim();
  if (legacyName && legacyName !== host.nodeId) return legacyName;

  const unixId = /^unix:(.+)$/u.exec(host.userId)?.[1];
  return unixId ? `UID ${unixId}` : host.userId;
}

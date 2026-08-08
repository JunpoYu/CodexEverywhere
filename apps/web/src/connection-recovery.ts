export const CONNECTION_RECOVERY_DELAYS_MS = [
  0, 500, 1_000, 2_000, 4_000, 8_000,
] as const;

export function shouldVerifyAfterVisibilityChange(hidden: boolean): boolean {
  return !hidden;
}

export function isRetryableConnectionFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return false;
  const message = error instanceof Error ? error.message : String(error);
  return /cannot reach host|connection (?:timed out|closed|failed|is unavailable)|relay route (?:timed out|was rejected)|encrypted handshake timed out|closed the connection during handshake|networkerror|websocket/iu.test(
    message,
  );
}

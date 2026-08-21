import type { IncomingMessage, ServerResponse } from "node:http";

import { PROTOCOL_VERSION } from "@codex-everywhere/protocol";

export interface DirectDiscoveryMetadata {
  readonly nodeId: string;
  readonly userId: string;
  readonly hostFingerprint: string;
  readonly directEndpoint?: string;
  readonly relayEndpoint?: string;
  readonly relayRouteId?: string;
  readonly allowedOrigin?: string;
}

export function handleDirectDiscoveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  metadata: DirectDiscoveryMetadata,
  hostPublicKey: Uint8Array,
): void {
  const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
    .pathname;
  if (pathname !== "/.well-known/codex-everywhere") {
    writeHttp(response, 404, "Not found\n");
    return;
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    metadata.allowedOrigin !== undefined &&
    origin !== metadata.allowedOrigin
  ) {
    writeHttp(response, 403, "Origin not allowed\n");
    return;
  }
  const corsHeaders = {
    ...(metadata.allowedOrigin === undefined
      ? {}
      : { "Access-Control-Allow-Origin": metadata.allowedOrigin }),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...(request.headers["access-control-request-private-network"] === "true"
      ? { "Access-Control-Allow-Private-Network": "true" }
      : {}),
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, {
      ...corsHeaders,
      Allow: "GET, OPTIONS",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Method not allowed\n");
    return;
  }
  response.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(
    `${JSON.stringify(publicHostProfile(metadata, hostPublicKey))}\n`,
  );
}

export function publicHostProfile(
  metadata: DirectDiscoveryMetadata,
  hostPublicKey: Uint8Array,
) {
  return {
    type: "host/profile" as const,
    version: PROTOCOL_VERSION,
    nodeId: metadata.nodeId,
    userId: metadata.userId,
    hostPublicKey: Buffer.from(hostPublicKey).toString("base64url"),
    hostFingerprint: metadata.hostFingerprint,
    ...(metadata.directEndpoint === undefined
      ? {}
      : { directEndpoint: metadata.directEndpoint }),
    ...(metadata.relayEndpoint !== undefined &&
    metadata.relayRouteId !== undefined
      ? {
          relayEndpoint: metadata.relayEndpoint,
          routeId: metadata.relayRouteId,
        }
      : {}),
  };
}

function writeHttp(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

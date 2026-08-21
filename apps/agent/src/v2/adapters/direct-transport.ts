import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";

import { Scope } from "@codex-everywhere/kernel";
import WebSocket, { WebSocketServer } from "ws";

import {
  handleDirectDiscoveryRequest,
  type DirectDiscoveryMetadata,
} from "./direct-discovery.js";
import {
  acceptGatewayV2Socket,
  gatewaySocketConnectionOptions,
  validateGatewaySocketConnectionOptions,
  type GatewaySocketConnectionOptions,
} from "./gateway-socket-connection.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 128;

export interface DirectTransportV2Options
  extends DirectDiscoveryMetadata, GatewaySocketConnectionOptions {
  readonly parentScope: Scope;
  readonly host: string;
  readonly port: number;
  readonly path?: string;
}

/** HTTP discovery and WebSocket listener for the Direct transport. */
export class DirectTransportV2 extends EventEmitter<{ listening: [number] }> {
  readonly #scope: Scope;
  readonly #server: WebSocketServer;
  readonly #httpServer: HttpServer;
  readonly #connectionOptions: GatewaySocketConnectionOptions;
  readonly #connections = new Set<WebSocket>();

  private constructor(
    scope: Scope,
    server: WebSocketServer,
    httpServer: HttpServer,
    connectionOptions: GatewaySocketConnectionOptions,
  ) {
    super();
    this.#scope = scope;
    this.#server = server;
    this.#httpServer = httpServer;
    this.#connectionOptions = connectionOptions;
  }

  static async start(
    options: DirectTransportV2Options,
  ): Promise<DirectTransportV2> {
    const connectionOptions = gatewaySocketConnectionOptions(options);
    validateGatewaySocketConnectionOptions(connectionOptions);
    const scope = options.parentScope.fork("direct-transport-v2");
    const discoveryMetadata = directDiscoveryMetadata(options);
    const httpServer = createServer((request, response) =>
      handleDirectDiscoveryRequest(
        request,
        response,
        discoveryMetadata,
        connectionOptions.identity.publicKey,
      ),
    );
    const server = new WebSocketServer({
      server: httpServer,
      path: options.path ?? "/gateway",
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: (info: { origin: string }) =>
        options.allowedOrigin === undefined ||
        info.origin === options.allowedOrigin,
    });
    const transport = new DirectTransportV2(
      scope,
      server,
      httpServer,
      connectionOptions,
    );
    const accept = (socket: WebSocket) => transport.#accept(socket);
    server.on("connection", accept);
    scope.defer(() => {
      server.off("connection", accept);
    });
    scope.defer(() => closeHttpServer(httpServer));
    scope.defer(() => closeWebSocketServer(server));
    try {
      await listen(httpServer, options.port, options.host);
      transport.emit("listening", transport.port);
      return transport;
    } catch (error) {
      await scope.close("direct-transport-start-failed").catch(() => undefined);
      throw error;
    }
  }

  get port(): number {
    const address = this.#httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway is not listening");
    }
    return address.port;
  }

  close(): Promise<void> {
    return this.#scope.close("direct-transport-stopped");
  }

  #accept(socket: WebSocket): void {
    if (this.#connections.size >= MAX_CONNECTIONS) {
      socket.close(1013, "gateway busy");
      return;
    }
    this.#connections.add(socket);
    const remove = () => this.#connections.delete(socket);
    socket.once("close", remove);
    acceptGatewayV2Socket(socket, this.#connectionOptions, this.#scope);
  }
}

function directDiscoveryMetadata(
  options: DirectTransportV2Options,
): DirectDiscoveryMetadata {
  return {
    nodeId: options.nodeId,
    userId: options.userId,
    hostFingerprint: options.hostFingerprint,
    ...(options.directEndpoint === undefined
      ? {}
      : { directEndpoint: options.directEndpoint }),
    ...(options.relayEndpoint === undefined
      ? {}
      : { relayEndpoint: options.relayEndpoint }),
    ...(options.relayRouteId === undefined
      ? {}
      : { relayRouteId: options.relayRouteId }),
    ...(options.allowedOrigin === undefined
      ? {}
      : { allowedOrigin: options.allowedOrigin }),
  };
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", resolve);
      reject(error);
    };
    server.once("listening", resolve);
    server.once("error", failed);
    server.listen(port, host);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

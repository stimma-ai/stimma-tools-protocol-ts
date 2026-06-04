/**
 * Transport layer for STP communication.
 *
 * Supports:
 * - Stdio: Newline-delimited JSON on stdin/stdout
 * - WebSocket: WebSocket server for remote providers
 */

import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
  JsonRpcErrorCode,
  parseMessage,
} from "./protocol.js";
import { getLogger } from "./logger.js";

const logger = getLogger("stimma_tools.transport");

// --- Transport Interface ---

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: string): Promise<void>;
  receive(): AsyncGenerator<string, void, unknown>;
  readonly isRunning: boolean;
}

// --- Stdio Transport ---

export class StdioTransport implements Transport {
  private _running = false;
  private _sendLock: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    this._running = true;
    logger.debug("Stdio transport started");
  }

  async stop(): Promise<void> {
    this._running = false;
    // Destroy stdin to unblock readline
    try {
      process.stdin.destroy();
    } catch {
      // ignore
    }
    logger.debug("Stdio transport stopped");
  }

  async send(message: string): Promise<void> {
    // Serialize writes to stdout
    const prev = this._sendLock;
    let release!: () => void;
    this._sendLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const line = message.replace(/\n$/, "") + "\n";
      process.stdout.write(line);
    } finally {
      release();
    }
  }

  async *receive(): AsyncGenerator<string, void, unknown> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!this._running) break;
        const trimmed = line.trim();
        if (trimmed) {
          yield trimmed;
        }
      }
    } catch (e) {
      if (this._running) {
        logger.error(`Error reading from stdin: ${e}`);
      }
    } finally {
      rl.close();
    }
    logger.debug("Stdin EOF received");
  }

  get isRunning(): boolean {
    return this._running;
  }
}

// --- WebSocket Transport ---

export class WebSocketTransport implements Transport {
  private _host: string;
  private _port: number;
  private _authToken?: string;
  private _wsPath: string;
  private _running = false;
  private _server?: Server;
  private _clients: Set<import("ws").WebSocket> = new Set();
  private _messageQueue: string[] = [];
  private _messageResolve?: () => void;
  private _sendLock: Promise<void> = Promise.resolve();
  private _firstClientConnected = false;
  private _firstClientResolve?: () => void;
  _onClientConnected?: () => Promise<void>;
  private _additionalRoutes: Array<{
    method: string;
    path: RegExp;
    handler: (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray) => Promise<void>;
  }> = [];

  constructor(opts?: {
    host?: string;
    port?: number;
    authToken?: string;
    wsPath?: string;
  }) {
    this._host = opts?.host ?? "127.0.0.1";
    this._port = opts?.port ?? 8765;
    this._authToken = opts?.authToken;
    this._wsPath = opts?.wsPath ?? "/stp-v1";
  }

  addRoutes(
    routes: Array<{
      method: string;
      path: RegExp;
      handler: (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray) => Promise<void>;
    }>,
  ): void {
    this._additionalRoutes.push(...routes);
  }

  async start(): Promise<void> {
    const { WebSocketServer } = await import("ws");

    this._server = createServer((req, res) => {
      // A configured token gates the asset (HTTP) routes too, not just the WebSocket upgrade.
      if (this._authToken) {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== this._authToken) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }
      // Try additional routes
      for (const route of this._additionalRoutes) {
        if (req.method === route.method || route.method === "*") {
          const match = req.url?.match(route.path);
          if (match) {
            route.handler(req, res, match).catch((err) => {
              logger.error(`Route handler error: ${err}`);
              res.writeHead(500);
              res.end("Internal Server Error");
            });
            return;
          }
        }
      }
      res.writeHead(404);
      res.end("Not Found");
    });

    const wss = new WebSocketServer({ server: this._server, path: this._wsPath });

    wss.on("connection", (ws, req) => {
      // Validate auth
      if (this._authToken) {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== this._authToken) {
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      this._clients.add(ws);
      const addr = req.socket.remoteAddress;
      logger.info(`WebSocket client connected: ${addr}`);

      const isFirst = !this._firstClientConnected;
      if (isFirst) {
        this._firstClientConnected = true;
        this._firstClientResolve?.();
      } else if (this._onClientConnected) {
        logger.info("New client connected, triggering re-registration");
        this._onClientConnected().catch((e) =>
          logger.error(`Re-registration callback error: ${e}`),
        );
      }

      ws.on("message", (data) => {
        const message = typeof data === "string" ? data : data.toString("utf-8");
        this._messageQueue.push(message);
        this._messageResolve?.();
      });

      ws.on("error", (err) => {
        logger.error(`WebSocket error: ${err}`);
      });

      ws.on("close", () => {
        this._clients.delete(ws);
        logger.info(`WebSocket client disconnected: ${addr}`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.listen(this._port, this._host, () => resolve());
      this._server!.on("error", reject);
    });

    this._running = true;
    const address = this._server.address();
    const actualPort =
      typeof address === "object" && address ? address.port : this._port;
    this._port = actualPort;

    logger.info(`Server listening on http://${this._host}:${actualPort}`);
    logger.info(`WebSocket endpoint: ws://${this._host}:${actualPort}${this._wsPath}`);
    logger.info("Waiting for first client to connect...");

    // Wait for first client
    if (!this._firstClientConnected) {
      await new Promise<void>((resolve) => {
        this._firstClientResolve = resolve;
      });
    }
    logger.info("First client connected, transport ready");
  }

  async stop(): Promise<void> {
    this._running = false;

    for (const client of this._clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this._clients.clear();

    // Unblock any waiting receive()
    this._messageResolve?.();

    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
      });
    }

    logger.debug("WebSocket transport stopped");
  }

  async send(message: string): Promise<void> {
    const prev = this._sendLock;
    let release!: () => void;
    this._sendLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      if (this._clients.size === 0) {
        logger.warning("No WebSocket clients connected");
        return;
      }

      for (const client of this._clients) {
        try {
          client.send(message);
        } catch (e) {
          logger.error(`Error sending to client: ${e}`);
          this._clients.delete(client);
        }
      }
    } finally {
      release();
    }
  }

  async *receive(): AsyncGenerator<string, void, unknown> {
    while (this._running) {
      if (this._messageQueue.length > 0) {
        yield this._messageQueue.shift()!;
        continue;
      }

      // Wait for a message or stop
      await new Promise<void>((resolve) => {
        this._messageResolve = resolve;
        // Also resolve after a timeout so we can check _running
        setTimeout(resolve, 1000);
      });
    }
  }

  get isRunning(): boolean {
    return this._running;
  }

  get port(): number {
    return this._port;
  }
}

// --- Message Handler ---

export class MessageHandler {
  private _transport: Transport;
  private _onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private _onNotification?: (notification: JsonRpcNotification) => Promise<void>;
  private _pendingResponses: Map<
    string | number,
    { resolve: (resp: JsonRpcResponse) => void; reject: (err: Error) => void }
  > = new Map();

  constructor(opts: {
    transport: Transport;
    onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
    onNotification?: (notification: JsonRpcNotification) => Promise<void>;
  }) {
    this._transport = opts.transport;
    this._onRequest = opts.onRequest;
    this._onNotification = opts.onNotification;
  }

  async sendRequest(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const requestId = randomUUID();
    const request = new JsonRpcRequest(method, requestId, params);

    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this._pendingResponses.set(requestId, { resolve, reject });
    });

    await this._transport.send(request.toJson());

    try {
      return await promise;
    } finally {
      this._pendingResponses.delete(requestId);
    }
  }

  async sendResponse(response: JsonRpcResponse): Promise<void> {
    await this._transport.send(response.toJson());
  }

  async sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const notification = new JsonRpcNotification(method, params);
    await this._transport.send(notification.toJson());
  }

  async handleMessage(message: string): Promise<void> {
    let parsed;
    try {
      parsed = parseMessage(message);
    } catch (e) {
      const error = JsonRpcError.fromCode(
        JsonRpcErrorCode.ParseError,
        String(e),
      );
      const response = JsonRpcResponse.failure(null, error);
      await this._transport.send(response.toJson());
      return;
    }

    if (parsed instanceof JsonRpcResponse) {
      const pending = this._pendingResponses.get(parsed.id!);
      if (pending) {
        this._pendingResponses.delete(parsed.id!);
        pending.resolve(parsed);
      }
    } else if (parsed instanceof JsonRpcRequest) {
      if (this._onRequest) {
        try {
          const response = await this._onRequest(parsed);
          await this._transport.send(response.toJson());
        } catch (e) {
          logger.error(`Error handling request: ${e}`);
          const error = JsonRpcError.fromCode(
            JsonRpcErrorCode.InternalError,
            String(e),
          );
          const response = JsonRpcResponse.failure(parsed.id, error);
          await this._transport.send(response.toJson());
        }
      } else {
        const error = JsonRpcError.fromCode(JsonRpcErrorCode.MethodNotFound);
        const response = JsonRpcResponse.failure(parsed.id, error);
        await this._transport.send(response.toJson());
      }
    } else if (parsed instanceof JsonRpcNotification) {
      if (this._onNotification) {
        try {
          await this._onNotification(parsed);
        } catch (e) {
          logger.error(`Error handling notification: ${e}`);
        }
      }
    }
  }

  close(): void {
    for (const [, pending] of this._pendingResponses) {
      pending.reject(new Error("MessageHandler closed"));
    }
    this._pendingResponses.clear();
  }

  async run(): Promise<void> {
    try {
      for await (const message of this._transport.receive()) {
        await this.handleMessage(message);
      }
    } finally {
      this.close();
    }
  }
}

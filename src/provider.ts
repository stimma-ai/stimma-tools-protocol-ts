/**
 * Provider base class for STP providers.
 *
 * Handles registration, tool listing, heartbeat handling, and job execution.
 */

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
  JsonRpcErrorCode,
  ProviderRegistration,
  RegistrationResponse,
  ExecuteRequest,
  QueueStatus,
  ProgressNotification,
  ExecutionResult,
  STPError,
} from "./protocol.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport, MessageHandler } from "./transport.js";
import { Tool, ToolRegistry, getRegistry } from "./tool.js";
import type { ExecutionContext } from "./tool.js";
import type { AssetManager } from "./assets.js";
import { LocalAssetServer } from "./assets.js";
import { getLogger } from "./logger.js";
import type { ToolParameterDef } from "./tool.js";

const logger = getLogger("stimma_tools.provider");

// --- Semaphore ---

class Semaphore {
  private _capacity: number;
  private _count = 0;
  private _waiting: Array<() => void> = [];

  constructor(capacity: number) {
    this._capacity = capacity;
  }

  async acquire(): Promise<void> {
    if (this._count < this._capacity) {
      this._count++;
      return;
    }
    await new Promise<void>((resolve) => {
      this._waiting.push(resolve);
    });
    this._count++;
  }

  release(): void {
    this._count--;
    const next = this._waiting.shift();
    if (next) next();
  }
}

// --- Output normalization ---

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", ogg: "audio",
};

function inferMediaType(assetId: string): string {
  const ext = assetId.includes(".") ? assetId.split(".").pop()!.toLowerCase() : "";
  return MEDIA_TYPE_BY_EXT[ext] ?? "document";
}

/**
 * Normalize a tool's return value to the STP output envelope: { assets: [...] }.
 * Accepts the envelope form ({ assets: [...] }) or the ergonomic single-asset form
 * ({ asset_id: "..." }); other top-level keys are preserved.
 */
export function normalizeOutput(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return { assets: [] };
  }
  const obj = result as Record<string, unknown>;
  if ("assets" in obj) {
    return obj;
  }
  const { asset_id, ...rest } = obj;
  return {
    ...rest,
    assets: asset_id
      ? [{ asset_id, type: inferMediaType(asset_id as string), role: "primary" }]
      : [],
  };
}

// --- Provider Config ---

export interface ProviderConfig {
  providerId: string;
  providerName: string;
  server?: string; // Software identifier, e.g. "my-provider/1.2.3"
  maxConcurrent?: number;
  supportsCancel?: boolean; // exposed as the `cancel` capability
  assetEndpoint?: string;
}

// --- Job ---

interface Job {
  requestId: string;
  tool: Tool;
  parameters: Record<string, unknown>;
  abortController: AbortController;
  cancelled: boolean;
  execution?: Promise<void>;
}

// --- Provider ---

export class Provider {
  private _config: Required<
    Pick<ProviderConfig, "providerId" | "providerName">
  > &
    ProviderConfig;
  private _transport?: Transport;
  private _registry: ToolRegistry;
  private _handler?: MessageHandler;
  private _assets?: AssetManager;
  private _sessionId?: string;

  // Job management
  private _queuedJobs: Job[] = [];
  private _runningJobs: Map<string, Job> = new Map();
  private _jobSemaphore: Semaphore;
  private _jobProcessorRunning = false;
  private _jobProcessorAbort?: AbortController;
  private _messageLoopPromise?: Promise<void>;

  // Shutdown
  private _shutdownRequested = false;
  private _shutdownResolve?: () => void;

  constructor(opts: {
    config: ProviderConfig;
    transport?: Transport;
    toolRegistry?: ToolRegistry;
  }) {
    this._config = {
      maxConcurrent: 1,
      supportsCancel: true,
      assetEndpoint: "/assets",
      ...opts.config,
    };
    this._transport = opts.transport;
    this._registry = opts.toolRegistry ?? getRegistry();
    this._jobSemaphore = new Semaphore(this._config.maxConcurrent!);
  }

  get config(): ProviderConfig {
    return this._config;
  }

  get assets(): AssetManager {
    if (!this._assets) {
      throw new Error("Provider not started - no asset manager available");
    }
    return this._assets;
  }

  async start(assetManager?: AssetManager): Promise<void> {
    if (!this._transport) {
      throw new Error("No transport configured");
    }

    logger.info(`Starting provider: ${this._config.providerName}`);

    // For WebSocket transport, set up local asset serving
    if (this._transport instanceof WebSocketTransport) {
      if (assetManager == null) {
        this._assets = new LocalAssetServer();
      } else {
        this._assets = assetManager;
      }

      if (this._assets instanceof LocalAssetServer) {
        const assetRoutes = this._assets.getHttpRoutes(
          this._config.assetEndpoint!,
        );
        this._transport.addRoutes(assetRoutes);
        logger.info(`Asset endpoint: ${this._config.assetEndpoint}`);
      }

      this._transport._onClientConnected = () => this._onNewClient();
    } else {
      this._assets = assetManager ?? undefined;
    }

    // Start transport
    await this._transport.start();

    // Set up message handler
    this._handler = new MessageHandler({
      transport: this._transport,
      onRequest: (req) => this._handleRequest(req),
      onNotification: (notif) => this._handleNotification(notif),
    });

    // Start message receiving loop BEFORE registration
    this._messageLoopPromise = this._runMessageLoop();

    // Send registration
    await this._register();

    // Start job processor
    this._startJobProcessor();

    logger.info(`Provider started: ${this._config.providerName}`);
  }

  private async _onNewClient(): Promise<void> {
    logger.info("New client connected, re-registering...");
    try {
      await this._register();
      logger.info("Re-registration complete");
    } catch (e) {
      logger.error(`Re-registration failed: ${e}`);
    }
  }

  async stop(): Promise<void> {
    logger.info(`Stopping provider: ${this._config.providerName}`);

    this._shutdownRequested = true;
    this._shutdownResolve?.();

    // Cancel all running jobs
    const runningExecutions: Promise<void>[] = [];
    for (const job of this._runningJobs.values()) {
      job.abortController.abort();
      if (job.execution) runningExecutions.push(job.execution);
    }

    // Stop job processor
    this._jobProcessorAbort?.abort();

    // Give cooperative AbortSignal consumers time to finish their cleanup and
    // publish cancellation results before disconnecting the transport.
    if (runningExecutions.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(runningExecutions),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }

    // Send disconnect notification
    if (this._handler) {
      try {
        await this._handler.sendNotification("provider.disconnect", {
          reason: "shutdown",
        });
      } catch {
        // ignore
      }
    }

    // Stop transport (unblocks message loop)
    if (this._transport) {
      await this._transport.stop();
    }

    // Wait for message loop
    if (this._messageLoopPromise) {
      try {
        await this._messageLoopPromise;
      } catch {
        // ignore
      }
    }

    // Close handler (cancel pending responses)
    this._handler?.close();

    logger.info(`Provider stopped: ${this._config.providerName}`);
  }

  async run(): Promise<void> {
    if (!this._handler) {
      throw new Error("Provider not started");
    }

    try {
      await this._messageLoopPromise;
    } catch {
      // ignore
    } finally {
      await this.stop();
    }
  }

  private async _runMessageLoop(): Promise<void> {
    if (!this._handler) return;
    try {
      await this._handler.run();
    } catch (e) {
      if (!this._shutdownRequested) {
        logger.error(`Message loop error: ${e}`);
      }
    }
  }

  private async _register(): Promise<void> {
    if (!this._handler) {
      throw new Error("Handler not initialized");
    }

    let assetEndpoint: string | undefined;
    if (this._transport instanceof WebSocketTransport) {
      assetEndpoint = this._config.assetEndpoint;
    }

    const registration = new ProviderRegistration({
      providerId: this._config.providerId,
      providerName: this._config.providerName,
      server: this._config.server,
      maxConcurrent: this._config.maxConcurrent,
      capabilities: { cancel: this._config.supportsCancel ?? false },
      assetEndpoint,
    });

    const response = await this._handler.sendRequest(
      "provider.register",
      registration.toDict() as unknown as Record<string, unknown>,
    );

    if (response.error) {
      throw new Error(`Registration failed: ${response.error.message}`);
    }

    const result = RegistrationResponse.fromDict(
      response.result as Record<string, unknown>,
    );
    this._sessionId = result.sessionId;

    logger.info(`Registered with session ID: ${this._sessionId}`);
  }

  private async _handleRequest(
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const method = request.method;
    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      switch (method) {
        case "tools.list":
          return this._handleToolsList(request);
        case "tools.refresh":
          return await this._handleToolsRefresh(request);
        case "tools.execute":
          return await this._handleToolsExecute(request, params);
        case "tools.cancel":
          return this._handleToolsCancel(request, params);
        default: {
          const error = JsonRpcError.fromCode(JsonRpcErrorCode.MethodNotFound);
          return JsonRpcResponse.failure(request.id, error);
        }
      }
    } catch (e) {
      logger.error(`Error handling request ${method}: ${e}`);
      const error = JsonRpcError.fromCode(
        JsonRpcErrorCode.InternalError,
        String(e),
      );
      return JsonRpcResponse.failure(request.id, error);
    }
  }

  private async _handleNotification(
    notification: JsonRpcNotification,
  ): Promise<void> {
    logger.debug(`Received notification: ${notification.method}`);
  }

  private _handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    const tools = this._registry.listDescriptors();
    return JsonRpcResponse.success(request.id, {
      tools: tools.map((t) => t.toDict()),
    });
  }

  private async _handleToolsRefresh(
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    await this.onRefresh();
    const tools = this._registry.listDescriptors();
    return JsonRpcResponse.success(request.id, {
      tools: tools.map((t) => t.toDict()),
    });
  }

  private async _handleToolsExecute(
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    logger.info(`[tools.execute] raw params: ${JSON.stringify(params)}`);
    const execRequest = ExecuteRequest.fromDict(params);

    const tool = this._registry.get(execRequest.toolId);
    if (!tool) {
      const error = new JsonRpcError(
        -32000,
        `Tool not found: ${execRequest.toolId}`,
      );
      return JsonRpcResponse.failure(request.id, error);
    }

    const job: Job = {
      requestId: execRequest.requestId,
      tool,
      parameters: execRequest.parameters,
      abortController: new AbortController(),
      cancelled: false,
    };
    this._queuedJobs.push(job);

    await this._sendQueueStatus();

    return JsonRpcResponse.success(request.id, { accepted: true });
  }

  private _handleToolsCancel(
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): JsonRpcResponse {
    const requestId = params.request_id as string;

    // Check queued jobs
    const queueIdx = this._queuedJobs.findIndex(
      (j) => j.requestId === requestId,
    );
    if (queueIdx !== -1) {
      this._queuedJobs.splice(queueIdx, 1);
      this._sendQueueStatus().catch(() => {});
      return JsonRpcResponse.success(request.id, { cancelled: true });
    }

    // Check running jobs
    const runningJob = this._runningJobs.get(requestId);
    if (runningJob) {
      runningJob.cancelled = true;
      runningJob.abortController.abort();
      return JsonRpcResponse.success(request.id, { cancelled: true });
    }

    return JsonRpcResponse.success(request.id, {
      cancelled: false,
      reason: "not_found",
    });
  }

  private _startJobProcessor(): void {
    this._jobProcessorRunning = true;
    this._jobProcessorAbort = new AbortController();
    this._processJobs().catch(() => {});
  }

  private async _processJobs(): Promise<void> {
    while (!this._shutdownRequested) {
      if (this._queuedJobs.length === 0) {
        // Wait a bit before checking again
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          this._shutdownResolve = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        continue;
      }

      // Keep the next job visible in the queue until execution capacity is
      // available, so queue.status and tools.cancel remain truthful.
      await this._jobSemaphore.acquire();

      if (this._shutdownRequested) {
        this._jobSemaphore.release();
        break;
      }
      const job = this._queuedJobs.shift();
      if (!job) {
        // It may have been cancelled while capacity was pending.
        this._jobSemaphore.release();
        continue;
      }

      this._runningJobs.set(job.requestId, job);
      job.execution = this._executeJob(job);
      job.execution.catch(() => {});
      await this._sendQueueStatus();
    }
  }

  private _applyDefaults(
    params: Record<string, unknown>,
    paramList: ToolParameterDef[],
  ): Record<string, unknown> {
    const result = { ...params };
    for (const p of paramList) {
      if (!(p.name in result) && p.default !== undefined) {
        result[p.name] = p.default;
      }
    }
    return result;
  }

  private async _executeJob(job: Job): Promise<void> {
    try {
      if (!this._assets) {
        throw new Error("Asset manager not configured");
      }

      // Apply schema defaults
      const parameters = this._applyDefaults(
        job.parameters,
        job.tool.parameters,
      );

      // Track which keys were originally provided
      (parameters as Record<string, unknown>)._provided_keys = new Set(
        Object.keys(job.parameters),
      );

      const context: ExecutionContext = {
        requestId: job.requestId,
        tool: job.tool,
        parameters,
        assets: this._assets,
        signal: job.abortController.signal,
        reportProgress: (progress: number) =>
          this._sendProgress(job.requestId, progress),
      };

      const result = await job.tool.execute(context, parameters);

      if (!job.cancelled) {
        await this._sendResult({
          requestId: job.requestId,
          success: true,
          output: normalizeOutput(result),
        });
      }
    } catch (e) {
      if (job.cancelled || (e instanceof Error && e.name === "AbortError")) {
        await this._sendResult({
          requestId: job.requestId,
          success: false,
          error: { code: "CANCELLED", message: "Job was cancelled" },
        });
      } else if (e instanceof STPError) {
        await this._sendResult({
          requestId: job.requestId,
          success: false,
          error: e.toDict(),
        });
      } else {
        logger.error(`Job ${job.requestId} failed: ${e}`);
        await this._sendResult({
          requestId: job.requestId,
          success: false,
          error: { code: "EXECUTION_FAILED", message: String(e) },
        });
      }
    } finally {
      this._runningJobs.delete(job.requestId);
      this._jobSemaphore.release();
      await this._sendQueueStatus();
    }
  }

  private async _sendQueueStatus(): Promise<void> {
    if (!this._handler) return;
    const status = new QueueStatus(
      this._queuedJobs.length,
      this._runningJobs.size,
      this._config.maxConcurrent!,
    );
    await this._handler.sendNotification(
      "queue.status",
      status.toDict() as unknown as Record<string, unknown>,
    );
  }

  private async _sendProgress(
    requestId: string,
    progress: number,
  ): Promise<void> {
    if (!this._handler) return;
    const notification = new ProgressNotification(requestId, progress);
    await this._handler.sendNotification(
      "tools.progress",
      notification.toDict() as Record<string, unknown>,
    );
  }

  private async _sendResult(opts: {
    requestId: string;
    success: boolean;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this._handler) return;
    const result = new ExecutionResult(opts);
    await this._handler.sendNotification(
      "tools.result",
      result.toDict() as Record<string, unknown>,
    );
  }

  /**
   * Called when tools.refresh is requested.
   * Override in subclass to dynamically update the tool registry.
   */
  async onRefresh(): Promise<void> {
    // no-op by default
  }
}

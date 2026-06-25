/**
 * JSON-RPC 2.0 and Stimma Tools Protocol message types.
 */

// --- JSON-RPC 2.0 Error Codes ---

export enum JsonRpcErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

// --- STP Application Error Codes ---

export enum STPErrorCode {
  ToolNotFound = "TOOL_NOT_FOUND",
  AssetNotFound = "ASSET_NOT_FOUND",
  ExecutionFailed = "EXECUTION_FAILED",
  Cancelled = "CANCELLED",
  Timeout = "TIMEOUT",
  OutOfMemory = "OUT_OF_MEMORY",
  ModelNotLoaded = "MODEL_NOT_LOADED",
}

// --- JSON-RPC 2.0 Message Types ---

export interface JsonRpcErrorData {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError {
  code: number;
  message: string;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    this.code = code;
    this.message = message;
    this.data = data;
  }

  toDict(): JsonRpcErrorData {
    const result: JsonRpcErrorData = { code: this.code, message: this.message };
    if (this.data !== undefined) {
      result.data = this.data;
    }
    return result;
  }

  static fromCode(code: JsonRpcErrorCode, data?: unknown): JsonRpcError {
    const messages: Record<JsonRpcErrorCode, string> = {
      [JsonRpcErrorCode.ParseError]: "Parse error",
      [JsonRpcErrorCode.InvalidRequest]: "Invalid Request",
      [JsonRpcErrorCode.MethodNotFound]: "Method not found",
      [JsonRpcErrorCode.InvalidParams]: "Invalid params",
      [JsonRpcErrorCode.InternalError]: "Internal error",
    };
    return new JsonRpcError(code, messages[code], data);
  }
}

export class JsonRpcRequest {
  method: string;
  id: string | number;
  params?: Record<string, unknown>;
  jsonrpc: string;

  constructor(
    method: string,
    id: string | number,
    params?: Record<string, unknown>,
    jsonrpc: string = "2.0",
  ) {
    this.method = method;
    this.id = id;
    this.params = params;
    this.jsonrpc = jsonrpc;
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      jsonrpc: this.jsonrpc,
      method: this.method,
      id: this.id,
    };
    if (this.params !== undefined) {
      result.params = this.params;
    }
    return result;
  }

  toJson(): string {
    return JSON.stringify(this.toDict());
  }

  static fromDict(data: Record<string, unknown>): JsonRpcRequest {
    return new JsonRpcRequest(
      data.method as string,
      data.id as string | number,
      data.params as Record<string, unknown> | undefined,
      (data.jsonrpc as string) ?? "2.0",
    );
  }
}

export class JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
  jsonrpc: string;

  constructor(
    id: string | number | null,
    result?: unknown,
    error?: JsonRpcError,
    jsonrpc: string = "2.0",
  ) {
    this.id = id;
    this.result = result;
    this.error = error;
    this.jsonrpc = jsonrpc;
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      jsonrpc: this.jsonrpc,
      id: this.id,
    };
    if (this.error !== undefined) {
      result.error = this.error.toDict();
    } else {
      result.result = this.result;
    }
    return result;
  }

  toJson(): string {
    return JSON.stringify(this.toDict());
  }

  static success(id: string | number, result: unknown): JsonRpcResponse {
    return new JsonRpcResponse(id, result);
  }

  static failure(
    id: string | number | null,
    error: JsonRpcError,
  ): JsonRpcResponse {
    return new JsonRpcResponse(id, undefined, error);
  }
}

export class JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
  jsonrpc: string;

  constructor(
    method: string,
    params?: Record<string, unknown>,
    jsonrpc: string = "2.0",
  ) {
    this.method = method;
    this.params = params;
    this.jsonrpc = jsonrpc;
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      jsonrpc: this.jsonrpc,
      method: this.method,
    };
    if (this.params !== undefined) {
      result.params = this.params;
    }
    return result;
  }

  toJson(): string {
    return JSON.stringify(this.toDict());
  }
}

// --- STP Error ---

export class STPError extends Error {
  code: STPErrorCode;

  constructor(code: STPErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "STPError";
  }

  toDict(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

// --- STP Message Types ---

export const STP_VERSION = "1.0";

export interface ProviderRegistrationData {
  stp_version: string;
  provider_id: string;
  provider_name: string;
  server?: string;
  max_concurrent: number;
  capabilities: Record<string, unknown>;
  asset_endpoint?: string;
}

export class ProviderRegistration {
  providerId: string;
  providerName: string;
  server?: string;
  maxConcurrent: number;
  capabilities: Record<string, unknown>;
  assetEndpoint?: string;
  stpVersion: string;

  constructor(opts: {
    providerId: string;
    providerName: string;
    server?: string;
    maxConcurrent?: number;
    capabilities?: Record<string, unknown>;
    assetEndpoint?: string;
    stpVersion?: string;
  }) {
    this.providerId = opts.providerId;
    this.providerName = opts.providerName;
    this.server = opts.server;
    this.maxConcurrent = opts.maxConcurrent ?? 1;
    this.capabilities = opts.capabilities ?? {};
    this.assetEndpoint = opts.assetEndpoint;
    this.stpVersion = opts.stpVersion ?? STP_VERSION;
  }

  toDict(): ProviderRegistrationData {
    const result: ProviderRegistrationData = {
      stp_version: this.stpVersion,
      provider_id: this.providerId,
      provider_name: this.providerName,
      max_concurrent: this.maxConcurrent,
      capabilities: this.capabilities,
    };
    if (this.server) {
      result.server = this.server;
    }
    if (this.assetEndpoint) {
      result.asset_endpoint = this.assetEndpoint;
    }
    return result;
  }
}

export class RegistrationResponse {
  sessionId: string;
  stpVersion?: string;
  hostVersion?: string;
  capabilities: Record<string, unknown>;

  constructor(
    sessionId: string,
    stpVersion?: string,
    hostVersion?: string,
    capabilities?: Record<string, unknown>,
  ) {
    this.sessionId = sessionId;
    this.stpVersion = stpVersion;
    this.hostVersion = hostVersion;
    this.capabilities = capabilities ?? {};
  }

  static fromDict(data: Record<string, unknown>): RegistrationResponse {
    return new RegistrationResponse(
      data.session_id as string,
      data.stp_version as string | undefined,
      data.host_version as string | undefined,
      (data.capabilities as Record<string, unknown>) ?? {},
    );
  }
}

export interface ToolDescriptorData {
  id: string;
  name: string;
  task_types: string[];
  parameter_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  metadata: Record<string, unknown>;
  layout?: unknown[];
  // Lab/company that made the model (e.g. "black-forest-labs"). Distinct from `provider`.
  model_vendor?: string;
  // Specific model, tight to parameters (e.g. "flux2-klein-9b"). Distinct from `provider`.
  model?: string;
}

export class ToolDescriptor {
  id: string;
  name: string;
  taskTypes: string[];
  parameterSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  layout?: unknown[];
  metadata: Record<string, unknown>;
  modelVendor?: string;
  model?: string;

  constructor(opts: {
    id: string;
    name: string;
    taskTypes: string[];
    parameterSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    layout?: unknown[];
    metadata?: Record<string, unknown>;
    modelVendor?: string;
    model?: string;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.taskTypes = opts.taskTypes;
    this.parameterSchema = opts.parameterSchema ?? {};
    this.outputSchema = opts.outputSchema ?? {};
    this.layout = opts.layout;
    this.metadata = opts.metadata ?? {};
    this.modelVendor = opts.modelVendor;
    this.model = opts.model;
  }

  toDict(): ToolDescriptorData {
    const result: ToolDescriptorData = {
      id: this.id,
      name: this.name,
      task_types: this.taskTypes,
      parameter_schema: this.parameterSchema,
      output_schema: this.outputSchema,
      metadata: this.metadata,
    };
    if (this.layout !== undefined) {
      result.layout = this.layout;
    }
    if (this.modelVendor !== undefined) {
      result.model_vendor = this.modelVendor;
    }
    if (this.model !== undefined) {
      result.model = this.model;
    }
    return result;
  }
}

export class ExecuteRequest {
  requestId: string;
  toolId: string;
  parameters: Record<string, unknown>;

  constructor(
    requestId: string,
    toolId: string,
    parameters: Record<string, unknown> = {},
  ) {
    this.requestId = requestId;
    this.toolId = toolId;
    this.parameters = parameters;
  }

  static fromDict(data: Record<string, unknown>): ExecuteRequest {
    return new ExecuteRequest(
      data.request_id as string,
      data.tool_id as string,
      (data.parameters as Record<string, unknown>) ?? {},
    );
  }
}

export class QueueStatus {
  queued: number;
  running: number;
  capacity: number;

  constructor(queued: number, running: number, capacity: number) {
    this.queued = queued;
    this.running = running;
    this.capacity = capacity;
  }

  toDict(): Record<string, number> {
    return {
      queued: this.queued,
      running: this.running,
      capacity: this.capacity,
    };
  }
}

export class ProgressNotification {
  requestId: string;
  progress: number;

  constructor(requestId: string, progress: number) {
    this.requestId = requestId;
    this.progress = progress;
  }

  toDict(): Record<string, unknown> {
    return {
      request_id: this.requestId,
      progress: this.progress,
    };
  }
}

export class ExecutionResult {
  requestId: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  metadata: Record<string, unknown>;

  constructor(opts: {
    requestId: string;
    success: boolean;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) {
    this.requestId = opts.requestId;
    this.success = opts.success;
    this.output = opts.output;
    this.error = opts.error;
    this.metadata = opts.metadata ?? {};
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      request_id: this.requestId,
      success: this.success,
    };
    if (this.success) {
      result.output = this.output ?? {};
      result.metadata = this.metadata;
    } else {
      result.error = this.error ?? {};
    }
    return result;
  }
}

// --- Parser ---

export type ParsedMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function parseMessage(data: string): ParsedMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }

  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    throw new Error("Message must be a JSON object");
  }

  if (!("jsonrpc" in msg) || msg.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC version");
  }

  // Response (has result or error)
  if ("result" in msg || "error" in msg) {
    let error: JsonRpcError | undefined;
    if ("error" in msg && msg.error) {
      const err = msg.error as Record<string, unknown>;
      error = new JsonRpcError(
        err.code as number,
        err.message as string,
        err.data,
      );
    }
    return new JsonRpcResponse(
      (msg.id as string | number | null) ?? null,
      msg.result,
      error,
    );
  }

  // Request or Notification
  if (!("method" in msg)) {
    throw new Error("Missing method field");
  }

  if ("id" in msg) {
    return JsonRpcRequest.fromDict(msg);
  } else {
    return new JsonRpcNotification(
      msg.method as string,
      msg.params as Record<string, unknown> | undefined,
    );
  }
}

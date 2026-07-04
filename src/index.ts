/**
 * Stimma Tools Protocol (STP) Framework
 *
 * A TypeScript framework for building STP-compliant tool providers.
 */

// Protocol
export {
  JsonRpcErrorCode,
  STPErrorCode,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  STPError,
  ProviderRegistration,
  RegistrationResponse,
  ToolDescriptor,
  ExecuteRequest,
  QueueStatus,
  ProgressNotification,
  ExecutionResult,
  parseMessage,
} from "./protocol.js";

export type {
  JsonRpcErrorData,
  ProviderRegistrationData,
  ToolDescriptorData,
  ParsedMessage,
} from "./protocol.js";

// Tool
export {
  STANDARD_TASK_TYPES,
  Param,
  Group,
  Tool,
  ToolRegistry,
  getRegistry,
  defineTool,
} from "./tool.js";

export type {
  StandardTaskType,
  ParamRef,
  GroupDef,
  ToolParameterDef,
  ExecutionContext,
  ToolFunction,
  DefineToolOptions,
} from "./tool.js";

// Transport
export {
  StdioTransport,
  WebSocketTransport,
  MessageHandler,
} from "./transport.js";

export type { Transport } from "./transport.js";

// Assets
export {
  FilesystemAssetManager,
  HttpAssetManager,
  LocalAssetServer,
  createAssetManager,
} from "./assets.js";

export type { AssetManager } from "./assets.js";

// Provider
export { Provider } from "./provider.js";

export type { ProviderConfig } from "./provider.js";

// Runner
export {
  setupLogging,
  createArgumentParser,
  ParentProcessWatcher,
  runProvider,
} from "./runner.js";

export type { ParsedArgs } from "./runner.js";

// Logger
export { LogLevel, setLogLevel, getLogLevel, parseLogLevel, getLogger } from "./logger.js";

export type { Logger } from "./logger.js";

// --- Utilities ---

/**
 * Check if a parameter was explicitly provided in the request.
 *
 * Use this to distinguish between "not provided" (will have default applied)
 * and "explicitly set" (even if set to the default value).
 */
export function wasProvided(params: Record<string, unknown>, key: string): boolean {
  const providedKeys = params._provided_keys;
  if (providedKeys instanceof Set) {
    return providedKeys.has(key);
  }
  return false;
}

export const VERSION = "0.1.0";

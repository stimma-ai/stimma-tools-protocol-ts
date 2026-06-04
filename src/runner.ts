/**
 * Runtime and CLI for STP providers.
 *
 * Handles:
 * - Command-line argument parsing
 * - Logging setup (stderr only)
 * - Parent PID watcher for stdio mode
 * - Graceful shutdown
 */

import { parseArgs } from "node:util";
import { setLogLevel, parseLogLevel, getLogger } from "./logger.js";
import { Provider } from "./provider.js";
import type { ProviderConfig } from "./provider.js";
import type { Transport } from "./transport.js";
import { StdioTransport, WebSocketTransport } from "./transport.js";
import type { AssetManager } from "./assets.js";
import { FilesystemAssetManager } from "./assets.js";
import { getRegistry } from "./tool.js";

const logger = getLogger("stimma_tools.runner");

// --- Logging Setup ---

export function setupLogging(level: string = "INFO"): void {
  setLogLevel(parseLogLevel(level));
}

// --- Parent Process Watcher ---

export class ParentProcessWatcher {
  private _onParentExit: () => void;
  private _parentPid: number;
  private _timer?: ReturnType<typeof setInterval>;

  constructor(onParentExit: () => void) {
    this._onParentExit = onParentExit;
    this._parentPid = process.ppid;
  }

  start(): void {
    this._timer = setInterval(() => {
      try {
        process.kill(this._parentPid, 0);
      } catch {
        logger.warning(
          `Parent process ${this._parentPid} died, shutting down`,
        );
        this.stop();
        this._onParentExit();
      }
    }, 1000);

    // Don't let the timer keep the process alive
    if (this._timer.unref) {
      this._timer.unref();
    }
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }
}

// --- Argument Parser ---

export interface ParsedArgs {
  stdio: boolean;
  websocket: boolean;
  host: string;
  port: number;
  authToken?: string;
  config?: string;
  logLevel: string;
}

export function createArgumentParser(
  _description?: string,
): { parse: (argv?: string[]) => ParsedArgs } {
  return {
    parse(argv?: string[]): ParsedArgs {
      const { values } = parseArgs({
        args: argv ?? process.argv.slice(2),
        options: {
          stdio: { type: "boolean", default: false },
          websocket: { type: "boolean", default: false },
          host: { type: "string", default: "127.0.0.1" },
          port: { type: "string", default: "8765" },
          "auth-token": { type: "string" },
          config: { type: "string", short: "c" },
          "log-level": { type: "string", default: "INFO" },
        },
        strict: true,
      });

      const stdio = values.stdio as boolean;
      const websocket = values.websocket as boolean;

      if (!stdio && !websocket) {
        process.stderr.write(
          "Error: must specify either --stdio or --websocket\n",
        );
        process.exit(1);
      }
      if (stdio && websocket) {
        process.stderr.write(
          "Error: --stdio and --websocket are mutually exclusive\n",
        );
        process.exit(1);
      }

      return {
        stdio,
        websocket,
        host: values.host as string,
        port: parseInt(values.port as string, 10),
        authToken: values["auth-token"] as string | undefined,
        config: values.config as string | undefined,
        logLevel: values["log-level"] as string,
      };
    },
  };
}

// --- Run Provider ---

export async function runProvider(
  provider: Provider,
  args?: ParsedArgs,
  transport?: Transport,
  assetManager?: AssetManager,
): Promise<void> {
  // Set up signal handlers
  const handleSignal = (sig: string) => {
    logger.info(`Received signal ${sig}, exiting...`);
    process.exit(0);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  let parentWatcher: ParentProcessWatcher | undefined;

  try {
    // Set up transport if not provided
    if (transport == null) {
      if (args == null) {
        throw new Error("Either transport or args must be provided");
      }

      if (args.stdio) {
        transport = new StdioTransport();
        parentWatcher = new ParentProcessWatcher(() => {
          logger.info("Parent process died, exiting...");
          process.exit(0);
        });
        parentWatcher.start();
      } else {
        transport = new WebSocketTransport({
          host: args.host,
          port: args.port,
          authToken: args.authToken,
        });
      }
    }

    // Set up asset manager if not provided
    if (assetManager == null && args?.stdio) {
      assetManager = new FilesystemAssetManager();
    }

    // Create a new provider with the transport
    const actualProvider = new Provider({
      config: provider.config,
      transport,
      toolRegistry: getRegistry(),
    });

    await actualProvider.start(assetManager);
    await actualProvider.run();
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") {
      logger.error(`Provider error: ${e}`);
      throw e;
    }
  } finally {
    parentWatcher?.stop();
  }
}

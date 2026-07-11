import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemAssetManager } from "./assets.js";
import { JsonRpcRequest } from "./protocol.js";
import { Provider } from "./provider.js";
import { MemoryTransport } from "./test-helpers.js";
import { Tool, ToolRegistry } from "./tool.js";

async function startProvider(provider: Provider, transport: MemoryTransport, assets: FilesystemAssetManager) {
  const starting = provider.start(assets);
  const registration = await transport.hostReceive("provider.register");
  expect(registration.params).toMatchObject({ stp_version: "1.0", capabilities: { cancel: true } });
  transport.hostRespond(registration, { session_id: "session-1", stp_version: "1.0" });
  await starting;
}

async function hostRequest(
  transport: MemoryTransport,
  method: string,
  id: number,
  params?: Record<string, unknown>,
) {
  transport.pushIncoming(new JsonRpcRequest(method, id, params).toJson());
  while (true) {
    const message = await transport.hostReceive();
    if (message.id === id) return message;
  }
}

describe("provider lifecycle", () => {
  it("lists and executes tools with defaults, progress, and normalized assets", async () => {
    const transport = new MemoryTransport();
    const registry = new ToolRegistry();
    registry.register(new Tool({
      slug: "image",
      displayName: "Image",
      taskTypes: ["text-to-image"],
      parameters: [
        { name: "prompt", type: "string", required: true },
        { name: "steps", type: "integer", default: 4 },
      ],
      execute: async (context, parameters) => {
        expect(parameters.steps).toBe(4);
        expect(parameters._provided_keys).toEqual(new Set(["prompt"]));
        await context.reportProgress(0.5);
        const assetId = await context.assets.upload(Buffer.from("image"), ".png");
        return { asset_id: assetId, seed: 12 };
      },
    }));
    const provider = new Provider({
      config: { providerId: "test", providerName: "Test", maxConcurrent: 1 },
      transport,
      toolRegistry: registry,
    });
    const dir = await mkdtemp(join(tmpdir(), "stp-provider-"));
    await startProvider(provider, transport, new FilesystemAssetManager(dir));

    const listed = await hostRequest(transport, "tools.list", 1);
    expect(((listed.result as { tools: Array<{ id: string }> }).tools)[0].id).toBe("image");
    await expect(hostRequest(transport, "tools.execute", 2, {
      request_id: "job-1", tool_id: "image", parameters: { prompt: "hi" },
    })).resolves.toMatchObject({ result: { accepted: true } });

    const notifications: Record<string, unknown>[] = [];
    while (!notifications.some((message) => message.method === "tools.result")) {
      notifications.push(await transport.hostReceive());
    }
    expect(notifications).toContainEqual(expect.objectContaining({
      method: "tools.progress", params: expect.objectContaining({ progress: 0.5 }),
    }));
    const result = notifications.find((message) => message.method === "tools.result")!.params as Record<string, any>;
    expect(result.output.seed).toBe(12);
    expect(result.output.assets[0].type).toBe("image");

    await provider.stop();
    await expect(transport.hostReceive("provider.disconnect")).resolves.toMatchObject({
      params: { reason: "shutdown" },
    });
  });

  it("keeps capacity-blocked jobs cancellable and cleans up on shutdown", async () => {
    const transport = new MemoryTransport();
    const registry = new ToolRegistry();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    registry.register(new Tool({
      slug: "slow", displayName: "Slow", taskTypes: ["text-to-image"],
      execute: async (context) => {
        markStarted();
        await new Promise<void>((resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return { assets: [] };
      },
    }));
    const provider = new Provider({
      config: { providerId: "test", providerName: "Test", maxConcurrent: 1 },
      transport, toolRegistry: registry,
    });
    const dir = await mkdtemp(join(tmpdir(), "stp-provider-"));
    await startProvider(provider, transport, new FilesystemAssetManager(dir));

    await hostRequest(transport, "tools.execute", 1, { request_id: "running", tool_id: "slow" });
    await started;
    await hostRequest(transport, "tools.execute", 2, { request_id: "queued", tool_id: "slow" });
    await expect(hostRequest(transport, "tools.cancel", 3, { request_id: "queued" }))
      .resolves.toMatchObject({ result: { cancelled: true } });
    await expect(hostRequest(transport, "tools.cancel", 4, { request_id: "running" }))
      .resolves.toMatchObject({ result: { cancelled: true } });

    await expect(transport.hostReceive("tools.result")).resolves.toMatchObject({
      params: { request_id: "running", success: false, error: { code: "CANCELLED" } },
    });
    await provider.stop();
    expect(transport.isRunning).toBe(false);
  });
});

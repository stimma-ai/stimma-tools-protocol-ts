import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { HttpAssetManager, LocalAssetServer } from "./assets.js";
import { WebSocketTransport } from "./transport.js";

async function waitForPort(transport: WebSocketTransport): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (transport.port !== 0) return transport.port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("transport did not bind");
}

function status(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/missing" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("WebSocket and HTTP transport", () => {
  it("enforces auth, moves messages, serves assets, and shuts down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stp-http-assets-"));
    const local = new LocalAssetServer(dir);
    const transport = new WebSocketTransport({ port: 0, authToken: "secret" });
    transport.addRoutes(local.getHttpRoutes("/assets"));
    const starting = transport.start();
    const port = await waitForPort(transport);
    expect(await status(port)).toBe(401);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/stp-v1`, {
      headers: { Authorization: "Bearer secret" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await starting;

    ws.send("host-to-provider");
    const receiver = transport.receive();
    await expect(receiver.next()).resolves.toMatchObject({ value: "host-to-provider" });

    const fromProvider = new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())));
    await transport.send("provider-to-host");
    await expect(fromProvider).resolves.toBe("provider-to-host");

    const remote = new HttpAssetManager({
      baseUrl: `http://127.0.0.1:${port}`,
      assetEndpoint: "/assets",
      authToken: "secret",
    });
    const assetId = await remote.upload(Buffer.from("movie"), ".mp4");
    await expect(remote.exists(assetId)).resolves.toBe(true);
    await expect(remote.download(assetId)).resolves.toEqual(Buffer.from("movie"));
    await expect(remote.delete(assetId)).resolves.toBe(true);

    ws.terminate();
    await transport.stop();
    await receiver.return(undefined);
    expect(transport.isRunning).toBe(false);
    await local.cleanup();
  });
});

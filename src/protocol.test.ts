import { describe, expect, it } from "vitest";
import {
  JsonRpcErrorCode,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  parseMessage,
} from "./protocol.js";
import { MessageHandler } from "./transport.js";
import { MemoryTransport } from "./test-helpers.js";

describe("JSON-RPC conformance", () => {
  it("distinguishes requests, notifications, and responses", () => {
    expect(parseMessage(new JsonRpcRequest("tools.list", 1).toJson())).toBeInstanceOf(JsonRpcRequest);
    expect(parseMessage(new JsonRpcNotification("host.ready").toJson())).toBeInstanceOf(JsonRpcNotification);
    expect(parseMessage(JsonRpcResponse.success(1, {}).toJson())).toBeInstanceOf(JsonRpcResponse);
  });

  it.each(["not json", "[]", '{"jsonrpc":"1.0","method":"x"}'])(
    "rejects invalid message %s",
    (message) => expect(() => parseMessage(message)).toThrow(),
  );

  it("routes requests and emits standard parse errors", async () => {
    const transport = new MemoryTransport();
    await transport.start();
    const handler = new MessageHandler({
      transport,
      onRequest: async (request) => JsonRpcResponse.success(request.id, { method: request.method }),
    });

    await handler.handleMessage(new JsonRpcRequest("tools.list", 7).toJson());
    expect(parseMessage(await transport.takeOutgoing()).toDict()).toEqual({
      jsonrpc: "2.0", id: 7, result: { method: "tools.list" },
    });

    await handler.handleMessage("{");
    const error = parseMessage(await transport.takeOutgoing()) as JsonRpcResponse;
    expect(error.id).toBeNull();
    expect(error.error?.code).toBe(JsonRpcErrorCode.ParseError);
  });

  it("resolves responses and rejects pending calls when closed", async () => {
    const transport = new MemoryTransport();
    await transport.start();
    const handler = new MessageHandler({ transport });

    const pending = handler.sendRequest("provider.register");
    const request = parseMessage(await transport.takeOutgoing()).toDict();
    await handler.handleMessage(JsonRpcResponse.success(request.id as string, { session_id: "s" }).toJson());
    await expect(pending).resolves.toMatchObject({ result: { session_id: "s" } });

    const abandoned = handler.sendRequest("provider.register");
    await transport.takeOutgoing();
    handler.close();
    await expect(abandoned).rejects.toThrow("MessageHandler closed");
  });
});
